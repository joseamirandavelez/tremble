#pragma once

void screenBegin();
// One-shot boot/status line (setup, button toggle, IMU errors).
void screenBoot(const char* line);
// Idle loop: network + recording state; skips draw if unchanged.
void screenRender();
