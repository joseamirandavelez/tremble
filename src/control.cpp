// Recording and IMU settings shared by the website, USB serial, and BLE.
// Heavy imuConfigure work runs on a dedicated task so AsyncTCP does not
// overflow its stack.

#include "control.h"

#include "capture.h"
#include "imu.h"
#include "net.h"
#include "store.h"

#include <WiFi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <stdio.h>
#include <string.h>

struct ApplyJob {
  uint16_t rate;
  uint8_t range;
  uint16_t seconds;
  bool gyro;
  char err[96];
  bool ok;
};

static SemaphoreHandle_t gApplyBusy;
static SemaphoreHandle_t gApplyKick;
static SemaphoreHandle_t gApplyDone;
static ApplyJob gJob;
static TaskHandle_t gApplyTask;

static bool applyNow(uint16_t rate, uint8_t range, uint16_t seconds, bool gyro, char* err, size_t errLen) {
  if (err && errLen) err[0] = 0;
  if (captureBusy()) {
    snprintf(err, errLen, "Stop the recording and wait for a download to finish");
    return false;
  }
  if (seconds > 120) {
    snprintf(err, errLen, "Duration must be 0 to 120 seconds");
    return false;
  }
  float guess = 32768.0f / (float)range;
  if (!captureApply(rate, range, guess, seconds, gyro, gyro ? (32768.0f / 2000.0f) : 0)) {
    snprintf(err, errLen, "Not enough memory for that capture");
    return false;
  }
  if (!imuConfigure(rate, range, gyro)) {
    snprintf(err, errLen, "%s", imuError());
    return false;
  }
  captureApply(rate, range, imuLsbPerG(), seconds, gyro, imuLsbPerDps());
  Settings* settings = settingsLive();
  settings->rateHz = rate;
  settings->rangeG = range;
  settings->seconds = seconds;
  settings->gyro = gyro ? 1 : 0;
  settingsSaveCapture();
  return true;
}

static void applyTask(void*) {
  for (;;) {
    xSemaphoreTake(gApplyKick, portMAX_DELAY);
    gJob.ok = applyNow(gJob.rate, gJob.range, gJob.seconds, gJob.gyro, gJob.err, sizeof(gJob.err));
    xSemaphoreGive(gApplyDone);
  }
}

static void ensureApplyWorker() {
  if (gApplyTask) return;
  gApplyBusy = xSemaphoreCreateMutex();
  gApplyKick = xSemaphoreCreateBinary();
  gApplyDone = xSemaphoreCreateBinary();
  // AsyncTCP's own stack is too small for BMI270 reconfigure + FIFO parse.
  // Keep Apply / USB / BLE settings changes on this worker instead.
  xTaskCreatePinnedToCore(applyTask, "apply", 12288, nullptr, 4, &gApplyTask, 1);
}

bool deviceApply(uint16_t rate, uint8_t range, uint16_t seconds, bool gyro, char* err, size_t errLen) {
  if (err && errLen) err[0] = 0;
  ensureApplyWorker();
  if (xTaskGetCurrentTaskHandle() == gApplyTask) {
    return applyNow(rate, range, seconds, gyro, err, errLen);
  }
  xSemaphoreTake(gApplyBusy, portMAX_DELAY);
  gJob.rate = rate;
  gJob.range = range;
  gJob.seconds = seconds;
  gJob.gyro = gyro;
  gJob.err[0] = 0;
  gJob.ok = false;
  xSemaphoreGive(gApplyKick);
  xSemaphoreTake(gApplyDone, portMAX_DELAY);
  bool ok = gJob.ok;
  if (err && errLen) {
    strncpy(err, gJob.err, errLen - 1);
    err[errLen - 1] = 0;
  }
  xSemaphoreGive(gApplyBusy);
  return ok;
}

bool deviceStart(char* err, size_t errLen) {
  if (!imuOk()) {
    snprintf(err, errLen, "The IMU is not ready");
    return false;
  }
  imuSetPaused(false);
  if (!captureStart()) {
    snprintf(err, errLen, "Recorder is busy. Wait for a download to finish.");
    return false;
  }
  return true;
}

void deviceStop() {
  captureStop();
  // Keep sampling for live charts whenever SoftAP or lab Wi-Fi is up.
  if (!(netApOn() || WiFi.status() == WL_CONNECTED)) imuSetPaused(true);
}

void deviceStatus(char* out, size_t outLen) {
  LiveSnap live = {};
  captureCopyLive(&live);
  snprintf(out, outLen,
           "rate %u range %u seconds %u gyro %s recording %s samples %u rss %.4f",
           live.sampleRate, live.rangeG, live.durationSec, live.gyro ? "on" : "off",
           live.recording ? "yes" : "no", live.count, live.rssRms);
}
