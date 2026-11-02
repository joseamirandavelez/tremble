// Wi-Fi: Tremble SoftAP always available at boot; saved lab credentials join
// STA in AP+STA mode. Captive DNS on 53 sends phones to the UI. IMU pause
// and poll spacing follow radio load so the hotspot stays responsive.

#include "net.h"

#include "capture.h"
#include "imu.h"

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
static bool gApOn = false;
static bool gDnsOn = false;
static bool gStaWasUp = false;
static int64_t gEpochMs = 0;
static int64_t gEpochMicros = 0;
static bool gTimeSet = false;

static void copyText(char* dst, size_t n, const char* src) {
  if (!src) src = "";
  strncpy(dst, src, n - 1);
  dst[n - 1] = 0;
}

static void publishInfo() {
  NetInfo info = {};
  info.apOn = gApOn;
  copyText(info.staSsid, sizeof(info.staSsid), gSsid);
  if (gApOn) {
    copyText(info.apIp, sizeof(info.apIp), WiFi.softAPIP().toString().c_str());
  }
  if (WiFi.status() == WL_CONNECTED) {
    info.staConnected = true;
    copyText(info.staIp, sizeof(info.staIp), WiFi.localIP().toString().c_str());
  }
  portENTER_CRITICAL(&gMux);
  gInfo = info;
  portEXIT_CRITICAL(&gMux);
}

static void stopMdns() {
  if (!gMdns) return;
  MDNS.end();
  gMdns = false;
}

static void startMdns() {
  if (gMdns) return;
  if (!gApOn && WiFi.status() != WL_CONNECTED) return;
  if (!MDNS.begin("tremble")) {
    Serial.println("mDNS begin failed");
    return;
  }
  MDNS.addService("http", "tcp", 80);
  gMdns = true;
  Serial.println("mDNS http://tremble.local");
}

static void stopDns() {
  if (!gDnsOn) return;
  gDns.stop();
  gDnsOn = false;
}

static void startSoftApRadio() {
  bool wantSta = gSsid[0] != 0;
  WiFi.mode(wantSta ? WIFI_AP_STA : WIFI_AP);
  WiFi.setSleep(false);
  WiFi.setHostname("tremble");
  WiFi.softAPsetHostname("tremble");
  WiFi.softAP(kApSsid, kApPass, 6, 0, 2);
  esp_wifi_set_ps(WIFI_PS_NONE);
  stopDns();
  gDns.start(53, "*", WiFi.softAPIP());
  gDnsOn = true;
}

bool netApStart() {
  if (gApOn) return true;
  stopMdns();
  startSoftApRadio();
  gApOn = true;
  gBootMs = millis();
  if (!gSsid[0]) {
    gStaRunning = false;
    gLastJoin = 0;
  }
  startMdns();
  // SoftAP needs samples for live charts. Polling stays slow in the browser.
  if (!captureRecording()) imuSetPaused(false);
  publishInfo();
  Serial.printf("SoftAP on  http://%s  http://tremble.local  %s / %s\n",
                WiFi.softAPIP().toString().c_str(), kApSsid, kApPass);
  return true;
}

void netApStop() {
  if (!gApOn) return;
  // Live UI and download expect AP to stay up for the whole recording.
  if (captureRecording()) {
    Serial.println("SoftAP stays on while recording");
    return;
  }
  stopMdns();
  stopDns();
  WiFi.softAPdisconnect(true);
  gApOn = false;

  if (gSsid[0]) {
    // Keep the lab STA path alive; SoftAP was only an extra radio.
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    esp_wifi_set_ps(WIFI_PS_NONE);
    gStaRunning = false;
    gLastJoin = 0;
    gStaWasUp = false;
    if (!captureRecording()) imuSetPaused(false);
    Serial.println("SoftAP off, staying on lab Wi-Fi");
  } else {
    if (gStaRunning) {
      WiFi.disconnect(false, false);
      gStaRunning = false;
    }
    WiFi.mode(WIFI_OFF);
    imuSetPaused(true);
    Serial.println("SoftAP off");
  }
  publishInfo();
}

bool netApToggle() {
  if (gApOn) {
    netApStop();
    return netApOn();
  }
  return netApStart();
}

bool netApOn() { return gApOn; }

bool netWifiReady() {
  return gApOn || WiFi.status() == WL_CONNECTED || WiFi.getMode() != WIFI_OFF;
}

void netBegin(const char* staSsid, const char* staPass) {
  copyText(gSsid, sizeof(gSsid), staSsid);
  copyText(gPass, sizeof(gPass), staPass);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.setHostname("tremble");
  gDnsOn = false;
  gMdns = false;
  gApOn = false;
  gStaRunning = false;
  gStaWasUp = false;
  gBootMs = millis();
  gLastJoin = 0;

  // SoftAP always answers Tremble / tremble.local. A saved lab network
  // joins in parallel (AP+STA). Windows mDNS alone is too flaky for .local.
  netApStart();
  if (gSsid[0]) {
    Serial.printf("Lab Wi-Fi saved (%s). SoftAP on, joining STA.\n", gSsid);
  } else {
    Serial.println("No lab Wi-Fi saved. SoftAP Tremble / tremble1 is on.");
  }
  Serial.println("Recording is started from the website only.");
}

void netSetSta(const char* ssid, const char* pass) {
  copyText(gSsid, sizeof(gSsid), ssid);
  copyText(gPass, sizeof(gPass), pass);
  gWifiDirty = true;
}

void netLoop() {
  if (WiFi.getMode() == WIFI_OFF && !gApOn) return;

  if (gDnsOn) {
    for (int i = 0; i < 8; i++) gDns.processNextRequest();
  }

  bool clients = gApOn && WiFi.softAPgetStationNum() > 0;
  // SoftAP clients: give Wi-Fi more time between IMU polls.
  imuSetPollMs(gApOn && clients ? 15 : 5);
  if (!captureRecording()) {
    if (gApOn || WiFi.status() == WL_CONNECTED) imuSetPaused(false);
    else imuSetPaused(true);
  }

  if (gWifiDirty) {
    gWifiDirty = false;
    stopMdns();
    if (gStaRunning) WiFi.disconnect(false, false);
    gStaRunning = false;
    gLastJoin = 0;
    gStaWasUp = false;
    gBootMs = millis();
    if (!gApOn) netApStart();
    else {
      startSoftApRadio();
      startMdns();
    }
    if (gSsid[0]) {
      Serial.printf("Lab Wi-Fi update (%s). SoftAP stays on, rejoining STA.\n", gSsid);
    } else {
      Serial.println("Lab Wi-Fi cleared. SoftAP only.");
    }
  }

  if (gSsid[0] && (gApOn || WiFi.getMode() == WIFI_STA || WiFi.getMode() == WIFI_AP_STA)) {
    bool needJoin = WiFi.status() != WL_CONNECTED && !gStaRunning;
    bool firstTry = gLastJoin == 0 && millis() - gBootMs > 800;
    bool laterTry = gLastJoin != 0 && !clients && millis() - gLastJoin > 60000;
    if (needJoin && (firstTry || laterTry)) {
      WiFi.begin(gSsid, gPass);
      WiFi.setSleep(false);
      esp_wifi_set_ps(WIFI_PS_NONE);
      if (gApOn && !clients) WiFi.softAP(kApSsid, kApPass, 6, 0, 2);
      gStaRunning = true;
      gLastJoin = millis();
      Serial.printf("Joining %s...\n", gSsid);
    } else if (gStaRunning && WiFi.status() != WL_CONNECTED && millis() - gLastJoin > 25000) {
      WiFi.disconnect(false, false);
      if (gApOn) WiFi.softAP(kApSsid, kApPass, 6, 0, 2);
      gStaRunning = false;
      gLastJoin = millis();
      Serial.println("Lab Wi-Fi join timed out; will retry");
    }
  }

  bool staUp = WiFi.status() == WL_CONNECTED;
  if (staUp && !gStaWasUp) {
    stopMdns();
    startMdns();
    gStaWasUp = true;
    Serial.printf("STA up  http://%s  http://tremble.local\n",
                  WiFi.localIP().toString().c_str());
  } else if (!staUp) {
    gStaWasUp = false;
  }

  if (!gMdns) startMdns();

  static uint32_t lastCopy = 0;
  if (millis() - lastCopy < 1000) return;
  lastCopy = millis();
  publishInfo();
}

void netCopy(NetInfo* out) {
  portENTER_CRITICAL(&gMux);
  *out = gInfo;
  portEXIT_CRITICAL(&gMux);
}

// Browser POST /api/time sets wall clock for capture epoch in the VIBE header.
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
