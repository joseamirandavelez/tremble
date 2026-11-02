#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

// High-level record/settings API. Shared by the website, USB serial, and BLE.
bool deviceApply(uint16_t rate, uint8_t range, uint16_t seconds, bool gyro, char* err, size_t errLen);
bool deviceStart(char* err, size_t errLen);
void deviceStop();
void deviceStatus(char* out, size_t outLen);
