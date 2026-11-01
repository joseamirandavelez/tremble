#pragma once

#include <stdint.h>

// Little-endian capture file. Keep in sync with web/dsp.js parseVibe().
//
//  0  char     magic[4]          "VIBE"
//  4  uint16   version           1
//  6  uint16   headerBytes       64
//  8  uint32   sampleRate        Hz
// 12  uint16   rangeG            2, 4, 8, or 16
// 14  uint16   flags             bit0 gaps, bit1 truncated, bit2 gyro
// 16  uint32   sampleCount
// 20  uint32   epoch             unix seconds, 0 if unknown
// 24  uint32   durationUs
// 28  uint32   gapCount
// 32  float    lsbPerG
// 36  float    offsetX           reserved, 0
// 40  float    offsetY
// 44  float    offsetZ
// 48  uint32   measuredMilliHz   host-measured rate * 1000
// 52  float    lsbPerDps         0 when gyro is off
// 56  uint8    reserved[8]
// 64  int16    samples           x, y, z repeating
//                                or x, y, z, gx, gy, gz when bit2 is set

static constexpr uint16_t VIBE_VERSION = 1;
static constexpr uint16_t VIBE_HEADER_BYTES = 64;
static constexpr uint16_t VIBE_FLAG_GAPS = 1u;
static constexpr uint16_t VIBE_FLAG_TRUNCATED = 2u;
static constexpr uint16_t VIBE_FLAG_GYRO = 4u;

struct __attribute__((packed)) VibeHeader {
  char magic[4];
  uint16_t version;
  uint16_t headerBytes;
  uint32_t sampleRate;
  uint16_t rangeG;
  uint16_t flags;
  uint32_t sampleCount;
  uint32_t epoch;
  uint32_t durationUs;
  uint32_t gapCount;
  float lsbPerG;
  float offsetX;
  float offsetY;
  float offsetZ;
  uint32_t measuredMilliHz;
  float lsbPerDps;
  uint8_t reserved[8];
};

static_assert(sizeof(VibeHeader) == 64, "VibeHeader must be 64 bytes");

inline uint32_t vibeSampleBytes(const uint8_t* header) {
  uint16_t flags = (uint16_t)header[14] | ((uint16_t)header[15] << 8);
  return (flags & VIBE_FLAG_GYRO) ? 12u : 6u;
}
