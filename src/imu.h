#pragma once

#include <stdint.h>
#include <stdbool.h>

// I2C bus shared by the BMI270 and the StickS3 power chip.
// Never take this lock while holding the live-data lock.
void busLock();
void busUnlock();

bool imuBegin(uint32_t rateHz, uint8_t rangeG, bool gyro);
bool imuConfigure(uint32_t rateHz, uint8_t rangeG, bool gyro);
void imuFlushLocked();
void imuService();
void imuStartTask();

bool imuOk();
const char* imuError();
float imuLsbPerG();
float imuLsbPerDps();
bool imuGyro();
uint32_t imuRate();
uint8_t imuRange();
