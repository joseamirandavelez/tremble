#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

// Shared by the website, the USB serial port, and Bluetooth.
bool deviceApply(uint16_t rate, uint8_t range, uint16_t seconds, bool gyro, char* err, size_t errLen);
bool deviceStart(char* err, size_t errLen);
void deviceStop();
void deviceStatus(char* out, size_t outLen);
