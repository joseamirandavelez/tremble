// Sample path: PSRAM ring for finished captures, separate live rings for the
// waveform (~100 Hz decimated) and FFT window (512 raw XYZ). gDownloads gates
// concurrent HTTP download/save against buffer reuse.

#include "capture.h"

#include "imu.h"
#include "net.h"
#include "vibe_format.h"

#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
#include <freertos/semphr.h>
#include <math.h>
#include <string.h>
#include <atomic>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static constexpr uint32_t kMaxSamples = 1600u * 120u;
static constexpr int kWave = 300;

struct WavePoint {
  float x;
  float y;
  float z;
};
static constexpr int kRecent = 512;

static int16_t* gBuf = nullptr;
static uint8_t gStride = 3;
static uint32_t gCapacity = 0;
static portMUX_TYPE gLiveMux = portMUX_INITIALIZER_UNLOCKED;
static std::atomic<uint32_t> gCount{0};
static std::atomic<bool> gRecording{false};
static std::atomic<uint32_t> gDownloads{0};

static uint32_t gRate = 800;
static uint8_t gRange = 2;
static float gLsb = 16384.0f;
static bool gGyro = false;
static float gLsbDps = 0;
static uint16_t gSeconds = 10;
static uint32_t gTarget = 8000;

static uint32_t gFrozenRate = 800;
static uint16_t gFrozenRange = 2;
static float gFrozenLsb = 16384.0f;
static bool gFrozenGyro = false;
static float gFrozenDps = 0;
static int64_t gStartUs = 0;
static uint32_t gEpoch = 0;
static uint32_t gDurationUs = 0;
static uint32_t gFrozenGaps = 0;
static uint32_t gMeasuredMilli = 0;
static bool gTruncated = false;
static bool gReady = false;
static std::atomic<uint32_t> gGaps{0};

static float gDc[3] = {0, 0, 0};
static float gMs[3] = {0, 0, 0};
static float gRms[3] = {0, 0, 0};
static float gRss = 0;
static float gPeak = 0;
static float gBlockPeak = 0;
static uint32_t gBlockCount = 0;
static float gDcAlpha = 0.01f;
static float gRmsAlpha = 0.01f;
static uint32_t gDecimN = 1;
static uint32_t gDecim = 0;
static WavePoint gWave[kWave];
static uint16_t gWavePos = 0;
static uint16_t gWaveCount = 0;
static int16_t gRecent[kRecent * 3];
static uint16_t gRecentPos = 0;
static uint16_t gRecentCount = 0;
static float gWaveScratch[kWave * 3];
static SemaphoreHandle_t gWaveCopyLock = nullptr;
static float gGyroDc[3] = {0, 0, 0};
static float gGyroMs[3] = {0, 0, 0};
static float gGyroRms[3] = {0, 0, 0};
static int64_t gHoldUs = 0;

static void publishRates() {
  float fc = 0.5f;
  float dt = 1.0f / (float)gRate;
  gDcAlpha = 1.0f - expf(-2.0f * (float)M_PI * fc * dt);
  gRmsAlpha = 1.0f - expf(-2.0f * (float)M_PI * 2.0f * dt);
  gDecimN = gRate / 100u;
  if (gDecimN < 1) gDecimN = 1;
}

static void resetFilters() {
  // gDc stays. Zeroing it prints gravity as a spike until the tracker settles.
  gMs[0] = gMs[1] = gMs[2] = 0;
  gRms[0] = gRms[1] = gRms[2] = 0;
  gRss = 0;
  gPeak = 0;
  gBlockPeak = 0;
  gBlockCount = 0;
  gDecim = 0;
  gWavePos = 0;
  gWaveCount = 0;
  gGyroDc[0] = gGyroDc[1] = gGyroDc[2] = 0;
  gGyroMs[0] = gGyroMs[1] = gGyroMs[2] = 0;
  gGyroRms[0] = gGyroRms[1] = gGyroRms[2] = 0;
}

// Prefer ~120 s at 1600 Hz in PSRAM; fall back to 30 s if allocation fails.
static bool ensureBuf(uint8_t stride) {
  if (stride != 3 && stride != 6) return false;
  if (gBuf && gStride == stride && gCapacity >= 1600u * 10u) return true;
  uint32_t samples = kMaxSamples;
  size_t bytes = (size_t)samples * stride * sizeof(int16_t);
  int16_t* next = (int16_t*)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!next) {
    samples = 1600u * 30u;
    bytes = (size_t)samples * stride * sizeof(int16_t);
    next = (int16_t*)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  if (!next) return false;
  if (gBuf) heap_caps_free(gBuf);
  gBuf = next;
  gStride = stride;
  gCapacity = samples;
  return true;
}

bool captureBegin() {
  if (gBuf) return true;
  if (!ensureBuf(3)) return false;
  publishRates();
  return true;
}

uint32_t captureCapacity() { return gCapacity; }

bool captureApply(uint32_t rateHz, uint8_t rangeG, float lsbPerG, uint16_t seconds, bool gyro, float lsbPerDps) {
  busLock();
  if (gRecording.load()) {
    busUnlock();
    return false;
  }
  if (!ensureBuf(gyro ? 6 : 3)) {
    busUnlock();
    return false;
  }
  bool changed = gRate != rateHz || gRange != rangeG || gGyro != gyro;
  gRate = rateHz;
  gRange = rangeG;
  gLsb = lsbPerG > 1.0f ? lsbPerG : 16384.0f;
  gGyro = gyro;
  gLsbDps = gyro && lsbPerDps > 1.0f ? lsbPerDps : (gyro ? (32768.0f / 2000.0f) : 0.0f);
  gSeconds = seconds;
  uint32_t target = seconds ? (uint32_t)rateHz * seconds : gCapacity;
  if (gCapacity && target > gCapacity) target = gCapacity;
  if (target < rateHz) target = rateHz;
  gTarget = target;
  publishRates();
  if (changed) resetFilters();
  busUnlock();
  return true;
}

void captureHold(uint32_t ms) {
  int64_t until = esp_timer_get_time() + (int64_t)ms * 1000;
  if (until > gHoldUs) gHoldUs = until;
}

bool captureStart() {
  if (!gBuf || !imuOk()) return false;
  busLock();
  if (gDownloads.load() || gRecording.load()) {
    busUnlock();
    return false;
  }
  gCount.store(0);
  gGaps.store(0);
  gReady = false;
  gTruncated = false;
  gFrozenRate = gRate;
  gFrozenRange = gRange;
  gFrozenLsb = gLsb;
  gFrozenGyro = gGyro;
  gFrozenDps = gLsbDps;
  gEpoch = netEpochNow();
  // The IMU is already streaming. Flushing the FIFO or clearing the gravity
  // tracker here produces a spike in the first samples.
  gStartUs = esp_timer_get_time();
  gRecording.store(true);
  busUnlock();
  return true;
}

static void finishLocked() {
  if (!gRecording.load()) return;
  int64_t endUs = esp_timer_get_time();
  uint32_t count = gCount.load();
  gDurationUs = (uint32_t)(endUs - gStartUs);
  gFrozenGaps = gGaps.load();
  if (count > 1 && gDurationUs > 0) {
    float hz = (float)(count - 1) * 1000000.0f / (float)gDurationUs;
    gMeasuredMilli = (uint32_t)(hz * 1000.0f);
  } else {
    gMeasuredMilli = gFrozenRate * 1000u;
  }
  gRecording.store(false);
  gReady = count > 0;
}

void captureStop() {
  busLock();
  finishLocked();
  busUnlock();
}

void captureAddGaps(uint32_t n) {
  if (n) gGaps.fetch_add(n);
}

void capturePush(int16_t x, int16_t y, int16_t z, int16_t gx, int16_t gy, int16_t gz) {
  if (esp_timer_get_time() < gHoldUs) return;
  float scale = 1.0f / gLsb;
  float axis[3] = {x * scale, y * scale, z * scale};
  float hp[3];
  for (int i = 0; i < 3; i++) {
    gDc[i] += (axis[i] - gDc[i]) * gDcAlpha;
    hp[i] = axis[i] - gDc[i];
    gMs[i] += (hp[i] * hp[i] - gMs[i]) * gRmsAlpha;
  }
  // Peak tracking uses squared magnitude so we skip a sqrt on every sample.
  float mag2 = hp[0] * hp[0] + hp[1] * hp[1] + hp[2] * hp[2];
  if (mag2 > gBlockPeak) gBlockPeak = mag2;
  gBlockCount++;
  if (gBlockCount >= gRate) {
    gPeak = sqrtf(gBlockPeak);
    gBlockPeak = 0;
    gBlockCount = 0;
  }

  if (gGyro && gLsbDps > 1.0f) {
    float gscale = 1.0f / gLsbDps;
    float rawg[3] = {gx * gscale, gy * gscale, gz * gscale};
    for (int i = 0; i < 3; i++) {
      gGyroDc[i] += (rawg[i] - gGyroDc[i]) * gDcAlpha;
      float hg = rawg[i] - gGyroDc[i];
      gGyroMs[i] += (hg * hg - gGyroMs[i]) * gRmsAlpha;
    }
  }

  portENTER_CRITICAL(&gLiveMux);
  if (++gDecim >= gDecimN) {
    gDecim = 0;
    float rss2 = 0;
    for (int i = 0; i < 3; i++) {
      gRms[i] = sqrtf(gMs[i]);
      rss2 += gRms[i] * gRms[i];
      if (gGyro) gGyroRms[i] = sqrtf(gGyroMs[i]);
    }
    gRss = sqrtf(rss2);
    gWave[gWavePos] = {hp[0], hp[1], hp[2]};
    gWavePos = (uint16_t)((gWavePos + 1) % kWave);
    if (gWaveCount < kWave) gWaveCount++;
  }
  int16_t* slot = gRecent + (size_t)gRecentPos * 3;
  slot[0] = x;
  slot[1] = y;
  slot[2] = z;
  gRecentPos = (uint16_t)((gRecentPos + 1) % kRecent);
  if (gRecentCount < kRecent) gRecentCount++;
  portEXIT_CRITICAL(&gLiveMux);

  if (gRecording.load()) {
    uint32_t count = gCount.load();
    if (count < gTarget && count < gCapacity) {
      int16_t* dst = gBuf + (size_t)count * gStride;
      dst[0] = x;
      dst[1] = y;
      dst[2] = z;
      if (gStride == 6) {
        dst[3] = gx;
        dst[4] = gy;
        dst[5] = gz;
      }
      gCount.store(count + 1);
      count++;
    }
    uint32_t wanted = gSeconds ? (uint32_t)gRate * gSeconds : gCapacity;
    if (count >= gTarget || count >= gCapacity) {
      if (count >= gCapacity && wanted > gCapacity) gTruncated = true;
      finishLocked();
    }
  }
}

bool captureBusy() { return gRecording.load() || gDownloads.load() > 0; }
bool captureRecording() { return gRecording.load(); }
bool captureReady() { return gReady; }
uint32_t captureCount() { return gCount.load(); }

void captureCopyLive(LiveSnap* out) {
  memset(out, 0, sizeof(*out));
  out->rms[0] = gRms[0];
  out->rms[1] = gRms[1];
  out->rms[2] = gRms[2];
  out->rssRms = gRss;
  out->peakRss = gPeak;
  out->sampleRate = gRecording.load() ? gFrozenRate : gRate;
  out->rangeG = gRecording.load() ? gFrozenRange : gRange;
  out->durationSec = gSeconds;
  out->count = gCount.load();
  out->target = gTarget;
  out->gaps = gRecording.load() ? gGaps.load() : gFrozenGaps;
  out->recording = gRecording.load();
  out->captureReady = gReady;
  out->truncated = gTruncated;
  out->lsbPerG = gRecording.load() ? gFrozenLsb : gLsb;
  out->capacity = gCapacity;
  out->gyro = gRecording.load() ? gFrozenGyro : gGyro;
  out->lsbPerDps = gRecording.load() ? gFrozenDps : gLsbDps;
  out->gyroRms[0] = gGyroRms[0];
  out->gyroRms[1] = gGyroRms[1];
  out->gyroRms[2] = gGyroRms[2];
  if (gRecording.load() && gStartUs) {
    out->elapsedMs = (uint32_t)((esp_timer_get_time() - gStartUs) / 1000);
  } else {
    out->elapsedMs = gDurationUs / 1000u;
  }
}

uint16_t captureCopyWave(float* xyz, uint16_t max, float* dt) {
  portENTER_CRITICAL(&gLiveMux);
  uint16_t n = gWaveCount;
  if (n > max) n = max;
  uint16_t start = (uint16_t)((gWavePos + kWave - gWaveCount) % kWave);
  if (gWaveCount > n) start = (uint16_t)((gWavePos + kWave - n) % kWave);
  for (uint16_t i = 0; i < n; i++) {
    const WavePoint& point = gWave[(start + i) % kWave];
    xyz[i * 3] = point.x;
    xyz[i * 3 + 1] = point.y;
    xyz[i * 3 + 2] = point.z;
  }
  portEXIT_CRITICAL(&gLiveMux);
  if (dt) *dt = (float)gDecimN / (float)gRate;
  return n;
}

uint16_t captureCopyWaveMilliG(int16_t* xyz, uint16_t max, float* dt) {
  // Copy under the live lock, convert outside it. lroundf inside a critical
  // section starved the IMU task and could reboot the Stick on SoftAP load.
  if (!gWaveCopyLock) gWaveCopyLock = xSemaphoreCreateMutex();
  if (max > (uint16_t)kWave) max = (uint16_t)kWave;
  xSemaphoreTake(gWaveCopyLock, portMAX_DELAY);
  uint16_t n = captureCopyWave(gWaveScratch, max, dt);
  for (uint16_t i = 0; i < (uint16_t)(n * 3u); i++) {
    float v = gWaveScratch[i] * 1000.0f;
    if (v > 32767.0f) v = 32767.0f;
    if (v < -32768.0f) v = -32768.0f;
    xyz[i] = (int16_t)lroundf(v);
  }
  xSemaphoreGive(gWaveCopyLock);
  return n;
}

uint16_t captureCopyRecent(int16_t* out, uint16_t max, uint32_t* rate, float* lsb) {
  portENTER_CRITICAL(&gLiveMux);
  uint16_t n = gRecentCount;
  if (n > max) n = max;
  uint16_t start = (uint16_t)((gRecentPos + kRecent - n) % kRecent);
  for (uint16_t i = 0; i < n; i++) {
    const int16_t* src = gRecent + (size_t)((start + i) % kRecent) * 3;
    out[i * 3] = src[0];
    out[i * 3 + 1] = src[1];
    out[i * 3 + 2] = src[2];
  }
  portEXIT_CRITICAL(&gLiveMux);
  if (rate) *rate = gRecording.load() ? gFrozenRate : gRate;
  if (lsb) *lsb = gRecording.load() ? gFrozenLsb : gLsb;
  return n;
}

bool captureBuildHeader(uint8_t* dst, uint32_t sampleCount) {
  if (!gReady) return false;
  VibeHeader header = {};
  memcpy(header.magic, "VIBE", 4);
  header.version = gFrozenGyro ? 2 : VIBE_VERSION;
  header.headerBytes = VIBE_HEADER_BYTES;
  header.sampleRate = gFrozenRate;
  header.rangeG = gFrozenRange;
  header.flags = 0;
  if (gFrozenGaps) header.flags |= VIBE_FLAG_GAPS;
  if (gTruncated) header.flags |= VIBE_FLAG_TRUNCATED;
  if (gFrozenGyro) header.flags |= VIBE_FLAG_GYRO;
  header.sampleCount = sampleCount;
  header.epoch = gEpoch;
  header.durationUs = gDurationUs;
  header.gapCount = gFrozenGaps;
  header.lsbPerG = gFrozenLsb;
  header.measuredMilliHz = gMeasuredMilli;
  header.lsbPerDps = gFrozenGyro ? gFrozenDps : 0;
  memcpy(dst, &header, sizeof(header));
  return true;
}

const int16_t* captureSamples() {
  return (const int16_t*)gBuf;
}

bool captureTryBeginSend(uint32_t* sampleCount, uint8_t* header) {
  busLock();
  if (gRecording.load() || !gReady || !gBuf) {
    busUnlock();
    return false;
  }
  gDownloads.fetch_add(1);
  uint32_t n = gCount.load();
  bool ok = captureBuildHeader(header, n);
  if (!ok) gDownloads.fetch_sub(1);
  busUnlock();
  if (!ok) return false;
  *sampleCount = n;
  return true;
}

void captureEndSend() {
  gDownloads.fetch_sub(1);
}
