#include "net.h"

#include <WiFi.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <esp_wifi.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
#include <string.h>

static const char* kApSsid = "Tremble";
static const char* kApPass = "tremble1";

static DNSServer gDns;
static NetInfo gInfo = {};
static portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;
static char gSsid[33] = {};
static char gPass[65] = {};
static volatile bool gWifiDirty = false;
static uint32_t gBootMs = 0;
static uint32_t gLastJoin = 0;
static bool gStaRunning = false;
static bool gMdns = false;
static int64_t gEpochMs = 0;
static int64_t gEpochMicros = 0;
static bool gTimeSet = false;

static void copyText(char* dst, int n, const char* src) {
  if (!src) src = "";
  strncpy(dst, src, n - 1);
  dst[n - 1] = 0;
}

void netBegin(const char* staSsid, const char* staPass) {
  copyText(gSsid, sizeof(gSsid), staSsid);
  copyText(gPass, sizeof(gPass), staPass);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.setHostname("tremble");
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);
  WiFi.softAP(kApSsid, kApPass, 6, 0, 4);
  esp_wifi_set_ps(WIFI_PS_NONE);
  gDns.start(53, "*", WiFi.softAPIP());
  gBootMs = millis();
  gLastJoin = 0;

  NetInfo info = {};
  copyText(info.apIp, sizeof(info.apIp), WiFi.softAPIP().toString().c_str());
  copyText(info.staSsid, sizeof(info.staSsid), gSsid);
  portENTER_CRITICAL(&gMux);
  gInfo = info;
  portEXIT_CRITICAL(&gMux);

  Serial.printf("Website  http://%s\n", info.apIp);
  Serial.printf("Wi-Fi    %s  /  %s\n", kApSsid, kApPass);
  Serial.println("Recording is started from the website only.");
}

void netSetSta(const char* ssid, const char* pass) {
  copyText(gSsid, sizeof(gSsid), ssid);
  copyText(gPass, sizeof(gPass), pass);
  gWifiDirty = true;
}

void netLoop() {
  gDns.processNextRequest();
  bool clients = WiFi.softAPgetStationNum() > 0;
  if (gWifiDirty) {
    gWifiDirty = false;
    gMdns = false;
    if (gStaRunning) WiFi.disconnect(false, false);
    gStaRunning = false;
    gLastJoin = 0;
    if (!gSsid[0]) WiFi.disconnect(false, false);
  }
  bool needJoin = gSsid[0] && WiFi.status() != WL_CONNECTED && !gStaRunning;
  bool firstTry = gLastJoin == 0 && millis() - gBootMs > 3000;
  bool laterTry = gLastJoin != 0 && !clients && millis() - gLastJoin > 60000;
  if (needJoin && (firstTry || laterTry)) {
    WiFi.begin(gSsid, gPass);
    WiFi.setSleep(false);
    esp_wifi_set_ps(WIFI_PS_NONE);
    if (!clients) WiFi.softAP(kApSsid, kApPass, 6, 0, 4);
    gStaRunning = true;
    gLastJoin = millis();
  } else if (gStaRunning && WiFi.status() != WL_CONNECTED && millis() - gLastJoin > 25000) {
    WiFi.disconnect(false, false);
    WiFi.softAP(kApSsid, kApPass, 6, 0, 4);
    gStaRunning = false;
    gLastJoin = millis();
  }

  if (WiFi.status() == WL_CONNECTED && !gMdns) {
    if (MDNS.begin("tremble")) {
      MDNS.addService("http", "tcp", 80);
      gMdns = true;
    }
  }

  static uint32_t lastCopy = 0;
  if (millis() - lastCopy < 500) return;
  lastCopy = millis();
  NetInfo info = {};
  copyText(info.apIp, sizeof(info.apIp), WiFi.softAPIP().toString().c_str());
  if (WiFi.status() == WL_CONNECTED) {
    info.staConnected = true;
    copyText(info.staIp, sizeof(info.staIp), WiFi.localIP().toString().c_str());
  }
  copyText(info.staSsid, sizeof(info.staSsid), gSsid);
  portENTER_CRITICAL(&gMux);
  gInfo = info;
  portEXIT_CRITICAL(&gMux);
}

void netCopy(NetInfo* out) {
  portENTER_CRITICAL(&gMux);
  *out = gInfo;
  portEXIT_CRITICAL(&gMux);
}

void netSetEpochMs(int64_t epochMs) {
  gEpochMs = epochMs;
  gEpochMicros = esp_timer_get_time();
  gTimeSet = true;
}

uint32_t netEpochNow() {
  if (!gTimeSet) return 0;
  int64_t ms = gEpochMs + (esp_timer_get_time() - gEpochMicros) / 1000;
  if (ms < 0) return 0;
  return (uint32_t)(ms / 1000);
}
