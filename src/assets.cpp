// Web UI baked into the firmware image (objcopy embed from web/). No LittleFS
// copy is required at runtime; sendAsset streams straight from flash.

#include "assets.h"

#include <string.h>

extern const uint8_t web_index_html_start[] asm("_binary_web_index_html_start");
extern const uint8_t web_index_html_end[] asm("_binary_web_index_html_end");
extern const uint8_t web_app_css_start[] asm("_binary_web_app_css_start");
extern const uint8_t web_app_css_end[] asm("_binary_web_app_css_end");
extern const uint8_t web_app_js_start[] asm("_binary_web_app_js_start");
extern const uint8_t web_app_js_end[] asm("_binary_web_app_js_end");
extern const uint8_t web_dsp_js_start[] asm("_binary_web_dsp_js_start");
extern const uint8_t web_dsp_js_end[] asm("_binary_web_dsp_js_end");
extern const uint8_t web_icon_svg_start[] asm("_binary_web_icon_svg_start");
extern const uint8_t web_icon_svg_end[] asm("_binary_web_icon_svg_end");
extern const uint8_t web_logo_svg_start[] asm("_binary_web_logo_svg_start");
extern const uint8_t web_logo_svg_end[] asm("_binary_web_logo_svg_end");
extern const uint8_t web_logo_text_svg_start[] asm("_binary_web_logo_text_svg_start");
extern const uint8_t web_logo_text_svg_end[] asm("_binary_web_logo_text_svg_end");

struct Asset {
  const char* path;
  const char* type;
  const uint8_t* start;
  const uint8_t* end;
};

// Embedded blobs often include a trailing NUL from the linker; do not send it.
static size_t assetLength(const uint8_t* start, const uint8_t* end) {
  size_t n = (size_t)(end - start);
  if (n && start[n - 1] == 0) n--;
  return n;
}

void sendAsset(AsyncWebServerRequest* request, const char* path) {
  const Asset assets[] = {
      {"/", "text/html", web_index_html_start, web_index_html_end},
      {"/app.css", "text/css", web_app_css_start, web_app_css_end},
      {"/app.js", "text/javascript", web_app_js_start, web_app_js_end},
      {"/dsp.js", "text/javascript", web_dsp_js_start, web_dsp_js_end},
      {"/icon.svg", "image/svg+xml", web_icon_svg_start, web_icon_svg_end},
      {"/logo.svg", "image/svg+xml", web_logo_svg_start, web_logo_svg_end},
      {"/logo-text.svg", "image/svg+xml", web_logo_text_svg_start, web_logo_text_svg_end},
  };
  for (const Asset& asset : assets) {
    if (strcmp(asset.path, path) != 0) continue;
    size_t len = assetLength(asset.start, asset.end);
    const uint8_t* start = asset.start;
    AsyncWebServerResponse* response = request->beginResponse(
        asset.type, len,
        [start, len](uint8_t* buffer, size_t maxLen, size_t index) -> size_t {
          if (index >= len) return 0;
          size_t n = len - index;
          if (n > maxLen) n = maxLen;
          memcpy(buffer, start + index, n);
          return n;
        });
    response->addHeader("Cache-Control", "no-store");
    request->send(response);
    return;
  }
  request->send(404, "text/plain", "Missing");
}
