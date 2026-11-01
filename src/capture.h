#pragma once

#include <stdint.h>
#include <stdbool.h>

struct LiveSnap {
  float rms[3];
  float rssRms;
  float peakRss;
  uint32_t sampleRate;
  uint16_t rangeG;
  uint16_t durationSec;
  uint32_t count;
  uint32_t target;
  uint32_t gaps;
  bool recording;
  bool captureReady;
  bool truncated;
  uint32_t elapsedMs;
  float lsbPerG;
  uint32_t capacity;
  bool gyro;
  float lsbPerDps;
  float gyroRms[3];
};

bool captureBegin();
// Returns false when the PSRAM buffer cannot hold the requested channels.
bool captureApply(uint32_t rateHz, uint8_t rangeG, float lsbPerG, uint16_t seconds, bool gyro, float lsbPerDps);
bool captureStart();
void captureStop();
void capturePush(int16_t x, int16_t y, int16_t z, int16_t gx, int16_t gy, int16_t gz);
void captureAddGaps(uint32_t n);

// Copies the live trace, oldest first, as interleaved x,y,z.
// max is the maximum number of points. dt is seconds per point.
// The trace is about 100 Hz. Each point keeps the strongest sample in that slice
// so a short shock is not skipped between draws.
uint16_t captureCopyWave(float* xyz, uint16_t max, float* dt);

// Newest raw accelerometer samples, oldest first. Used for the live spectrum.
uint16_t captureCopyRecent(int16_t* out, uint16_t max, uint32_t* rate, float* lsb);

bool captureBusy();
bool captureRecording();
bool captureReady();
uint32_t captureCount();
uint32_t captureCapacity();
void captureCopyLive(LiveSnap* out);

// Fills a 64-byte header for the frozen capture. Returns false if nothing is ready.
bool captureBuildHeader(uint8_t* dst, uint32_t sampleCount);
const int16_t* captureSamples();

// Download gate. Start fails while a download is in progress.
bool captureTryBeginSend(uint32_t* sampleCount, uint8_t* header);
void captureEndSend();
