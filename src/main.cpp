// Tremble firmware entry (M5StickS3). Brings up the IMU sampler, optional
// lab Wi-Fi (STA), and the Tremble SoftAP so the phone can open the UI.
// Recording starts only from the website or USB; the face button toggles
// SoftAP without starting a capture.

#include <M5Unified.h>
#include <esp_system.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <stdio.h>

#include "capture.h"
#include "imu.h"
#include "link.h"
#include "net.h"
#include "screen.h"
#include "store.h"
#include "webapp.h"

RTC_NOINIT_ATTR static uint32_t gBoardRetry;

static const char* resetWhy() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int-wdt";
    case ESP_RST_TASK_WDT: return "task-wdt";
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_USB: return "usb";
    default: return "other";
  }
}

// M5GFX autodetect sometimes picks the wrong board on cold boot. Pinning
// StickS3 in NVS avoids a blank panel until the user power-cycles again.
static void lockStickS3BoardHint() {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }
  nvs_handle_t handle;
  if (nvs_open("M5GFX", NVS_READWRITE, &handle) != ESP_OK) return;
  uint32_t board = 0;
  nvs_get_u32(handle, "AUTODETECT", &board);
  const uint32_t stick = (uint32_t)m5::board_t::board_M5StickS3;
  if (board != stick) {
    nvs_set_u32(handle, "AUTODETECT", stick);
    nvs_commit(handle);
    Serial.printf("M5GFX board hint %u -> StickS3 (%u)\n", (unsigned)board, (unsigned)stick);
  }
  nvs_close(handle);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  lockStickS3BoardHint();

  auto cfg = M5.config();
  cfg.fallback_board = m5::board_t::board_M5StickS3;
  cfg.internal_imu = true;
  cfg.internal_mic = false;
  cfg.internal_spk = false;
  M5.begin(cfg);
  M5.Display.setBrightness(160);

  Serial.printf("board %d  display %dx%d  psram %u  reset %s (%d)\n",
                (int)M5.getBoard(), (int)M5.Display.width(), (int)M5.Display.height(),
                (unsigned)ESP.getFreePsram(), resetWhy(), (int)esp_reset_reason());

  if (M5.getBoard() != m5::board_t::board_M5StickS3 || M5.Display.width() < 8) {
    if (esp_reset_reason() == ESP_RST_POWERON) gBoardRetry = 0;
    if (gBoardRetry < 2) {
      gBoardRetry++;
      Serial.printf("StickS3 panel not ready, reboot try %u\n", (unsigned)gBoardRetry);
      lockStickS3BoardHint();
      delay(250);
      esp_restart();
    }
    gBoardRetry = 0;
    Serial.println("StickS3 panel still missing; continuing without the LCD");
  } else {
    gBoardRetry = 0;
  }

  screenBegin();
  char bootLine[48];
  snprintf(bootLine, sizeof(bootLine), "boot %s", resetWhy());
  screenBoot(bootLine);
  delay(300);
  screenBoot("Starting sensor");

  settingsLoad();
  Settings* settings = settingsLive();
  if (!captureBegin()) Serial.println("Capture buffer allocation failed");
  captureApply(settings->rateHz, settings->rangeG, 32768.0f / settings->rangeG, settings->seconds,
               settings->gyro, settings->gyro ? (32768.0f / 2000.0f) : 0);

  if (!imuBegin(settings->rateHz, settings->rangeG, settings->gyro)) {
    Serial.println(imuError());
    if (settings->rateHz != 800 || settings->gyro) {
      screenBoot("Sensor retry 800");
      if (imuBegin(800, settings->rangeG ? settings->rangeG : 2, false)) {
        settings->rateHz = 800;
        settings->gyro = 0;
        settingsSaveCapture();
        captureApply(imuRate(), imuRange(), imuLsbPerG(), settings->seconds, false, 0);
      } else {
        screenBoot(imuError());
      }
    } else {
      screenBoot(imuError());
    }
  } else {
    captureApply(imuRate(), imuRange(), imuLsbPerG(), settings->seconds, imuGyro(), imuLsbPerDps());
  }

  if (!storeBegin()) Serial.println("File storage failed");
  netBegin(settings->ssid, settings->pass);
  // AsyncWebServer panics if begin() runs while Wi-Fi is WIFI_OFF.
  // SoftAP or STA is already up from netBegin when credentials dictate.
  if (netWifiReady()) webEnsureBegun();
  imuStartTask();
  linkBegin();
  Serial.println("Tremble ready");
  screenBoot(settings->ssid[0] ? "SoftAP+WiFi" : "SoftAP on");
}

void loop() {
  M5.update();
  // Face / side button toggles SoftAP (extra AP while on lab Wi-Fi, or
  // SoftAP off for a quiet Stick when no lab network is saved).
  if (M5.BtnA.wasClicked() || M5.BtnB.wasClicked()) {
    bool on;
    if (netApOn()) {
      netApStop();
      on = false;
    } else {
      on = netApStart();
      if (on) webEnsureBegun();
    }
    screenBoot(on ? "SoftAP on" : "SoftAP off");
  }
  netLoop();
  linkLoop();
  if (netWifiReady()) webPowerPoll();
  screenRender();
  delay(captureRecording() ? 100 : 250);
}
