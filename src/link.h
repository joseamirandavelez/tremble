#pragma once

// USB serial at 115200. One command per line; replies are a single println.
// SoftAP can also be toggled from the Stick button or "ap on|off" here.
void linkBegin();
void linkLoop();
