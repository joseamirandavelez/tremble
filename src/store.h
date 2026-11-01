#pragma once

#include <stdint.h>

struct Settings {
  uint16_t rateHz;
  uint8_t rangeG;
  uint16_t seconds;
  uint8_t gyro;
  char ssid[33];
  char pass[65];
};

Settings* settingsLive();
void settingsLoad();
void settingsSaveCapture();
void settingsSaveWifi();

bool storeBegin();
uint32_t storeUsed();
uint32_t storeTotal();

// name is the stem, without ".vibe" and without a directory.
bool storeSave(const char* stem, const uint8_t* header, const int16_t* samples, uint32_t count);
bool storeDelete(const char* stem);
bool storeValidStem(const char* stem);
void settingsAllocStem(char* out, int outLen);
bool storeExists(const char* stem);

struct StoreEntry {
  char name[32];
  uint32_t bytes;
};

// Writes up to max entries. Returns the number written.
int storeList(StoreEntry* out, int max);
bool storePath(const char* stem, char* out, int outLen);
