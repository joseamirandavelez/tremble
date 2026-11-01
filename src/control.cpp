#include "control.h"

#include "capture.h"
#include "imu.h"
#include "store.h"

#include <stdio.h>
#include <string.h>

bool deviceApply(uint16_t rate, uint8_t range, uint16_t seconds, bool gyro, char* err, size_t errLen) {
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

bool deviceStart(char* err, size_t errLen) {
  if (!imuOk()) {
    snprintf(err, errLen, "The IMU is not ready");
    return false;
  }
  if (!captureStart()) {
    snprintf(err, errLen, "Recorder is busy. Wait for a download to finish.");
    return false;
  }
  return true;
}

void deviceStop() {
  captureStop();
}

void deviceStatus(char* out, size_t outLen) {
  LiveSnap live = {};
  captureCopyLive(&live);
  snprintf(out, outLen,
           "rate %u range %u seconds %u gyro %s recording %s samples %u rss %.4f",
           live.sampleRate, live.rangeG, live.durationSec, live.gyro ? "on" : "off",
           live.recording ? "yes" : "no", live.count, live.rssRms);
}
