// USB serial text commands (115200). Lines queue in gPending so parsing and
// deviceApply never run inside the Serial ISR path. Mirrors most /api actions:
// start/stop, rate, range, seconds, gyro, wifi, ap on|off.

#include "link.h"

#include "capture.h"
#include "control.h"
#include "net.h"
#include "store.h"
#include "webapp.h"

#include <Arduino.h>
#include <stdlib.h>
#include <freertos/portmacro.h>
#include <stdio.h>
#include <string.h>

static char gLine[96];
static size_t gLineLen = 0;
static char gPending[96];
static volatile bool gHaveCmd = false;
static portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;

static bool submit(const char* line) {
  portENTER_CRITICAL(&gMux);
  if (gHaveCmd) {
    portEXIT_CRITICAL(&gMux);
    return false;
  }
  strncpy(gPending, line, sizeof(gPending) - 1);
  gPending[sizeof(gPending) - 1] = 0;
  gHaveCmd = true;
  portEXIT_CRITICAL(&gMux);
  return true;
}

static void reply(const char* text) {
  Serial.println(text);
}

static bool applyCurrent(uint16_t rate, uint8_t range, uint16_t seconds, bool gyro, char* out, size_t n) {
  char err[96];
  if (!deviceApply(rate, range, seconds, gyro, err, sizeof(err))) {
    snprintf(out, n, "%s", err[0] ? err : "settings rejected");
    return false;
  }
  snprintf(out, n, "ok");
  return true;
}

static void runCommand(const char* line, char* out, size_t n) {
  while (*line == ' ') line++;
  Settings* settings = settingsLive();
  if (!strcmp(line, "help")) {
    snprintf(out, n, "status | start | stop | rate 100-1600 | range 2|4|8|16 | seconds 0-120 | gyro on|off | wifi <ssid> <pass> | ap on|off");
    return;
  }
  if (!strcmp(line, "status")) {
    deviceStatus(out, n);
    return;
  }
  if (!strcmp(line, "start")) {
    char err[96];
    if (!deviceStart(err, sizeof(err))) snprintf(out, n, "%s", err);
    else snprintf(out, n, "recording");
    return;
  }
  if (!strcmp(line, "stop")) {
    deviceStop();
    snprintf(out, n, "stopped %u", captureCount());
    return;
  }
  if (!strcmp(line, "ap on") || !strcmp(line, "ap start")) {
    bool ok = netApStart();
    if (ok) webEnsureBegun();
    snprintf(out, n, ok ? "ap on" : "ap failed");
    return;
  }
  if (!strcmp(line, "ap off") || !strcmp(line, "ap stop")) {
    netApStop();
    snprintf(out, n, netApOn() ? "ap still on" : "ap off");
    return;
  }
  if (!strncmp(line, "rate ", 5)) {
    int rate = atoi(line + 5);
    if (rate != 100 && rate != 200 && rate != 400 && rate != 800 && rate != 1600) {
      snprintf(out, n, "rate must be 100, 200, 400, 800, or 1600");
      return;
    }
    applyCurrent((uint16_t)rate, settings->rangeG, settings->seconds, settings->gyro, out, n);
    return;
  }
  if (!strncmp(line, "range ", 6)) {
    int range = atoi(line + 6);
    if (range != 2 && range != 4 && range != 8 && range != 16) {
      snprintf(out, n, "range must be 2, 4, 8, or 16");
      return;
    }
    applyCurrent(settings->rateHz, (uint8_t)range, settings->seconds, settings->gyro, out, n);
    return;
  }
  if (!strncmp(line, "seconds ", 8)) {
    int seconds = atoi(line + 8);
    if (seconds < 0 || seconds > 120) {
      snprintf(out, n, "seconds must be 0 to 120");
      return;
    }
    applyCurrent(settings->rateHz, settings->rangeG, (uint16_t)seconds, settings->gyro, out, n);
    return;
  }
  if (!strncmp(line, "gyro ", 5)) {
    bool on = !strcmp(line + 5, "on") || !strcmp(line + 5, "1");
    bool off = !strcmp(line + 5, "off") || !strcmp(line + 5, "0");
    if (!on && !off) {
      snprintf(out, n, "gyro on|off");
      return;
    }
    applyCurrent(settings->rateHz, settings->rangeG, settings->seconds, on, out, n);
    return;
  }
  if (!strncmp(line, "wifi ", 5)) {
    char ssid[33] = {};
    char pass[65] = {};
    const char* p = line + 5;
    while (*p == ' ') p++;
    size_t i = 0;
    while (*p && *p != ' ' && i + 1 < sizeof(ssid)) ssid[i++] = *p++;
    while (*p == ' ') p++;
    i = 0;
    while (*p && i + 1 < sizeof(pass)) pass[i++] = *p++;
    if (strchr(ssid, '"') || strchr(ssid, '\\') || strlen(pass) > 64) {
      snprintf(out, n, "network name rejected");
      return;
    }
    if (ssid[0] && pass[0] && strlen(pass) < 8) {
      snprintf(out, n, "Wi-Fi password must be at least 8 characters");
      return;
    }
    strncpy(settings->ssid, ssid, sizeof(settings->ssid) - 1);
    settings->ssid[sizeof(settings->ssid) - 1] = 0;
    strncpy(settings->pass, pass, sizeof(settings->pass) - 1);
    settings->pass[sizeof(settings->pass) - 1] = 0;
    settingsSaveWifi();
    netSetSta(settings->ssid, settings->pass);
    snprintf(out, n, "wifi saved");
    return;
  }
  snprintf(out, n, "unknown command, try help");
}

void linkBegin() {
  Serial.println("USB commands: help, status, start, stop, rate, range, seconds, gyro, wifi, ap");
}

// Drain UART in loop(); execute at most one queued command per pass.
void linkLoop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r' || c == '\n') {
      if (gLineLen) {
        gLine[gLineLen] = 0;
        if (!submit(gLine)) Serial.println("busy");
        gLineLen = 0;
      }
      continue;
    }
    if (gLineLen + 1 < sizeof(gLine)) gLine[gLineLen++] = c;
  }

  char line[96];
  bool have = false;
  portENTER_CRITICAL(&gMux);
  if (gHaveCmd) {
    strncpy(line, gPending, sizeof(line) - 1);
    line[sizeof(line) - 1] = 0;
    gHaveCmd = false;
    have = true;
  }
  portEXIT_CRITICAL(&gMux);
  if (have) {
    char out[180];
    runCommand(line, out, sizeof(out));
    reply(out);
  }
}
