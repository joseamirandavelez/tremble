#pragma once

// Network snapshot for /api/status and the Stick LCD. Updated from netLoop.

#include <stdint.h>
#include <stdbool.h>

struct NetInfo {
  char apIp[16];
  char staIp[16];
  char staSsid[33];
  bool staConnected;
  bool apOn;
};

void netBegin(const char* staSsid, const char* staPass);
void netLoop();
void netSetSta(const char* ssid, const char* pass);
void netCopy(NetInfo* out);
void netSetEpochMs(int64_t epochMs);
uint32_t netEpochNow();

bool netApOn();
bool netApStart();
void netApStop();
bool netApToggle();
// True when SoftAP is up, STA is connected, or the radio is not WIFI_OFF.
bool netWifiReady();
