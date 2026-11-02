#pragma once

#include <ESPAsyncWebServer.h>

// Serves an embedded path (/ , app.js, dsp.js, ...) with Cache-Control: no-store.
void sendAsset(AsyncWebServerRequest* request, const char* path);
