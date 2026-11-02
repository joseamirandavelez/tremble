#pragma once

void webBegin();
// Idempotent. Call once netWifiReady() is true (SoftAP and/or STA).
void webEnsureBegun();
// Battery and flash usage for /api/status; skipped during recording (I2C).
void webPowerPoll();
