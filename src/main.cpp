#include <M5Unified.h>

#include "capture.h"
#include "imu.h"
#include "link.h"
#include "net.h"
#include "screen.h"
#include "store.h"
#include "webapp.h"

// The Stick buttons are not read. A press would shake the sensor, so
// recording starts and stops only from the onboard website.

void setup() {
  Serial.begin(115200);
  delay(300);

  auto cfg = M5.config();
  cfg.fallback_board = m5::board_t::board_M5StickS3;
  cfg.internal_imu = true;
  cfg.internal_mic = false;
  cfg.internal_spk = false;
  M5.begin(cfg);
  M5.Display.setBrightness(160);

  Serial.printf("board %d  display %dx%d  psram %u\n",
                (int)M5.getBoard(), M5.Display.width(), M5.Display.height(),
                (unsigned)ESP.getFreePsram());

  screenBegin();
  screenBoot("Starting sensor");

  settingsLoad();
  Settings* settings = settingsLive();
  if (!captureBegin()) Serial.println("Capture buffer allocation failed");
  captureApply(settings->rateHz, settings->rangeG, 32768.0f / settings->rangeG, settings->seconds,
               settings->gyro, settings->gyro ? (32768.0f / 2000.0f) : 0);

  if (!imuBegin(settings->rateHz, settings->rangeG, settings->gyro)) {
    Serial.println(imuError());
    screenBoot(imuError());
  } else {
    captureApply(imuRate(), imuRange(), imuLsbPerG(), settings->seconds, imuGyro(), imuLsbPerDps());
  }

  if (!storeBegin()) Serial.println("File storage failed");
  netBegin(settings->ssid, settings->pass);
  webBegin();
  linkBegin();
  imuStartTask();
  Serial.println("Tremble ready");
}

void loop() {
  netLoop();
  linkLoop();
  webPowerPoll();
  screenRender();
  delay(200);
}
