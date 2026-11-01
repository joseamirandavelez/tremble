#include "link.h"

#include "capture.h"
#include "control.h"
#include "net.h"
#include "store.h"

#include <Arduino.h>
#include <stdlib.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <freertos/portmacro.h>
#include <stdio.h>
#include <string.h>

static const char* kService = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char* kRx = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
static const char* kTx = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

static char gLine[96];
static size_t gLineLen = 0;
static char gPending[96];
static volatile bool gHaveCmd = false;
static portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;
static BLECharacteristic* gTx = nullptr;
static volatile bool gBleConnected = false;
static uint32_t gLastNote = 0;
static bool gBleReady = false;

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
  if (gTx && gBleConnected) {
    gTx->setValue((uint8_t*)text, strlen(text));
    gTx->notify();
  }
}

class LinkServer : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { gBleConnected = true; }
  void onDisconnect(BLEServer* server) override {
    gBleConnected = false;
    server->startAdvertising();
  }
};

class LinkRx : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    auto value = characteristic->getValue();
    char line[96];
    size_t n = value.length();
    if (n >= sizeof(line)) n = sizeof(line) - 1;
    for (size_t i = 0; i < n; i++) {
      char c = value[i];
      if (c == '\r' || c == '\n') c = 0;
      line[i] = c;
    }
    line[n] = 0;
    if (line[0]) submit(line);
  }
};

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
    snprintf(out, n, "status | start | stop | rate 100-1600 | range 2|4|8|16 | seconds 0-120 | gyro on|off | wifi <ssid> <pass>");
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
    bool on = !strcmp(line + 5, "on");
    bool off = !strcmp(line + 5, "off");
    if (!on && !off) {
      snprintf(out, n, "gyro on or gyro off");
      return;
    }
    applyCurrent(settings->rateHz, settings->rangeG, settings->seconds, on, out, n);
    return;
  }
  if (!strncmp(line, "wifi ", 5)) {
    const char* rest = line + 5;
    const char* split = strrchr(rest, ' ');
    char ssid[33];
    char pass[65];
    if (!split || split == rest) {
      strncpy(ssid, rest, sizeof(ssid) - 1);
      ssid[sizeof(ssid) - 1] = 0;
      pass[0] = 0;
    } else {
      size_t ssidLen = (size_t)(split - rest);
      if (ssidLen >= sizeof(ssid)) ssidLen = sizeof(ssid) - 1;
      memcpy(ssid, rest, ssidLen);
      ssid[ssidLen] = 0;
      strncpy(pass, split + 1, sizeof(pass) - 1);
      pass[sizeof(pass) - 1] = 0;
    }
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
  Serial.println("USB commands: help, status, start, stop, rate, range, seconds, gyro, wifi");
  BLEDevice::init("Tremble");
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new LinkServer());
  BLEService* service = server->createService(kService);
  gTx = service->createCharacteristic(kTx, BLECharacteristic::PROPERTY_NOTIFY);
  BLECharacteristic* rx = service->createCharacteristic(kRx, BLECharacteristic::PROPERTY_WRITE);
  rx->setCallbacks(new LinkRx());
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kService);
  advertising->setScanResponse(true);
  advertising->start();
  gBleReady = true;
  Serial.println("Bluetooth name Tremble, Nordic UART service");
}

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

  if (gBleReady && gBleConnected && millis() - gLastNote > 1000) {
    gLastNote = millis();
    char out[180];
    deviceStatus(out, sizeof(out));
    if (gTx) {
      gTx->setValue((uint8_t*)out, strlen(out));
      gTx->notify();
    }
  }
}
