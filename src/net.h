#pragma once

#include <stdint.h>

struct NetInfo {
  char apIp[16];
  char staIp[16];
  char staSsid[33];
  bool staConnected;
};

void netBegin(const char* staSsid, const char* staPass);
void netLoop();
void netSetSta(const char* ssid, const char* pass);
void netCopy(NetInfo* out);
void netSetEpochMs(int64_t epochMs);
uint32_t netEpochNow();
