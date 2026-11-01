#include "store.h"

#include "vibe_format.h"

#include <LittleFS.h>
#include <Preferences.h>
#include <stdio.h>
#include <string.h>

static Settings gSettings = {800, 2, 10, 0, "", ""};
static Preferences gPrefs;

static bool allowedRate(uint16_t rate) {
  return rate == 100 || rate == 200 || rate == 400 || rate == 800 || rate == 1600;
}

static bool allowedRange(uint8_t range) {
  return range == 2 || range == 4 || range == 8 || range == 16;
}

Settings* settingsLive() { return &gSettings; }

void settingsLoad() {
  gPrefs.begin("vibecheck", false);
  uint16_t rate = gPrefs.getUShort("rate", 800);
  uint8_t range = gPrefs.getUChar("range", 2);
  uint16_t seconds = gPrefs.getUShort("seconds", 10);
  gSettings.rateHz = allowedRate(rate) ? rate : 800;
  gSettings.rangeG = allowedRange(range) ? range : 2;
  gSettings.seconds = seconds <= 120 ? seconds : 10;
  gSettings.gyro = gPrefs.getUChar("gyro", 0) ? 1 : 0;
  String ssid = gPrefs.getString("ssid", "");
  String pass = gPrefs.getString("pass", "");
  strncpy(gSettings.ssid, ssid.c_str(), sizeof(gSettings.ssid) - 1);
  strncpy(gSettings.pass, pass.c_str(), sizeof(gSettings.pass) - 1);
}

void settingsSaveCapture() {
  gPrefs.putUShort("rate", gSettings.rateHz);
  gPrefs.putUChar("range", gSettings.rangeG);
  gPrefs.putUShort("seconds", gSettings.seconds);
  gPrefs.putUChar("gyro", gSettings.gyro);
}

void settingsSaveWifi() {
  gPrefs.putString("ssid", gSettings.ssid);
  gPrefs.putString("pass", gSettings.pass);
}

bool storeBegin() {
  if (LittleFS.begin(false)) return true;
  if (!LittleFS.format()) return false;
  return LittleFS.begin(true);
}

uint32_t storeUsed() { return (uint32_t)LittleFS.usedBytes(); }
uint32_t storeTotal() { return (uint32_t)LittleFS.totalBytes(); }

void settingsAllocStem(char* out, int outLen) {
  uint32_t seq = gPrefs.getUInt("seq", 1);
  gPrefs.putUInt("seq", seq + 1);
  snprintf(out, outLen, "vibe-%lu", (unsigned long)seq);
}

bool storeExists(const char* stem) {
  char path[40];
  if (!storePath(stem, path, sizeof(path))) return false;
  return LittleFS.exists(path);
}

bool storeValidStem(const char* stem) {
  if (!stem) return false;
  size_t n = strlen(stem);
  if (n < 1 || n > 24) return false;
  for (size_t i = 0; i < n; i++) {
    char c = stem[i];
    bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_';
    if (!ok) return false;
  }
  return true;
}

bool storePath(const char* stem, char* out, int outLen) {
  if (!storeValidStem(stem) || outLen < 40) return false;
  snprintf(out, outLen, "/captures/%s.vibe", stem);
  return true;
}

bool storeSave(const char* stem, const uint8_t* header, const int16_t* samples, uint32_t count) {
  char path[40];
  if (!storePath(stem, path, sizeof(path))) return false;
  if (!LittleFS.exists("/captures")) LittleFS.mkdir("/captures");
  File file = LittleFS.open(path, "w");
  if (!file) return false;
  bool ok = file.write(header, VIBE_HEADER_BYTES) == VIBE_HEADER_BYTES;
  size_t body = (size_t)count * vibeSampleBytes(header);
  const uint8_t* p = (const uint8_t*)samples;
  while (ok && body) {
    size_t chunk = body > 1024 ? 1024 : body;
    size_t n = file.write(p, chunk);
    if (n == 0) {
      ok = false;
      break;
    }
    p += n;
    body -= n;
  }
  file.close();
  if (!ok || body != 0) {
    LittleFS.remove(path);
    return false;
  }
  return true;
}

bool storeDelete(const char* stem) {
  char path[40];
  if (!storePath(stem, path, sizeof(path))) return false;
  return LittleFS.remove(path);
}

int storeList(StoreEntry* out, int max) {
  if (!LittleFS.exists("/captures")) return 0;
  File dir = LittleFS.open("/captures");
  if (!dir || !dir.isDirectory()) return 0;
  int n = 0;
  for (File file = dir.openNextFile(); file && n < max; file = dir.openNextFile()) {
    const char* path = file.name();
    const char* base = path;
    for (const char* p = path; *p; p++) {
      if (*p == '/') base = p + 1;
    }
    size_t len = strlen(base);
    if (len < 6 || strcmp(base + len - 5, ".vibe") != 0) {
      file.close();
      continue;
    }
    size_t stemLen = len - 5;
    if (stemLen >= sizeof(out[n].name)) stemLen = sizeof(out[n].name) - 1;
    memcpy(out[n].name, base, stemLen);
    out[n].name[stemLen] = 0;
    out[n].bytes = (uint32_t)file.size();
    n++;
    file.close();
  }
  dir.close();
  return n;
}
