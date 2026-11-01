#include "screen.h"

#include "capture.h"
#include "imu.h"
#include "net.h"

#include <M5Unified.h>
#include <stdio.h>

static M5Canvas gCanvas(&M5.Display);
static bool gSprite = false;

void screenBegin() {
  int w = M5.Display.width();
  int h = M5.Display.height();
  if (w < 8 || h < 8) return;
  gCanvas.setColorDepth(16);
  gSprite = gCanvas.createSprite(w, h);
  if (!gSprite) return;
  gCanvas.setTextWrap(false);
  gCanvas.setFont(&fonts::Font0);
  gCanvas.setTextSize(2);
}

void screenBoot(const char* line) {
  M5.Display.fillScreen(BLACK);
  M5.Display.setCursor(0, 4);
  M5.Display.setTextColor(WHITE, BLACK);
  M5.Display.setFont(&fonts::Font0);
  M5.Display.setTextSize(2);
  M5.Display.println("Tremble");
  M5.Display.setTextSize(1);
  M5.Display.println(line);
}

void screenRender() {
  if (!gSprite) return;
  LiveSnap live = {};
  captureCopyLive(&live);
  NetInfo net = {};
  netCopy(&net);

  gCanvas.fillSprite(BLACK);
  gCanvas.setTextSize(2);
  gCanvas.setCursor(0, 2);
  gCanvas.setTextColor(CYAN, BLACK);
  gCanvas.println("Tremble");

  if (!imuOk()) {
    gCanvas.setTextColor(RED, BLACK);
    gCanvas.println("No IMU");
    gCanvas.setTextSize(1);
    gCanvas.setTextColor(WHITE, BLACK);
    gCanvas.println(imuError());
    gCanvas.setTextSize(2);
  } else if (live.recording) {
    gCanvas.setTextColor(RED, BLACK);
    gCanvas.printf("REC %lus\n", (unsigned long)(live.elapsedMs / 1000));
    gCanvas.println("No touch");
  } else {
    gCanvas.setTextColor(GREEN, BLACK);
    gCanvas.println("IDLE");
    gCanvas.setTextColor(WHITE, BLACK);
    gCanvas.println("Use website");
  }

  gCanvas.setTextColor(WHITE, BLACK);
  gCanvas.printf("%luHz %ug\n", (unsigned long)live.sampleRate, live.rangeG);
  gCanvas.setTextColor(YELLOW, BLACK);
  gCanvas.printf("RSS %.3fg\n", live.rssRms);
  gCanvas.setTextColor(WHITE, BLACK);
  gCanvas.printf("X %.3fg\n", live.rms[0]);
  gCanvas.printf("Y %.3fg\n", live.rms[1]);
  gCanvas.printf("Z %.3fg\n", live.rms[2]);

  gCanvas.setTextColor(CYAN, BLACK);
  gCanvas.println("WiFi");
  gCanvas.setTextColor(WHITE, BLACK);
  gCanvas.println("Tremble");
  gCanvas.println("tremble1");
  gCanvas.println(net.apIp[0] ? net.apIp : "192.168.4.1");
  if (net.staConnected && net.staIp[0]) {
    gCanvas.println(net.staIp);
  }
  gCanvas.pushSprite(0, 0);
}
