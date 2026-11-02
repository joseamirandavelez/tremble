// BMI270 on the Stick internal I2C bus. Samples arrive through the chip FIFO;
// a FreeRTOS task on core 0 drains it while Wi-Fi runs. Paused when both
// SoftAP and STA are down so the bus sleeps with the radio.

#include "imu.h"

#include "capture.h"

#include <M5Unified.h>
#include <math.h>
#include <string.h>
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

static constexpr uint8_t REG_CHIP_ID = 0x00;
static constexpr uint8_t REG_ACC_CONF = 0x40;
static constexpr uint8_t REG_ACC_RANGE = 0x41;
static constexpr uint8_t REG_GYR_CONF = 0x42;
static constexpr uint8_t REG_GYR_RANGE = 0x43;
static constexpr uint8_t REG_FIFO_DOWNS = 0x45;
static constexpr uint8_t REG_FIFO_CONFIG_0 = 0x48;
static constexpr uint8_t REG_FIFO_LENGTH = 0x24;
static constexpr uint8_t REG_FIFO_DATA = 0x26;
static constexpr uint8_t REG_PWR_CONF = 0x7C;
static constexpr uint8_t REG_PWR_CTRL = 0x7D;
static constexpr uint8_t REG_CMD = 0x7E;
static constexpr uint8_t REG_INTERNAL_STATUS = 0x21;
static constexpr uint8_t REG_IF_CONF = 0x6B;
static constexpr uint8_t CMD_FIFO_FLUSH = 0xB0;
static constexpr uint8_t CHIP_ID = 0x24;
static constexpr uint32_t I2C_HZ = 400000;

static SemaphoreHandle_t gBus;
static uint8_t gAddr = 0;
static bool gOk = false;
static char gError[72] = "IMU not started";
static float gLsb = 16384.0f;
static float gLsbDps = 0;
static bool gGyro = false;
static uint32_t gRate = 800;
static uint8_t gRange = 2;
static uint8_t gPending[24];
static size_t gPendingLen = 0;
static uint32_t gLastDataMs = 0;
static std::atomic<bool> gPaused{false};

static void setError(const char* msg) {
  strncpy(gError, msg, sizeof(gError) - 1);
  gError[sizeof(gError) - 1] = 0;
  gOk = false;
}

void busLock() {
  if (gBus) xSemaphoreTake(gBus, portMAX_DELAY);
}

void busUnlock() {
  if (gBus) xSemaphoreGive(gBus);
}

static bool write8(uint8_t reg, uint8_t value) {
  return M5.In_I2C.writeRegister8(gAddr, reg, value, I2C_HZ);
}

static uint8_t read8(uint8_t reg) {
  return M5.In_I2C.readRegister8(gAddr, reg, I2C_HZ);
}

static bool readN(uint8_t reg, uint8_t* dst, size_t len) {
  return M5.In_I2C.readRegister(gAddr, reg, dst, len, I2C_HZ);
}

static bool probe() {
  const uint8_t addrs[] = {0x68, 0x69};
  for (uint8_t addr : addrs) {
    gAddr = addr;
    if (read8(REG_CHIP_ID) == CHIP_ID) return true;
  }
  gAddr = 0;
  return false;
}

static uint8_t odrCode(uint32_t rate) {
  switch (rate) {
    case 100: return 0x08;
    case 200: return 0x09;
    case 400: return 0x0A;
    case 800: return 0x0B;
    case 1600: return 0x0C;
    default: return 0;
  }
}

static float lsbForRange(uint8_t rangeG) {
  return 32768.0f / (float)rangeG;
}

static uint8_t frameLength(uint8_t header) {
  switch (header) {
    case 0x84: return 7;   // accel
    case 0x88: return 7;   // gyro
    case 0x8C: return 13;  // gyro + accel
    case 0x90: return 9;   // aux
    case 0x94: return 15;  // aux + accel
    case 0x98: return 15;  // aux + gyro
    case 0x9C: return 21;  // all
    case 0x40: return 2;   // skip
    case 0x44: return 4;   // sensor time
    case 0x48: return 5;   // config
    default: return 0;
  }
}

static int16_t s16(const uint8_t* p) {
  return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static void takePair(const uint8_t* accel, const uint8_t* gyro) {
  int16_t gx = 0;
  int16_t gy = 0;
  int16_t gz = 0;
  if (gyro) {
    gx = s16(gyro);
    gy = s16(gyro + 2);
    gz = s16(gyro + 4);
  }
  gLastDataMs = millis();
  capturePush(s16(accel), s16(accel + 2), s16(accel + 4), gx, gy, gz);
}

static void parseBytes(const uint8_t* in, size_t n) {
  uint8_t tmp[240];
  if (gPendingLen + n > sizeof(tmp)) {
    gPendingLen = 0;
    captureAddGaps(1);
    return;
  }
  memcpy(tmp, gPending, gPendingLen);
  memcpy(tmp + gPendingLen, in, n);
  size_t total = gPendingLen + n;
  size_t i = 0;
  while (i < total) {
    uint8_t header = tmp[i];
    if (header == 0x80) {
      i = total;
      break;
    }
    uint8_t need = frameLength(header);
    if (need == 0) {
      i++;
      continue;
    }
    if (i + need > total) break;
    const uint8_t* frame = tmp + i;
    if (header == 0x84) {
      takePair(frame + 1, nullptr);
    } else if (header == 0x8C) {
      takePair(frame + 7, frame + 1);
    } else if (header == 0x94) {
      takePair(frame + 9, nullptr);
    } else if (header == 0x9C) {
      takePair(frame + 15, frame + 9);
    } else if (header == 0x40) {
      captureAddGaps(frame[1]);
    }
    i += need;
  }
  gPendingLen = total - i;
  if (gPendingLen > sizeof(gPending)) gPendingLen = 0;
  else if (gPendingLen) memcpy(gPending, tmp + i, gPendingLen);
}

static uint16_t fifoLength() {
  uint8_t raw[2] = {0, 0};
  if (!readN(REG_FIFO_LENGTH, raw, 2)) return 0;
  return (uint16_t)(raw[0] | ((raw[1] & 0x3F) << 8));
}

static void drainLocked() {
  uint16_t avail = fifoLength();
  if (avail > 1800) captureAddGaps(1);
  uint8_t raw[180];
  // Cap work per call so a busy FIFO cannot starve setup/loop on core 1.
  int bursts = 0;
  while (avail >= 7 && bursts < 8) {
    uint16_t n = avail > sizeof(raw) ? sizeof(raw) : avail;
    if (!readN(REG_FIFO_DATA, raw, n)) break;
    parseBytes(raw, n);
    avail = (avail > n) ? (avail - n) : 0;
    if (avail < 7) avail = fifoLength();
    bursts++;
  }
  if (gOk && gLastDataMs != 0 && millis() - gLastDataMs > 3000) {
    setError("IMU stopped producing samples");
  }
}

void imuFlushLocked() {
  gPendingLen = 0;
  write8(REG_CMD, CMD_FIFO_FLUSH);
}

static void flushFifo() {
  // Never sleep while holding the I2C mutex. The IMU task and Power reads
  // share it; a delay under the lock starved Wi-Fi at 1600 Hz.
  busLock();
  imuFlushLocked();
  busUnlock();
  vTaskDelay(pdMS_TO_TICKS(5));
  busLock();
  uint8_t dump[64];
  uint16_t avail = fifoLength();
  if (avail > sizeof(dump)) avail = sizeof(dump);
  if (avail) readN(REG_FIFO_DATA, dump, avail);
  gPendingLen = 0;
  busUnlock();
}

bool imuConfigure(uint32_t rateHz, uint8_t rangeG, bool gyro) {
  uint8_t odr = odrCode(rateHz);
  if (!odr || (rangeG != 2 && rangeG != 4 && rangeG != 8 && rangeG != 16)) {
    setError("Unsupported rate or range");
    return false;
  }

  busLock();
  if (!probe()) {
    busUnlock();
    setError("BMI270 not found");
    return false;
  }
  if (gOk && gRate == rateHz && gRange == rangeG && gGyro == gyro) {
    busUnlock();
    return true;
  }
  busUnlock();

  // Pause the sampler so reconfigure is the only I2C client for a moment.
  gPaused.store(true);
  vTaskDelay(pdMS_TO_TICKS(15));
  captureHold(500);

  busLock();
  write8(REG_PWR_CONF, 0x00);
  busUnlock();
  vTaskDelay(pdMS_TO_TICKS(5));

  busLock();
  write8(REG_IF_CONF, 0x00);
  write8(REG_PWR_CTRL, gyro ? 0x06 : 0x04);
  busUnlock();
  vTaskDelay(pdMS_TO_TICKS(50));

  busLock();
  // Performance mode (bit7) is required above 400 Hz on BMI270.
  uint8_t conf = (uint8_t)(0x80 | (0x02 << 4) | odr);
  uint8_t rangeReg = (uint8_t)(rangeG == 2 ? 0 : rangeG == 4 ? 1 : rangeG == 8 ? 2 : 3);
  write8(REG_ACC_CONF, conf);
  write8(REG_ACC_RANGE, rangeReg);
  if (gyro) {
    write8(REG_GYR_CONF, conf);
    write8(REG_GYR_RANGE, 0x00);
  }
  write8(REG_FIFO_DOWNS, 0x00);
  uint8_t fifoCfg[2] = {0x00, (uint8_t)(gyro ? 0xD0 : 0x50)};
  M5.In_I2C.writeRegister(gAddr, REG_FIFO_CONFIG_0, fifoCfg, 2, I2C_HZ);
  uint8_t readback = read8(REG_ACC_CONF);
  gRate = rateHz;
  gRange = rangeG;
  gLsb = lsbForRange(rangeG);
  gGyro = gyro;
  gLsbDps = gyro ? (32768.0f / 2000.0f) : 0.0f;
  gLastDataMs = millis();
  gOk = true;
  gError[0] = 0;
  busUnlock();

  flushFifo();
  captureHold(400);
  gPaused.store(false);

  Serial.printf("BMI270 @ 0x%02X  %u Hz  ±%u g  ACC_CONF %02X\n", gAddr, gRate, gRange, readback);
  if ((readback & 0x0F) != odr) {
    Serial.printf("ACC_CONF wrote %02X read %02X\n", conf, readback);
    setError("Accelerometer did not accept the sample rate");
    return false;
  }
  return true;
}

bool imuBegin(uint32_t rateHz, uint8_t rangeG, bool gyro) {
  if (!gBus) gBus = xSemaphoreCreateMutex();
  uint8_t status = 0;
  if (probe()) status = read8(REG_INTERNAL_STATUS);
  Serial.printf("BMI270 init status 0x%02X\n", status);
  return imuConfigure(rateHz, rangeG, gyro);
}

void imuService() {
  if (!gAddr || gPaused.load()) return;
  busLock();
  if (gOk) drainLocked();
  busUnlock();
}

static std::atomic<uint32_t> gPollMs{5};

void imuSetPollMs(uint32_t ms) {
  if (ms < 5) ms = 5;
  if (ms > 40) ms = 40;
  gPollMs.store(ms);
}

static void imuTask(void*) {
  for (;;) {
    imuService();
    // Default 5 ms. SoftAP with a phone attached uses a longer gap.
    vTaskDelay(pdMS_TO_TICKS(gPollMs.load()));
  }
}

void imuStartTask() {
  // Core 0 keeps Wi-Fi moving. Priority stays below the Wi-Fi task.
  xTaskCreatePinnedToCore(imuTask, "imu", 8192, nullptr, 1, nullptr, 0);
}

void imuSetPaused(bool paused) {
  gPaused.store(paused);
}

bool imuPaused() {
  return gPaused.load();
}

bool imuOk() { return gOk; }
const char* imuError() { return gError; }
float imuLsbPerG() { return gLsb; }
float imuLsbPerDps() { return gLsbDps; }
bool imuGyro() { return gGyro; }
uint32_t imuRate() { return gRate; }
uint8_t imuRange() { return gRange; }
