// Stick LCD: boot lines during setup, then a small state machine (recording,
// SoftAP, STA up, joining, Wi-Fi off, no sensor). Redraws only when the
// logical picture changes so the panel does not flicker every loop.

#include "screen.h"

#include "capture.h"
#include "imu.h"
#include "net.h"

#include <M5Unified.h>
#include <stdio.h>
#include <string.h>

static M5Canvas gCanvas(&M5.Display);
static bool gSprite = false;
static char gShown[180] = {};

// The Stick panel is 135 by 240. One turn makes it wide. Turning it again,
// or pushing the same picture every loop, flashes the panel.
static void landscape() {
  if (M5.Display.width() >= M5.Display.height()) return;
  M5.Display.setRotation(1);
  if (M5.Display.width() < M5.Display.height()) M5.Display.setRotation(3);
  M5.Display.setBrightness(160);
}

void screenBegin() {
  landscape();
  int w = M5.Display.width();
  int h = M5.Display.height();
  if (w < 8 || h < 8) return;
  if (w < h) return;
  gCanvas.setColorDepth(16);
  gSprite = gCanvas.createSprite(w, h);
  if (!gSprite) return;
  gCanvas.setTextWrap(false);
  gCanvas.setTextScroll(false);
  gCanvas.setFont(&fonts::Font0);
  gCanvas.setTextSize(2);
}

void screenBoot(const char* line) {
  if (!gSprite) {
    M5.Display.fillScreen(BLACK);
    M5.Display.setCursor(4, 8);
    M5.Display.setTextColor(CYAN, BLACK);
    M5.Display.setFont(&fonts::Font0);
    M5.Display.setTextSize(2);
    M5.Display.println("Tremble");
    M5.Display.setTextColor(WHITE, BLACK);
    M5.Display.println(line ? line : "");
    return;
  }
  gShown[0] = 0;
  char picture[180];
  snprintf(picture, sizeof(picture), "boot\n%s", line ? line : "");
  gCanvas.fillSprite(BLACK);
  gCanvas.setTextSize(2);
  gCanvas.setCursor(4, 4);
  gCanvas.setTextColor(CYAN, BLACK);
  gCanvas.println("Tremble");
  gCanvas.setTextColor(WHITE, BLACK);
  gCanvas.println(line ? line : "");
  gCanvas.pushSprite(0, 0);
  strncpy(gShown, picture, sizeof(gShown) - 1);
}

void screenRender() {
  if (!gSprite) return;
  LiveSnap live = {};
  captureCopyLive(&live);
  NetInfo net = {};
  netCopy(&net);

  const char* ap = net.apIp[0] ? net.apIp : "192.168.4.1";
  const char* sta = (net.staConnected && net.staIp[0]) ? net.staIp : "";
  char picture[180];
  if (!imuOk()) {
    snprintf(picture, sizeof(picture), "nosensor\n%d\n%s", net.apOn ? 1 : 0, ap);
  } else if (live.recording) {
    snprintf(picture, sizeof(picture), "REC %lus\n%d\n%s",
             (unsigned long)(live.elapsedMs / 1000), net.apOn ? 1 : 0, ap);
  } else if (net.apOn) {
    snprintf(picture, sizeof(picture), "ap\n%s\n%s", ap, sta);
  } else if (net.staConnected) {
    snprintf(picture, sizeof(picture), "sta\n%s", sta);
  } else if (net.staSsid[0]) {
    snprintf(picture, sizeof(picture), "join\n%s", net.staSsid);
  } else {
    snprintf(picture, sizeof(picture), "wifi-off");
  }
  if (strcmp(picture, gShown) == 0) return;

  gCanvas.fillSprite(BLACK);
  gCanvas.setTextSize(2);
  gCanvas.setCursor(4, 4);
  gCanvas.setTextScroll(false);
  gCanvas.setTextColor(CYAN, BLACK);
  gCanvas.println("Tremble");

  if (!imuOk()) {
    gCanvas.setTextColor(RED, BLACK);
    gCanvas.println("No sensor");
  } else if (live.recording) {
    gCanvas.setTextColor(RED, BLACK);
    gCanvas.printf("REC %lus\n", (unsigned long)(live.elapsedMs / 1000));
    gCanvas.println("Do not touch");
  } else if (net.apOn) {
    gCanvas.setTextColor(GREEN, BLACK);
    gCanvas.println("SoftAP on");
    gCanvas.setTextColor(WHITE, BLACK);
    gCanvas.println("Tremble");
    gCanvas.println("tremble1");
    gCanvas.println(ap);
    gCanvas.println("tremble.local");
    if (sta[0]) {
      gCanvas.setTextColor(CYAN, BLACK);
      gCanvas.println(sta);
    }
    gCanvas.setTextColor(WHITE, BLACK);
    gCanvas.println("Btn toggles");
  } else if (net.staConnected) {
    gCanvas.setTextColor(GREEN, BLACK);
    gCanvas.println("WiFi on");
    gCanvas.setTextColor(WHITE, BLACK);
    gCanvas.println(net.staSsid);
    gCanvas.println(sta);
    gCanvas.println("tremble.local");
    gCanvas.println("Btn SoftAP");
  } else if (net.staSsid[0]) {
    gCanvas.setTextColor(YELLOW, BLACK);
    gCanvas.println("Joining");
    gCanvas.setTextColor(WHITE, BLACK);
    gCanvas.println(net.staSsid);
    gCanvas.println("Btn SoftAP");
  } else {
    gCanvas.setTextColor(GREEN, BLACK);
    gCanvas.println("WiFi off");
    gCanvas.setTextColor(WHITE, BLACK);
    gCanvas.println("Blue button");
    gCanvas.println("starts SoftAP");
  }
  gCanvas.pushSprite(0, 0);
  strncpy(gShown, picture, sizeof(gShown) - 1);
  gShown[sizeof(gShown) - 1] = 0;
}
