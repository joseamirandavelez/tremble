#pragma once

#include <stdint.h>
#include <stdbool.h>

// BMI270 driver and shared I2C mutex. The IMU task calls imuService(); net
// adjusts imuSetPaused / imuSetPollMs for SoftAP load.

// I2C bus shared by the BMI270 and the StickS3 power chip.
// Never take this lock while holding the live-data lock.
void busLock();
void busUnlock();

bool imuBegin(uint32_t rateHz, uint8_t rangeG, bool gyro);
bool imuConfigure(uint32_t rateHz, uint8_t rangeG, bool gyro);
void imuFlushLocked();
void imuService();
void imuStartTask();
void imuSetPaused(bool paused);
bool imuPaused();
// SoftAP needs a longer poll so Wi-Fi keeps the hotspot alive.
void imuSetPollMs(uint32_t ms);

bool imuOk();
const char* imuError();
float imuLsbPerG();
float imuLsbPerDps();
bool imuGyro();
uint32_t imuRate();
uint8_t imuRange();
