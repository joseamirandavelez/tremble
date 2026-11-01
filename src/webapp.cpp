#include "webapp.h"

#include "assets.h"
#include "capture.h"
#include "control.h"
#include "imu.h"
#include "net.h"
#include "store.h"
#include "vibe_format.h"

#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <M5Unified.h>
#include <memory>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static volatile int gBattLevel = -1;
static volatile int gBattMv = -1;
static volatile int gCharging = -1;
static uint32_t gStorageUsed = 0;

void webPowerPoll() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (last && (uint32_t)(now - last) < 2000) return;
  last = now;
  gStorageUsed = storeUsed();
  busLock();
  int mv = M5.Power.getBatteryVoltage();
  int level = M5.Power.getBatteryLevel();
  auto charge = M5.Power.isCharging();
  busUnlock();
  gBattMv = mv;
  gBattLevel = level;
  gCharging = charge == m5::Power_Class::is_charging ? 1
            : charge == m5::Power_Class::charge_unknown ? -1
            : 0;
}

static AsyncWebServer gServer(80);

static const char* kApSsid = "Tremble";
static const char* kApPass = "tremble1";

struct SendState {
  uint32_t samples;
  uint8_t header[64];
};

static String field(AsyncWebServerRequest* req, const char* name) {
  if (req->hasParam(name, true)) return req->getParam(name, true)->value();
  if (req->hasParam(name)) return req->getParam(name)->value();
  return "";
}

static void sendJson(AsyncWebServerRequest* req, int code, const String& body) {
  AsyncWebServerResponse* res = req->beginResponse(code, "application/json", body);
  res->addHeader("Cache-Control", "no-store");
  req->send(res);
}

static void sendText(AsyncWebServerRequest* req, int code, const char* body) {
  AsyncWebServerResponse* res = req->beginResponse(code, "application/json", body);
  res->addHeader("Cache-Control", "no-store");
  req->send(res);
}

static bool parseRate(const String& text, uint16_t* out) {
  int value = text.toInt();
  if (value == 100 || value == 200 || value == 400 || value == 800 || value == 1600) {
    *out = (uint16_t)value;
    return true;
  }
  return false;
}

static bool parseRange(const String& text, uint8_t* out) {
  int value = text.toInt();
  if (value == 2 || value == 4 || value == 8 || value == 16) {
    *out = (uint8_t)value;
    return true;
  }
  return false;
}

static void handleStatus(AsyncWebServerRequest* req) {
  LiveSnap live = {};
  captureCopyLive(&live);
  NetInfo net = {};
  netCopy(&net);
  Settings* settings = settingsLive();
  char buf[1800];
  const char* charging = gCharging > 0 ? "true" : (gCharging < 0 ? "null" : "false");
  snprintf(
      buf, sizeof(buf),
      "{\"ok\":true,\"imu\":%s,\"error\":\"%s\",\"recording\":%s,\"captureReady\":%s,"
      "\"sampleRate\":%u,\"rangeG\":%u,\"durationSec\":%u,\"samples\":%u,\"target\":%u,"
      "\"capacity\":%u,\"gaps\":%u,\"truncated\":%s,\"elapsedMs\":%u,"
      "\"rssRms\":%.5f,\"peakRss\":%.5f,\"rms\":[%.5f,%.5f,%.5f],"
      "\"gyro\":%s,\"gyroRms\":[%.4f,%.4f,%.4f],"
      "\"links\":[\"wifi\",\"usb\",\"ble\"],"
      "\"apSsid\":\"%s\",\"apPass\":\"%s\",\"apIp\":\"%s\",\"staIp\":\"%s\","
      "\"staSsid\":\"%s\",\"staConnected\":%s,\"storageUsed\":%u,\"storageTotal\":%u,"
      "\"psram\":%u,\"lsbPerG\":%.1f,\"battery\":%d,\"batteryMv\":%d,\"charging\":%s}",
      imuOk() ? "true" : "false",
      imuOk() ? "" : imuError(),
      live.recording ? "true" : "false",
      live.captureReady ? "true" : "false",
      live.sampleRate, live.rangeG, settings->seconds, live.count, live.target,
      live.capacity, live.gaps, live.truncated ? "true" : "false", live.elapsedMs,
      live.rssRms, live.peakRss, live.rms[0], live.rms[1], live.rms[2],
      live.gyro ? "true" : "false", live.gyroRms[0], live.gyroRms[1], live.gyroRms[2],
      kApSsid, kApPass, net.apIp, net.staIp, net.staSsid,
      net.staConnected ? "true" : "false",
      gStorageUsed, storeTotal(), (unsigned)ESP.getFreePsram(), live.lsbPerG,
      (int)gBattLevel, (int)gBattMv, charging);
  sendText(req, 200, buf);
}

static void handleLive(AsyncWebServerRequest* req) {
  constexpr uint16_t kMax = 300;
  struct Packet {
    float dt;
    uint16_t count;
    uint16_t pad;
    float xyz[kMax * 3];
  };
  auto packet = std::make_shared<Packet>();
  packet->pad = 0;
  packet->count = captureCopyWave(packet->xyz, kMax, &packet->dt);
  size_t bytes = 8u + (size_t)packet->count * 12u;
  AsyncWebServerResponse* res = req->beginResponse(
      "application/octet-stream", bytes,
      [packet, bytes](uint8_t* buffer, size_t maxLen, size_t index) -> size_t {
        if (index >= bytes) return 0;
        size_t n = bytes - index;
        if (n > maxLen) n = maxLen;
        memcpy(buffer, ((const uint8_t*)packet.get()) + index, n);
        return n;
      });
  res->addHeader("Cache-Control", "no-store");
  req->send(res);
}

static void handleLiveFft(AsyncWebServerRequest* req) {
  struct Packet {
    uint32_t rate;
    float lsb;
    uint16_t count;
    uint16_t pad;
    int16_t samples[512 * 3];
  };
  auto packet = std::make_shared<Packet>();
  packet->pad = 0;
  packet->count = captureCopyRecent(packet->samples, 512, &packet->rate, &packet->lsb);
  size_t bytes = 12u + (size_t)packet->count * 6u;
  AsyncWebServerResponse* res = req->beginResponse(
      "application/octet-stream", bytes,
      [packet, bytes](uint8_t* buffer, size_t maxLen, size_t index) -> size_t {
        if (index >= bytes) return 0;
        size_t n = bytes - index;
        if (n > maxLen) n = maxLen;
        memcpy(buffer, ((const uint8_t*)packet.get()) + index, n);
        return n;
      });
  res->addHeader("Cache-Control", "no-store");
  req->send(res);
}

static void handleSettings(AsyncWebServerRequest* req) {
  uint16_t rate = 0;
  uint8_t range = 0;
  if (!parseRate(field(req, "rate"), &rate) || !parseRange(field(req, "range"), &range)) {
    sendText(req, 400, "{\"ok\":false,\"error\":\"Choose a supported rate and range\"}");
    return;
  }
  int seconds = field(req, "seconds").toInt();
  if (seconds < 0) seconds = 0;
  bool gyro = field(req, "gyro") == "1" || field(req, "gyro") == "on";
  char err[96];
  if (!deviceApply(rate, range, (uint16_t)seconds, gyro, err, sizeof(err))) {
    String body = String("{\"ok\":false,\"error\":\"") + err + "\"}";
    sendJson(req, 409, body);
    return;
  }
  sendText(req, 200, "{\"ok\":true}");
}

static void handleRecord(AsyncWebServerRequest* req) {
  String action = field(req, "action");
  if (action == "start") {
    char err[96];
    if (!deviceStart(err, sizeof(err))) {
      String body = String("{\"ok\":false,\"error\":\"") + err + "\"}";
      sendJson(req, 409, body);
      return;
    }
    sendText(req, 200, "{\"ok\":true,\"recording\":true}");
    return;
  }
  if (action == "stop") {
    deviceStop();
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"ok\":true,\"recording\":false,\"samples\":%u}", captureCount());
    sendText(req, 200, buf);
    return;
  }
  sendText(req, 400, "{\"ok\":false,\"error\":\"Unknown action\"}");
}

static void handleWifi(AsyncWebServerRequest* req) {
  String ssid = field(req, "ssid");
  String pass = field(req, "pass");
  if (ssid.length() > 32 || pass.length() > 64 || ssid.indexOf('"') >= 0 || ssid.indexOf('\\') >= 0) {
    sendText(req, 400, "{\"ok\":false,\"error\":\"Network name or password is too long\"}");
    return;
  }
  if (ssid.length() && pass.length() > 0 && pass.length() < 8) {
    sendText(req, 400, "{\"ok\":false,\"error\":\"Wi-Fi password must be at least 8 characters\"}");
    return;
  }
  Settings* settings = settingsLive();
  strncpy(settings->ssid, ssid.c_str(), sizeof(settings->ssid) - 1);
  settings->ssid[sizeof(settings->ssid) - 1] = 0;
  strncpy(settings->pass, pass.c_str(), sizeof(settings->pass) - 1);
  settings->pass[sizeof(settings->pass) - 1] = 0;
  settingsSaveWifi();
  netSetSta(settings->ssid, settings->pass);
  sendText(req, 200, "{\"ok\":true}");
}

static void handleTime(AsyncWebServerRequest* req) {
  String epoch = field(req, "epoch");
  if (!epoch.length()) {
    sendText(req, 400, "{\"ok\":false}");
    return;
  }
  netSetEpochMs(strtoll(epoch.c_str(), nullptr, 10));
  sendText(req, 200, "{\"ok\":true}");
}

static void handleCapture(AsyncWebServerRequest* req) {
  auto* state = new SendState();
  if (!captureTryBeginSend(&state->samples, state->header)) {
    delete state;
    sendText(req, 404, "{\"ok\":false,\"error\":\"No finished capture. Stop a recording first.\"}");
    return;
  }
  uint32_t width = vibeSampleBytes(state->header);
  size_t total = 64u + (size_t)state->samples * width;
  const int16_t* samples = captureSamples();
  AsyncWebServerResponse* res = req->beginResponse(
      "application/octet-stream", total,
      [state, samples, width](uint8_t* buffer, size_t maxLen, size_t index) -> size_t {
        size_t end = 64u + (size_t)state->samples * width;
        if (index >= end) return 0;
        size_t produced = 0;
        while (produced < maxLen) {
          size_t pos = index + produced;
          if (pos >= end) break;
          if (pos < 64) {
            size_t n = 64 - pos;
            if (n > maxLen - produced) n = maxLen - produced;
            memcpy(buffer + produced, state->header + pos, n);
            produced += n;
          } else {
            size_t n = end - pos;
            if (n > maxLen - produced) n = maxLen - produced;
            memcpy(buffer + produced, ((const uint8_t*)samples) + (pos - 64), n);
            produced += n;
          }
        }
        return produced;
      });
  res->addHeader("Content-Disposition", "attachment; filename=capture.vibe");
  res->addHeader("Cache-Control", "no-store");
  req->onDisconnect([state]() {
    captureEndSend();
    delete state;
  });
  req->send(res);
}

static void handleFiles(AsyncWebServerRequest* req) {
  StoreEntry entries[24];
  int n = storeList(entries, 24);
  String body = "{\"files\":[";
  for (int i = 0; i < n; i++) {
    if (i) body += ',';
    body += "{\"name\":\"";
    body += entries[i].name;
    body += "\",\"bytes\":";
    body += String(entries[i].bytes);
    body += '}';
  }
  body += "],\"used\":";
  body += String(storeUsed());
  body += ",\"total\":";
  body += String(storeTotal());
  body += '}';
  sendJson(req, 200, body);
}

static void handleSave(AsyncWebServerRequest* req) {
  if (captureRecording() || !captureReady()) {
    sendText(req, 409, "{\"ok\":false,\"error\":\"Finish a capture before saving it\"}");
    return;
  }
  String stem = field(req, "name");
  if (!stem.length()) {
    char autoName[24];
    settingsAllocStem(autoName, sizeof(autoName));
    stem = autoName;
  }
  if (!storeValidStem(stem.c_str())) {
    sendText(req, 400, "{\"ok\":false,\"error\":\"Use letters, numbers, dash, or underscore (24 max)\"}");
    return;
  }
  uint8_t header[64];
  uint32_t count = 0;
  if (!captureTryBeginSend(&count, header)) {
    sendText(req, 409, "{\"ok\":false,\"error\":\"Capture is busy\"}");
    return;
  }
  bool ok = storeSave(stem.c_str(), header, captureSamples(), count);
  captureEndSend();
  if (!ok) {
    sendText(req, 507, "{\"ok\":false,\"error\":\"Not enough flash space\"}");
    return;
  }
  String body = String("{\"ok\":true,\"name\":\"") + stem + "\"}";
  sendJson(req, 200, body);
}

static void handleDelete(AsyncWebServerRequest* req) {
  String stem = field(req, "name");
  if (!storeDelete(stem.c_str())) {
    sendText(req, 404, "{\"ok\":false,\"error\":\"File not found\"}");
    return;
  }
  sendText(req, 200, "{\"ok\":true}");
}

static void handleGetFile(AsyncWebServerRequest* req) {
  String stem = field(req, "name");
  char path[40];
  if (!storeExists(stem.c_str()) || !storePath(stem.c_str(), path, sizeof(path))) {
    sendText(req, 404, "{\"ok\":false,\"error\":\"File not found\"}");
    return;
  }
  req->send(LittleFS, path, "application/octet-stream", true);
}

static void redirectHome(AsyncWebServerRequest* req) {
  req->redirect("http://192.168.4.1/");
}

void webBegin() {
  gServer.on("/", HTTP_GET, [](AsyncWebServerRequest* req) { sendAsset(req, "/"); });
  gServer.on("/app.css", HTTP_GET, [](AsyncWebServerRequest* req) { sendAsset(req, "/app.css"); });
  gServer.on("/app.js", HTTP_GET, [](AsyncWebServerRequest* req) { sendAsset(req, "/app.js"); });
  gServer.on("/dsp.js", HTTP_GET, [](AsyncWebServerRequest* req) { sendAsset(req, "/dsp.js"); });
  gServer.on("/icon.svg", HTTP_GET, [](AsyncWebServerRequest* req) { sendAsset(req, "/icon.svg"); });
  gServer.on("/logo.svg", HTTP_GET, [](AsyncWebServerRequest* req) { sendAsset(req, "/logo.svg"); });
  gServer.on("/logo-text.svg", HTTP_GET, [](AsyncWebServerRequest* req) { sendAsset(req, "/logo-text.svg"); });
  gServer.on("/api/status", HTTP_GET, handleStatus);
  gServer.on("/api/live", HTTP_GET, handleLive);
  gServer.on("/api/livefft", HTTP_GET, handleLiveFft);
  gServer.on("/api/settings", HTTP_POST, handleSettings);
  gServer.on("/api/record", HTTP_POST, handleRecord);
  gServer.on("/api/wifi", HTTP_POST, handleWifi);
  gServer.on("/api/time", HTTP_POST, handleTime);
  gServer.on("/api/capture.vibe", HTTP_GET, handleCapture);
  gServer.on("/api/files", HTTP_GET, handleFiles);
  gServer.on("/api/files/save", HTTP_POST, handleSave);
  gServer.on("/api/files/delete", HTTP_POST, handleDelete);
  gServer.on("/api/files/get", HTTP_GET, handleGetFile);
  gServer.on("/generate_204", HTTP_GET, redirectHome);
  gServer.on("/gen_204", HTTP_GET, redirectHome);
  gServer.on("/hotspot-detect.html", HTTP_GET, redirectHome);
  gServer.on("/connecttest.txt", HTTP_GET, redirectHome);
  gServer.on("/ncsi.txt", HTTP_GET, redirectHome);
  gServer.on("/favicon.ico", HTTP_GET, [](AsyncWebServerRequest* req) { req->send(204); });
  gServer.onNotFound([](AsyncWebServerRequest* req) {
    if (req->url().startsWith("/api/")) sendText(req, 404, "{\"ok\":false,\"error\":\"Not found\"}");
    else redirectHome(req);
  });
  gServer.begin();
  Serial.println("Web server ready");
}
