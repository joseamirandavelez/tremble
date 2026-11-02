/* Tremble browser UI. Talks to the Stick over HTTP; heavy DSP lives in dsp.js (VibeDSP). */

/* Shared UI state. live/liveSpec come from polls; result/focus from offline VibeDSP on captures. */
const state = {
  status: null,
  recording: false,
  wasRecording: false,
  parsed: null,
  result: null,
  focus: null,
  source: "",
  busy: false,
  live: null,
  liveSpec: null,
  baseline: null,
  noise: null,
  calibrating: false,
  settingsSeen: false,
  ssidSeen: false,
  paused: false,
  netBusy: false,
  fileBusy: false,
  filesEtag: "",
  linkMisses: 0,
  liveClock: performance.now(),
  liveAt: 0,
  playTimer: 0,
};

/* Capture presets: rate, range, seconds, and default analyze filters. */
const PRESETS = {
  structure: { rate: "400", range: "2", seconds: 30, hp: 0.3, lp: 40 },
  machine: { rate: "1600", range: "8", seconds: 10, hp: 2, lp: 500 },
  impact: { rate: "1600", range: "16", seconds: 5, hp: 1, lp: 0 },
};

const COLORS = { x: "#ff8d8d", y: "#8ee0a8", z: "#8cbcff", rss: "#f0b429" };
const MODE_COLORS = ["#f0b429", "#8cbcff", "#ff8d8d", "#8ee0a8", "#d2a8ff", "#f2a27a"];
const chartMarks = {};
const chartProbes = {};
const chartRedraw = {};
let markSeq = 1;
let chartDrag = null;
let chartHoverId = "";
let chartSkipClick = false;

/* --- Tabs and layout --- */

function $(id) { return document.getElementById(id); }

function fmt(n, d) {
  return Number.isFinite(n) ? Number(n).toFixed(d) : "-";
}

async function post(url, fields) {
  const body = new URLSearchParams(fields);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "Request failed");
  return data;
}

/* Live vs Analyze share one .tools row; DOM order follows the active tab layout in app.css. */
function placeAnalyzeTools(name) {
  const tools = document.querySelector(".tools");
  const tune = document.querySelector(".tune");
  const liveSide = document.querySelector(".live-side");
  const levels = document.querySelector(".levels");
  if (!tools || !tune || !liveSide) return;
  if (name === "analyze") {
    if (tools.parentElement !== tune) {
      const stick = tune.querySelector(".stick-files");
      if (stick) tune.insertBefore(tools, stick);
      else tune.appendChild(tools);
    }
  } else if (tools.parentElement !== liveSide) {
    liveSide.insertBefore(tools, levels || null);
  }
}

/* Legacy tab ids from older builds map to analyze/live. */
function showTab(name) {
  if (name === "files" || name === "capture") name = name === "files" ? "analyze" : "live";
  closeChart();
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.setAttribute("aria-selected", btn.dataset.tab === name ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === name);
  });
  placeAnalyzeTools(name);
  if (name === "analyze") refreshFiles().catch(() => syncFileTools());
  if (name === "analyze" && state.result) refreshView();
  else drawAll();
  requestAnimationFrame(drawAll);
  saveUi();
}

function banner(text, ready) {
  const el = $("banner");
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = ready ? "banner ready" : "banner";
  el.textContent = text;
}

/* Map selects encode physical axis (+0..+2) and sign for Stick mounting. */
function axisSpec(id) {
  const raw = $(id).value || "+0";
  return { axis: Number(raw.slice(1)), sign: raw[0] === "-" ? -1 : 1 };
}

function options() {
  return {
    highpassHz: Number($("hp").value) || 0,
    lowpassHz: Number($("lp").value) || 0,
    emaAlpha: $("ema") && $("ema").type === "range" ? (Number($("ema").value) || 0) : 0,
    emaSeconds: $("ema") && $("ema").type !== "range" ? (Number($("ema").value) || 0) : 0,
    gate: $("gate") ? (Number($("gate").value) || 0) : 0,
    quantity: $("quantity").value,
    displacement: $("displacement").checked || $("quantity").value === "displacement",
    axes: [axisSpec("mapX"), axisSpec("mapY"), axisSpec("mapZ")],
  };
}

function selectedSeries() {
  const result = state.result;
  if (!result || !result.dynamic) return null;
  if (result.quantity === "velocity") return result.velocity;
  if (result.quantity === "displacement" && result.displacement) return result.displacement;
  if (result.quantity === "gyro" && result.gyro) return result.gyro;
  return result.dynamic;
}

function usesUs() {
  return $("units") && $("units").value === "us";
}

/* US units convert at display/export time; VibeDSP stays in g, mm/s, and µm. */
function displayScale(quantity) {
  if (!usesUs()) return 1;
  if (quantity === "velocity") return 1 / 25.4;
  if (quantity === "displacement") return 1 / 25400;
  if (quantity === "gyro") return 1;
  return 9.80665 / 0.0254;
}

function unitName(quantity) {
  const q = quantity || (state.result && state.result.quantity);
  const us = usesUs();
  if (q === "velocity") return us ? "in/s" : "mm/s";
  if (q === "displacement") return us ? "in" : "µm";
  if (q === "gyro") return "dps";
  return us ? "in/s^2" : "g";
}

/* --- Canvas charts (shared by Live and Analyze) --- */

function fit(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  canvas.width = Math.floor(w * ratio);
  canvas.height = Math.floor(h * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}

function readNum(id) {
  const el = $(id);
  if (!el) return null;
  const raw = String(el.value).trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function niceStep(span, target) {
  const rough = span / Math.max(2, target);
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-12))));
  const frac = rough / pow;
  const nice = frac >= 7.5 ? 10 : frac >= 3.5 ? 5 : frac >= 1.5 ? 2 : 1;
  return nice * pow;
}

function pinEnds(ticks, lo, hi, log) {
  const pos = (v) => (log ? Math.log(Math.max(v, 1e-12)) : v);
  const a = pos(lo);
  const b = pos(hi);
  const gap = Math.abs(b - a) * 0.055;
  const out = [lo];
  ticks.forEach((v) => {
    const p = pos(v);
    if (p > a + gap && p < b - gap) out.push(v);
  });
  out.push(hi);
  return out;
}

function tickValues(lo, hi, target) {
  const span = hi - lo;
  if (!(span > 0)) return [lo, hi];
  let want = Math.max(2, Math.min(target || 6, 8));
  let step = niceStep(span, want);
  for (let guard = 0; guard < 6; guard++) {
    const count = Math.floor(span / step);
    if (count <= 10) break;
    want = Math.max(2, want - 1);
    step = niceStep(span, want);
  }
  const first = Math.ceil((lo + step * 1e-9) / step) * step;
  const mid = [];
  for (let i = 0; i < 12; i++) {
    const v = first + i * step;
    if (v >= hi - step * 1e-6) break;
    if (v > lo) mid.push(v);
  }
  return pinEnds(mid, lo, hi, false);
}

function tickLabel(v) {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

function logTicks(lo, hi) {
  const mid = [];
  if (!(hi > lo) || !(lo > 0)) return [lo, hi];
  const start = Math.pow(10, Math.floor(Math.log10(lo)));
  for (let decade = start; decade <= hi; decade *= 10) {
    [1, 2, 5].forEach((mult) => {
      const v = mult * decade;
      if (v > lo && v < hi) mid.push(v);
    });
  }
  return pinEnds(mid, lo, hi, true);
}

function tickEdge(v, lo, hi) {
  const span = Math.abs(hi - lo) || 1;
  if (Math.abs(v - lo) <= span * 1e-4) return "min";
  if (Math.abs(v - hi) <= span * 1e-4) return "max";
  return "";
}

/* Plot frame: margins, linear/log scales, tick labels, and clickable axis edges. */
function drawFrame(ctx, w, h, opt) {
  const box = { left: 74, right: w - 16, top: 32, bottom: h - 44 };
  const plotW = Math.max(8, box.right - box.left);
  const plotH = Math.max(8, box.bottom - box.top);
  let yMin = opt.yMin;
  let yMax = opt.yMax;
  if (!(yMax > yMin)) {
    yMin = -1;
    yMax = 1;
  }
  let xMin = opt.xMin;
  let xMax = opt.xMax;
  if (!(xMax > xMin)) {
    xMin = 0;
    xMax = 1;
  }
  const logX = opt.xScale === "log" && xMin > 0 && xMax > xMin;
  const logY = opt.yScale === "log" && yMin > 0 && yMax > yMin;
  const yOf = (v) => {
    if (!logY) return box.top + ((yMax - v) / (yMax - yMin)) * plotH;
    const lv = Math.log(Math.max(v, yMin));
    return box.top + ((Math.log(yMax) - lv) / (Math.log(yMax) - Math.log(yMin))) * plotH;
  };
  const xOf = (v) => {
    if (!logX) return box.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const lv = Math.log(Math.max(v, xMin));
    return box.left + ((lv - Math.log(xMin)) / (Math.log(xMax) - Math.log(xMin))) * plotW;
  };
  const xFrom = (px) => {
    const u = Math.max(0, Math.min(1, (px - box.left) / plotW));
    if (!logX) return xMin + u * (xMax - xMin);
    return Math.exp(Math.log(xMin) + u * (Math.log(xMax) - Math.log(xMin)));
  };
  ctx.fillStyle = "#e7edf5";
  ctx.font = "600 13px Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(opt.title || "", 8, 18);
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.fillStyle = "#93a0b3";
  const legendHits = [];
  if (opt.legend) {
    const items = ["x", "y", "z", "rss"].filter((key) => opt.legend[key]);
    let lx = box.right - 30 - items.length * 54;
    items.forEach((key) => {
      if (opt.selected === key) {
        ctx.strokeStyle = COLORS[key];
        ctx.lineWidth = 1;
        ctx.strokeRect(lx - 4, 4, 50, 16);
      }
      ctx.strokeStyle = COLORS[key];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lx, 14);
      ctx.lineTo(lx + 14, 14);
      ctx.stroke();
      ctx.fillStyle = COLORS[key];
      ctx.fillText(key === "rss" ? "RSS" : key.toUpperCase(), lx + 18, 18);
      legendHits.push({ key, x: lx - 4, y: 2, w: 52, h: 20 });
      lx += 54;
    });
  }
  ctx.save();
  ctx.translate(16, (box.top + box.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#93a0b3";
  ctx.fillText(opt.yTitle || "", 0, 0);
  ctx.restore();
  ctx.textAlign = "center";
  const xTitle = opt.xTitle || "";
  let xTitleHit = null;
  if (opt.edges && opt.edges.xTitle && xTitle) {
    const width = ctx.measureText(xTitle).width;
    const cx = (box.left + box.right) / 2;
    xTitleHit = { x: cx - width / 2 - 10, y: h - 30, w: width + 20, h: 30 };
    ctx.fillStyle = "#9ecbff";
  }
  ctx.fillText(xTitle, (box.left + box.right) / 2, h - 8);
  ctx.fillStyle = "#93a0b3";
  ctx.strokeStyle = "#5c6b80";
  ctx.lineWidth = 1;
  ctx.strokeRect(box.left + 0.5, box.top + 0.5, plotW, plotH);
  const yTicks = logY ? logTicks(yMin, yMax) : tickValues(yMin, yMax, Math.max(3, Math.floor(plotH / 42)));
  const xTicks = logX ? logTicks(xMin, xMax) : tickValues(xMin, xMax, Math.max(3, Math.floor(plotW / 78)));
  const axisHits = [];
  const edges = opt.edges || {};
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  yTicks.forEach((v) => {
    const y = yOf(v);
    if (y < box.top - 0.5 || y > box.bottom + 0.5) return;
    if (opt.grid) {
      ctx.strokeStyle = "#243044";
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#93a0b3";
    ctx.beginPath();
    ctx.moveTo(box.left - 5, y);
    ctx.lineTo(box.left, y);
    ctx.stroke();
    const edge = tickEdge(v, yMin, yMax);
    const which = edge === "min" ? "yMin" : edge === "max" ? "yMax" : "";
    const label = tickLabel(v);
    const baseline = Math.abs(y - box.top) < 1 ? "top" : Math.abs(y - box.bottom) < 1 ? "bottom" : "middle";
    ctx.textBaseline = baseline;
    ctx.fillStyle = which && edges[which] ? "#9ecbff" : "#c9d3e2";
    ctx.fillText(label, box.left - 7, y);
    if (which && edges[which]) {
      const width = ctx.measureText(label).width;
      const hgt = 14;
      const top = baseline === "top" ? y - 1 : baseline === "bottom" ? y - hgt : y - hgt / 2;
      axisHits.push({ edge: which, x: box.left - width - 12, y: top, w: width + 8, h: hgt + 2, value: v });
      ctx.strokeStyle = "#9ecbff";
      ctx.beginPath();
      ctx.moveTo(box.left - width - 9, top + hgt);
      ctx.lineTo(box.left - 9, top + hgt);
      ctx.stroke();
    }
  });
  ctx.textBaseline = "top";
  xTicks.forEach((v) => {
    const x = xOf(v);
    if (x < box.left - 0.5 || x > box.right + 0.5) return;
    const align = x >= box.right - 1 ? "right" : x <= box.left + 1 ? "left" : "center";
    ctx.textAlign = align;
    if (opt.grid) {
      ctx.strokeStyle = "#243044";
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.bottom);
      ctx.stroke();
    }
    ctx.strokeStyle = "#93a0b3";
    ctx.beginPath();
    ctx.moveTo(x, box.bottom);
    ctx.lineTo(x, box.bottom + 5);
    ctx.stroke();
    const edge = tickEdge(v, xMin, xMax);
    const which = edge === "min" ? "xMin" : edge === "max" ? "xMax" : "";
    const label = tickLabel(v);
    ctx.fillStyle = which && edges[which] ? "#9ecbff" : "#c9d3e2";
    ctx.fillText(label, x, box.bottom + 8);
    if (which && edges[which]) {
      const width = ctx.measureText(label).width;
      const left = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
      axisHits.push({ edge: which, x: left - 3, y: box.bottom + 6, w: width + 8, h: 16, value: v });
      ctx.strokeStyle = "#9ecbff";
      ctx.beginPath();
      ctx.moveTo(left, box.bottom + 22);
      ctx.lineTo(left + width, box.bottom + 22);
      ctx.stroke();
    }
  });
  if (yMin < 0 && yMax > 0 && !opt.log) {
    ctx.strokeStyle = "#3d4c63";
    ctx.beginPath();
    ctx.moveTo(box.left, yOf(0));
    ctx.lineTo(box.right, yOf(0));
    ctx.stroke();
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.lineWidth = 1;
  return { box, plotW, plotH, xOf, yOf, xFrom, xMin, xMax, yMin, yMax, legendHits, axisHits, xTitleHit };
}

const chartAxes = {};

function noteAxes(canvas, frame, opt) {
  if (!canvas || !canvas.id) return;
  if (!opt || !opt.axis || !frame) {
    delete chartAxes[canvas.id];
    return;
  }
  const edges = opt.edges || {};
  chartAxes[canvas.id] = {
    hits: (frame.axisHits || []).filter((hit) => edges[hit.edge]),
    title: edges.xTitle ? frame.xTitleHit : null,
    apply: opt.axis,
  };
}

function axisAt(canvas, p) {
  const axes = chartAxes[canvas.id];
  if (!axes) return null;
  const hit = axes.hits.find((item) => p.x >= item.x && p.x <= item.x + item.w && p.y >= item.y && p.y <= item.y + item.h);
  if (hit) return hit;
  const title = axes.title;
  if (title && p.x >= title.x && p.x <= title.x + title.w && p.y >= title.y && p.y <= title.y + title.h) {
    return { edge: "xTitle", x: title.x, y: title.y, w: title.w, h: title.h, value: null };
  }
  return null;
}

function axisEditText(v) {
  if (!Number.isFinite(v)) return "";
  const digits = Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 1 ? 3 : 4;
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}

function setLimit(id, raw) {
  const el = $(id);
  if (!el || el.value === raw) return;
  el.value = raw;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function limitAxis(map) {
  return (edge, raw) => {
    if (map[edge]) setLimit(map[edge], raw);
  };
}

function openAxisEditor(canvas, p) {
  const hit = axisAt(canvas, p);
  if (!hit) return false;
  const axes = chartAxes[canvas.id];
  if (hit.edge === "xTitle") {
    axes.apply("xTitle", "");
    return true;
  }
  const input = $("axisEdit");
  const rect = canvas.getBoundingClientRect();
  const text = axisEditText(hit.value);
  input.hidden = false;
  input.style.left = (rect.left + hit.x) + "px";
  input.style.top = (rect.top + hit.y - 2) + "px";
  input.style.width = Math.max(72, hit.w + 10) + "px";
  input.value = text;
  input.dataset.orig = text;
  input.dataset.edge = hit.edge;
  input.dataset.canvas = canvas.id;
  input.focus();
  input.select();
  return true;
}

function commitAxisEdit(cancel) {
  const input = $("axisEdit");
  if (!input || input.hidden) return;
  const raw = input.value.trim();
  const edge = input.dataset.edge;
  const axes = chartAxes[input.dataset.canvas];
  const orig = input.dataset.orig;
  input.hidden = true;
  if (cancel || !axes || raw === orig) return;
  axes.apply(edge, raw);
}

/* Long captures decimate to vertical spans so canvas draw stays responsive. */
function strokeTime(ctx, values, fs, t0, xMin, xMax, xOf, yOf, color) {
  const n = values.length;
  if (n < 2) return;
  const i0 = Math.max(0, Math.floor((xMin - t0) * fs));
  const i1 = Math.min(n - 1, Math.ceil((xMax - t0) * fs));
  if (i1 - i0 < 1) return;
  ctx.strokeStyle = color;
  ctx.beginPath();
  const count = i1 - i0 + 1;
  if (count < 1600) {
    for (let i = i0; i <= i1; i++) {
      const x = xOf(t0 + i / fs);
      const y = yOf(values[i]);
      if (i === i0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    const cols = 700;
    for (let c = 0; c < cols; c++) {
      const a = i0 + Math.floor((c * count) / cols);
      const b = Math.max(a + 1, i0 + Math.floor(((c + 1) * count) / cols));
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = a; j < b && j < n; j++) {
        const v = values[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const x = xOf(t0 + ((a + b) * 0.5) / fs);
      ctx.moveTo(x, yOf(lo));
      ctx.lineTo(x, yOf(hi));
    }
  }
  ctx.stroke();
}

function quantityLabel(quantity) {
  if (quantity === "velocity") return "Velocity";
  if (quantity === "displacement") return "Displacement";
  if (quantity === "gyro") return "Angular velocity";
  return "Acceleration";
}

function drawWave(canvas, series, fs, show, extra) {
  const opt = extra || {};
  if (canvas.id) chartRedraw[canvas.id] = () => drawWave(canvas, series, fs, show, extra);
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#121820";
  ctx.fillRect(0, 0, w, h);
  const gain = opt.gain > 0 ? opt.gain : 1;
  if (show.rss && series && series.x && !series.rss) {
    const rss = new Float32Array(series.x.length);
    for (let i = 0; i < series.x.length; i++) rss[i] = Math.hypot(series.x[i], series.y[i] || 0, series.z[i] || 0);
    series = { x: series.x, y: series.y, z: series.z, rss };
  }
  const keys = ["x", "y", "z", "rss"].filter((key) => show[key] && (!series || series[key]));
  const picked = chosenKey(canvas, opt, keys);
  const scaleKeys = picked ? [picked] : keys;
  const t0 = opt.t0 || 0;
  const seconds = series && series.x && series.x.length ? series.x.length / fs : 1;
  let lo = Infinity;
  let hi = -Infinity;
  const consider = (block) => {
    if (!block) return;
    scaleKeys.forEach((key) => {
      const values = block[key];
      if (!values) return;
      const step = Math.max(1, Math.floor(values.length / 500));
      for (let i = 0; i < values.length; i += step) {
        const v = values[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    });
  };
  if (series && series.x) consider(series);
  if (opt.under && $("showRaw") && $("showRaw").checked && (!state.result || state.result.quantity === "accel" || opt.forceRaw)) consider(opt.under);
  if (opt.guides) {
    opt.guides.forEach((guide) => {
      if (!guide || !guide.values || !guide.key) return;
      const block = {};
      block[guide.key] = guide.values;
      consider(block);
    });
  }
  if (!Number.isFinite(lo) || lo === hi) {
    lo = -1;
    hi = 1;
  }
  lo *= gain;
  hi *= gain;
  const pad = (hi - lo) * 0.08 || 0.1;
  if (opt.yMin == null) lo -= pad;
  else lo = opt.yMin;
  if (opt.yMax == null) hi += pad;
  else hi = opt.yMax;
  if (!(hi > lo)) hi = lo + 1;
  const frame = drawFrame(ctx, w, h, {
    title: opt.title || "Time waveform",
    xTitle: opt.xTitle || "Time (s)",
    yTitle: opt.yTitle || "Amplitude",
    xMin: t0,
    xMax: t0 + seconds,
    yMin: lo,
    yMax: hi,
    grid: opt.grid !== false,
    legend: show,
    selected: picked,
    edges: opt.edges,
  });
  noteAxes(canvas, frame, opt);
  if (!series || !series.x || series.x.length < 2) {
    if (canvas.id) chartProbes[canvas.id] = null;
    ctx.fillStyle = "#93a0b3";
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText(opt.empty || "Open a capture to see the waveform", frame.box.left + 12, frame.box.top + 28);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.box.left, frame.box.top, frame.plotW, frame.plotH);
  ctx.clip();
  const yScaled = (v) => frame.yOf(v * gain);
  if (opt.under && $("showRaw") && $("showRaw").checked && (!state.result || state.result.quantity === "accel" || opt.forceRaw)) {
    keys.forEach((key) => {
      if (!opt.under[key]) return;
      strokeTime(ctx, opt.under[key], fs, t0, frame.xMin, frame.xMax, frame.xOf, yScaled, "#66788c");
    });
  }
  const ordered = keys.filter((key) => key !== picked);
  if (picked) ordered.push(picked);
  ordered.forEach((key) => {
    ctx.globalAlpha = picked && key !== picked ? 0.12 : 1;
    ctx.lineWidth = key === picked ? 2.5 : 1.15;
    strokeTime(ctx, series[key], fs, t0, frame.xMin, frame.xMax, frame.xOf, yScaled, COLORS[key]);
  });
  ctx.globalAlpha = 1;
  if (opt.guides) {
    opt.guides.forEach((guide) => {
      if (!guide || !guide.values) return;
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = guide.color || "#f0b429";
      ctx.setLineDash(guide.dash || [6, 5]);
      ctx.beginPath();
      let drawing = false;
      const values = guide.values;
      const i0 = Math.max(0, Math.floor((frame.xMin - t0) * fs));
      const i1 = Math.min(values.length - 1, Math.ceil((frame.xMax - t0) * fs));
      for (let i = i0; i <= i1; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) {
          drawing = false;
          continue;
        }
        const x = frame.xOf(t0 + i / fs);
        const y = yScaled(v);
        if (!drawing) {
          ctx.moveTo(x, y);
          drawing = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    });
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#f0b429";
  const marks = [];
  if (opt.windowAt) opt.windowAt.forEach((t) => { if (Number.isFinite(t)) marks.push(t); });
  else if (Number.isFinite(opt.cursor) && !(opt.span > 0)) marks.push(opt.cursor);
  marks.forEach((t) => {
    let x = frame.xOf(t);
    if (x < frame.box.left + 1) x = frame.box.left + 1;
    if (x > frame.box.right - 1) x = frame.box.right - 1;
    ctx.beginPath();
    ctx.moveTo(x, frame.box.top);
    ctx.lineTo(x, frame.box.bottom);
    ctx.stroke();
  });
  ctx.restore();
  const probe = {
    kind: "wave",
    frame,
    keys,
    sample(key, dataX) {
      const values = series[key];
      if (!values || values.length < 2) return null;
      let i = Math.round((dataX - t0) * fs);
      if (i < 0) i = 0;
      if (i >= values.length) i = values.length - 1;
      const shown = values[i] * gain;
      const at = t0 + i / fs;
      return { key, dataX: at, v: shown, pixelX: frame.xOf(at), pixelY: frame.yOf(shown) };
    },
    spanAt(key, dataX) {
      const hit = this.sample(key, dataX);
      if (!hit) return null;
      const values = series[key];
      const n = values.length;
      const i0 = Math.max(0, Math.floor((frame.xMin - t0) * fs));
      const i1 = Math.min(n - 1, Math.ceil((frame.xMax - t0) * fs));
      const count = i1 - i0 + 1;
      if (count < 1600) return { y0: hit.pixelY, y1: hit.pixelY };
      const cols = 700;
      const c = Math.max(0, Math.min(cols - 1, Math.floor(((dataX - frame.xMin) / (frame.xMax - frame.xMin)) * cols)));
      const a = i0 + Math.floor((c * count) / cols);
      const b = Math.max(a + 1, i0 + Math.floor(((c + 1) * count) / cols));
      let loV = Infinity;
      let hiV = -Infinity;
      for (let j = a; j < b && j < n; j++) {
        const v = values[j] * gain;
        if (v < loV) loV = v;
        if (v > hiV) hiV = v;
      }
      return { y0: frame.yOf(hiV), y1: frame.yOf(loV) };
    },
    pointLabel(hit) {
      return tickLabel(hit.dataX) + " s  " + tickLabel(hit.v);
    },
  };
  if (canvas.id) chartProbes[canvas.id] = probe;
  paintMarks(ctx, probe, marksFor(canvas, opt));
}

function drawSpectrum(canvas, spectrum, logScale, show, extra) {
  const passed = typeof extra === "number" ? { fMax: extra } : (extra || {});
  if (canvas.id) chartRedraw[canvas.id] = () => drawSpectrum(canvas, spectrum, logScale, show, extra);
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#121820";
  ctx.fillRect(0, 0, w, h);
  const keys = ["x", "y", "z", "rss"].filter((key) => show[key] && spectrum && spectrum[key]);
  const gain = passed.gain > 0 ? passed.gain : 1;
  const rate = (state.result && state.result.sampleRate) || (state.liveSpec && state.liveSpec.sampleRate) || 1;
  const autoMax = (state.result && (state.result.lowpassHz || rate * 0.45)) || rate * 0.45;
  let fMin = passed.fMin != null ? passed.fMin : 0;
  let fMax = passed.fMax != null ? passed.fMax : autoMax;
  const logF = !!passed.logF;
  if (logF && !(fMin > 0)) fMin = Math.max((spectrum && spectrum.df) || 0.5, 0.2);
  if (!(fMax > fMin)) {
    fMin = logF ? Math.max(fMin, 0.2) : 0;
    fMax = autoMax > fMin ? autoMax : fMin + 1;
  }
  const picked = chosenKey(canvas, passed, keys);
  const scaleKeys = picked ? [picked] : keys;
  let nativePeak = 0;
  if (spectrum && passed.yMax == null) {
    scaleKeys.forEach((key) => {
      const amp = spectrum[key];
      const a = Math.max(0, Math.floor(fMin / spectrum.df));
      const b = Math.min(amp.length - 1, Math.ceil(fMax / spectrum.df));
      for (let i = a; i <= b; i++) if (amp[i] > nativePeak) nativePeak = amp[i];
    });
  }
  if (!(nativePeak > 0)) nativePeak = 1;
  const yTitle = logScale ? "Level (dB re peak)" : (passed.yTitle || "Amplitude");
  const frame = drawFrame(ctx, w, h, {
    title: passed.title || "Frequency spectrum",
    xTitle: logF ? "Frequency (Hz, log)" : "Frequency (Hz)",
    yTitle,
    xMin: fMin,
    xMax: fMax,
    xScale: logF ? "log" : "linear",
    yMin: logScale ? -80 : 0,
    yMax: logScale ? 0 : (passed.yMax != null ? passed.yMax : nativePeak * gain * 1.08),
    grid: passed.grid !== false,
    legend: show,
    selected: picked,
    log: !!logScale,
    edges: passed.edges,
  });
  noteAxes(canvas, frame, passed);
  if (!spectrum) {
    if (canvas.id) chartProbes[canvas.id] = null;
    ctx.fillStyle = "#93a0b3";
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText(passed.empty || "Open a capture to see the spectrum", frame.box.left + 12, frame.box.top + 28);
    return;
  }
  const yOfAmp = (v) => {
    if (!logScale) return frame.yOf(v * gain);
    const db = 20 * Math.log10(Math.max(v, nativePeak * 1e-8) / nativePeak);
    return frame.yOf(Math.max(-80, Math.min(0, db)));
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.box.left, frame.box.top, frame.plotW, frame.plotH);
  ctx.clip();
  const ordered = keys.filter((key) => key !== picked);
  if (picked) ordered.push(picked);
  ordered.forEach((key) => {
    const amp = spectrum[key];
    ctx.beginPath();
    ctx.strokeStyle = COLORS[key];
    ctx.globalAlpha = picked && key !== picked ? 0.12 : 1;
    ctx.lineJoin = "miter";
    ctx.miterLimit = 8;
    ctx.lineCap = "butt";
    if (passed.curve) {
      const i0 = Math.max(0, Math.ceil(fMin / spectrum.df));
      const i1 = Math.min(amp.length - 1, Math.floor(fMax / spectrum.df));
      const pts = [];
      for (let i = i0; i <= i1; i++) pts.push({ x: frame.xOf(i * spectrum.df), y: yOfAmp(amp[i]) });
      ctx.lineWidth = key === picked ? 2.6 : 1.75;
      if (pts.length) {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      }
    } else {
      ctx.lineWidth = key === picked ? 2.4 : 1.25;
      const cols = Math.max(2, Math.floor(frame.plotW));
      for (let c = 0; c < cols; c++) {
        const span = logF ? Math.log(fMax) - Math.log(fMin) : (fMax - fMin);
        const fa = logF ? Math.exp(Math.log(fMin) + (c / cols) * span) : fMin + (c / cols) * span;
        const fb = logF ? Math.exp(Math.log(fMin) + ((c + 1) / cols) * span) : fMin + ((c + 1) / cols) * span;
        let hi = 0;
        const i0 = Math.max(0, Math.floor(fa / spectrum.df));
        const i1 = Math.min(amp.length - 1, Math.ceil(fb / spectrum.df));
        for (let i = i0; i <= i1; i++) if (amp[i] > hi) hi = amp[i];
        const x = frame.xOf((fa + fb) * 0.5);
        const y = yOfAmp(hi);
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  ctx.restore();
  const axisAmp = (v) => {
    if (!logScale) return v * gain;
    const db = 20 * Math.log10(Math.max(v, nativePeak * 1e-8) / nativePeak);
    return Math.max(-80, Math.min(0, db));
  };
  const probe = {
    kind: "spec",
    frame,
    keys,
    sample(key, dataX) {
      const amp = spectrum[key];
      if (!amp || !amp.length) return null;
      const df = spectrum.df || 1;
      const freq = Math.max(fMin, Math.min(fMax, dataX));
      if (passed.curve) {
        let i = Math.round(freq / df);
        if (i < 0) i = 0;
        if (i >= amp.length) i = amp.length - 1;
        const at = i * df;
        return { key, dataX: at, v: axisAmp(amp[i]), pixelX: frame.xOf(at), pixelY: yOfAmp(amp[i]) };
      }
      const cols = Math.max(2, Math.floor(frame.plotW));
      const span = logF ? Math.log(fMax) - Math.log(fMin) : (fMax - fMin);
      let c = logF
        ? Math.round(((Math.log(Math.max(freq, fMin)) - Math.log(fMin)) / span) * (cols - 1))
        : Math.round(((freq - fMin) / span) * (cols - 1));
      c = Math.max(0, Math.min(cols - 1, c));
      const fa = logF ? Math.exp(Math.log(fMin) + (c / cols) * span) : fMin + (c / cols) * span;
      const fb = logF ? Math.exp(Math.log(fMin) + ((c + 1) / cols) * span) : fMin + ((c + 1) / cols) * span;
      let hi = 0;
      let hiAt = (fa + fb) * 0.5;
      const i0 = Math.max(0, Math.floor(fa / df));
      const i1 = Math.min(amp.length - 1, Math.ceil(fb / df));
      for (let i = i0; i <= i1; i++) {
        if (amp[i] > hi) {
          hi = amp[i];
          hiAt = i * df;
        }
      }
      return { key, dataX: hiAt, v: axisAmp(hi), pixelX: frame.xOf(hiAt), pixelY: yOfAmp(hi) };
    },
    pointLabel(hit) {
      return tickLabel(hit.dataX) + " Hz  " + tickLabel(hit.v) + (logScale ? " dB" : "");
    },
  };
  if (canvas.id) chartProbes[canvas.id] = probe;
  paintFreqPeaks(ctx, frame, passed.autoPeaks, yOfAmp, keys);
  paintMarks(ctx, probe, marksFor(canvas, passed));
}

function paintFreqPeaks(ctx, frame, peaks, yOfAmp, keys) {
  if (!peaks || !peaks.length || !frame) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.box.left, frame.box.top, frame.plotW, frame.plotH);
  ctx.clip();
  peaks.forEach((pt) => {
    if (keys.indexOf(pt.key) < 0) return;
    const x = frame.xOf(pt.hz);
    const y = yOfAmp(pt.amp);
    ctx.fillStyle = COLORS[pt.key];
    ctx.strokeStyle = "#f7f1e3";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const text = tickLabel(pt.labelHz != null ? pt.labelHz : pt.hz) + " Hz";
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const width = ctx.measureText(text).width + 8;
    const tx = Math.min(Math.max(frame.box.left + 2, x + 8), frame.box.right - width - 2);
    const ty = Math.max(frame.box.top + 16, y - 6);
    ctx.fillStyle = "rgba(18,24,32,0.88)";
    ctx.fillRect(tx - 2, ty - 14, width, 16);
    ctx.fillStyle = COLORS[pt.key];
    ctx.fillText(text, tx + 2, ty);
  });
  ctx.restore();
}

function heatColor(t) {
  const x = Math.max(0, Math.min(1, t));
  // Jet: deep blue → cyan → green → yellow → orange → red
  const stops = [
    [0, 0, 128],
    [0, 0, 255],
    [0, 255, 255],
    [0, 255, 0],
    [255, 255, 0],
    [255, 0, 0],
    [128, 0, 0],
  ];
  const p = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = stops[i];
  const b = stops[i + 1];
  const mix = (u, v) => (u + (v - u) * f) | 0;
  return `rgb(${mix(a[0], b[0])},${mix(a[1], b[1])},${mix(a[2], b[2])})`;
}

function drawSpectrogram(canvas, spec, extra) {
  const opt = extra || {};
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#121820";
  ctx.fillRect(0, 0, w, h);
  const logF = !!opt.logF;
  const df = spec && spec.df ? spec.df : 1;
  let fMin = opt.fMin != null ? opt.fMin : 0;
  const lp = state.result && state.result.lowpassHz;
  const autoF = spec ? (lp > 0 ? lp : spec.fs * 0.45) : 50;
  let fMax = opt.fMax != null ? opt.fMax : autoF;
  if (logF && !(fMin > 0)) fMin = Math.max(df, 0.5);
  if (!(fMax > fMin)) fMax = fMin + 1;
  const seconds = spec ? ((spec.columns - 1) * spec.hop + spec.win) / spec.fs : 1;
  const frame = drawFrame(ctx, w, h, {
    title: opt.title || "Spectrogram",
    xTitle: "Time (s)",
    yTitle: logF ? "Frequency (Hz, log)" : "Frequency (Hz)",
    xMin: opt.t0 || 0,
    xMax: (opt.t0 || 0) + Math.max(seconds, 0.01),
    yMin: fMin,
    yMax: fMax,
    yScale: logF ? "log" : "linear",
    grid: opt.grid !== false,
    edges: opt.edges,
  });
  noteAxes(canvas, frame, opt);
  if (!spec) {
    ctx.fillStyle = "#93a0b3";
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText(opt.empty || "Open a capture to see how the tones decay", frame.box.left + 12, frame.box.top + 28);
    return;
  }
  let peak = 0;
  for (let i = 0; i < spec.mag.length; i++) if (spec.mag[i] > peak) peak = spec.mag[i];
  if (!(peak > 0)) peak = 1;
  // Last real FFT bin. Rows above this used to clamp to that one bin, which
  // painted solid vertical bars across the top of the chart.
  const dataMaxF = (spec.bins - 1) * spec.df;
  const cols = Math.max(1, Math.floor(frame.plotW));
  const rows = Math.max(1, Math.floor(frame.plotH));
  for (let x = 0; x < cols; x++) {
    const col = Math.min(spec.columns - 1, Math.floor((x / cols) * spec.columns));
    const base = col * spec.bins;
    for (let y = 0; y < rows; y++) {
      const frac = 1 - (y + 0.5) / rows;
      const freq = logF
        ? Math.exp(Math.log(fMin) + frac * (Math.log(fMax) - Math.log(fMin)))
        : fMin + frac * (fMax - fMin);
      if (!(freq >= 0) || freq > dataMaxF) continue;
      const bin = Math.max(0, Math.min(spec.bins - 1, Math.round(freq / spec.df)));
      const db = 20 * Math.log10(Math.max(spec.mag[base + bin], peak * 1e-7) / peak);
      ctx.fillStyle = heatColor((db + 70) / 70);
      ctx.fillRect(frame.box.left + x - 0.3, frame.box.top + y - 0.3, 1.6, 1.6);
    }
  }
  if (opt.windowAt && opt.windowAt.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.box.left, frame.box.top, frame.plotW, frame.plotH);
    ctx.clip();
    ctx.strokeStyle = "#f0b429";
    ctx.lineWidth = 1.5;
    opt.windowAt.forEach((t) => {
      if (!Number.isFinite(t)) return;
      let x = frame.xOf(t);
      if (x < frame.box.left + 1) x = frame.box.left + 1;
      if (x > frame.box.right - 1) x = frame.box.right - 1;
      ctx.beginPath();
      ctx.moveTo(x, frame.box.top);
      ctx.lineTo(x, frame.box.bottom);
      ctx.stroke();
    });
    ctx.restore();
  }
}

function drawCampbell(canvas, spec, extra) {
  const opt = extra || {};
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#121820";
  ctx.fillRect(0, 0, w, h);
  const logF = !!opt.logF;
  const df = spec && spec.df ? spec.df : 1;
  let fMin = opt.fMin != null ? opt.fMin : 0;
  const lp = state.result && state.result.lowpassHz;
  const autoF = spec ? (lp > 0 ? lp : spec.fs * 0.45) : 50;
  let fMax = opt.fMax != null ? opt.fMax : autoF;
  if (logF && !(fMin > 0)) fMin = Math.max(df, 0.5);
  if (!(fMax > fMin)) fMax = fMin + 1;
  const t0 = opt.t0 || 0;
  const seconds = spec ? ((spec.columns - 1) * spec.hop + spec.win) / spec.fs : 1;
  const t1 = t0 + Math.max(seconds, 0.01);
  const rpm0 = readNum("rpmFrom");
  const rpm1 = readNum("rpmTo");
  const runUp = rpm0 != null && rpm1 != null && Math.abs(rpm1 - rpm0) > 0.5;
  const steady = !runUp && rpm0 != null && rpm0 > 0;
  const xOfT = (t) => {
    if (!runUp) return t;
    return rpm0 + ((t - t0) / (t1 - t0)) * (rpm1 - rpm0);
  };
  const frame = drawFrame(ctx, w, h, {
    title: runUp ? "Campbell diagram" : "Mode tracks",
    xTitle: runUp ? "Speed (RPM)" : "Time (s)",
    yTitle: logF ? "Frequency (Hz, log)" : "Frequency (Hz)",
    xMin: runUp ? Math.min(rpm0, rpm1) : t0,
    xMax: runUp ? Math.max(rpm0, rpm1) : t1,
    yMin: fMin,
    yMax: fMax,
    yScale: logF ? "log" : "linear",
    grid: opt.grid !== false,
    edges: opt.edges,
  });
  noteAxes(canvas, frame, opt);
  if (!spec) {
    ctx.fillStyle = "#93a0b3";
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText("Open a capture to follow the modes", frame.box.left + 12, frame.box.top + 28);
    return;
  }
  const tracks = VibeDSP.modeTracks(spec, { fMin, fMax });
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.box.left, frame.box.top, frame.plotW, frame.plotH);
  ctx.clip();
  const orders = [];
  if (runUp || steady) {
    const lo = runUp ? Math.min(rpm0, rpm1) : rpm0;
    const hi = runUp ? Math.max(rpm0, rpm1) : rpm0;
    for (let n = 1; n <= 12 && orders.length < 8; n++) {
      const fLo = (n * lo) / 60;
      const fHi = (n * hi) / 60;
      if (Math.max(fLo, fHi) < fMin || Math.min(fLo, fHi) > fMax) continue;
      orders.push(n);
    }
  }
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(147,160,179,0.9)";
  ctx.font = "11px Segoe UI, sans-serif";
  ctx.fillStyle = "#93a0b3";
  orders.forEach((n) => {
    const f0 = (n * rpm0) / 60;
    const f1 = (n * (runUp ? rpm1 : rpm0)) / 60;
    ctx.beginPath();
    ctx.moveTo(frame.xOf(xOfT(t0)), frame.yOf(f0));
    ctx.lineTo(frame.xOf(runUp ? xOfT(t1) : t1), frame.yOf(f1));
    ctx.stroke();
    const labelY = frame.yOf(f1);
    if (labelY > frame.box.top + 12 && labelY < frame.box.bottom - 2) {
      ctx.fillText(n + "x", frame.box.right - 26, labelY - 3);
    }
  });
  ctx.setLineDash([]);
  const hopT = spec.hop > 0 ? spec.hop / spec.fs : seconds;
  tracks.forEach((track, index) => {
    const color = MODE_COLORS[index % MODE_COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let drawing = false;
    let prevT = 0;
    track.points.forEach((point) => {
      const t = t0 + point.t;
      if (drawing && t - prevT > hopT * 3) drawing = false;
      const x = frame.xOf(xOfT(t));
      const y = frame.yOf(point.hz);
      if (!drawing) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      drawing = true;
      prevT = t;
    });
    ctx.stroke();
    const last = track.points[track.points.length - 1];
    if (!last) return;
    ctx.fillStyle = color;
    ctx.fillText(last.hz.toFixed(0) + " Hz", frame.xOf(xOfT(t0 + last.t)) + 6, frame.yOf(last.hz) - 4);
  });
  if (opt.windowAt && opt.windowAt.length) {
    ctx.strokeStyle = "#f0b429";
    ctx.lineWidth = 1.5;
    opt.windowAt.forEach((t) => {
      if (!Number.isFinite(t)) return;
      let x = frame.xOf(xOfT(t));
      if (x < frame.box.left + 1) x = frame.box.left + 1;
      if (x > frame.box.right - 1) x = frame.box.right - 1;
      ctx.beginPath();
      ctx.moveTo(x, frame.box.top);
      ctx.lineTo(x, frame.box.bottom);
      ctx.stroke();
    });
  }
  ctx.restore();
}

/* --- Analyze: timeline, focus slice, and plot refresh --- */

function channelShow() {
  return {
    x: $("chX").checked,
    y: $("chY").checked,
    z: $("chZ").checked,
    rss: $("chRss") ? $("chRss").checked : false,
  };
}

/* Scrub + Window pick a time slice; focus recomputes spectrum/metrics for that slice only. */
function viewWindow() {
  const result = state.result;
  if (!result || !result.count) return null;
  const dur = result.count / result.sampleRate;
  const tFrom = readNum("tFrom");
  const tTo = readNum("tTo");
  let zoom0 = tFrom != null ? tFrom : 0;
  let zoom1 = tTo != null ? tTo : dur;
  if (zoom0 < 0) zoom0 = 0;
  if (zoom1 > dur) zoom1 = dur;
  if (!(zoom1 > zoom0)) zoom1 = Math.min(dur, zoom0 + 0.05);
  const zoomed = (tFrom != null || tTo != null) && zoom1 - zoom0 < dur - 0.001;
  const picked = Number($("span").value) || 0;
  const pos = Math.min(1, Math.max(0, Number($("scrub").value) / 1000));
  if (picked > 0) {
    const span = Math.min(picked, zoom1 - zoom0);
    const start = zoom0 + pos * Math.max(0, zoom1 - zoom0 - span);
    return { start, span, dur, zoom0, zoom1, windowed: true, cursor: start };
  }
  return {
    start: zoom0,
    span: zoomed ? zoom1 - zoom0 : 0,
    dur,
    zoom0,
    zoom1,
    windowed: false,
    cursor: zoom0 + pos * (zoom1 - zoom0),
  };
}

function refreshView() {
  const result = state.result;
  if (!result || !result.dynamic) {
    state.focus = null;
    renderMetrics();
    drawAll();
    return;
  }
  const view = viewWindow();
  if (view && (view.windowed || view.span)) {
    const spanSamples = Math.max(16, Math.round(view.span * result.sampleRate));
    const startSample = Math.round(view.start * result.sampleRate);
    state.focus = VibeDSP.focus(result, startSample, spanSamples);
  } else {
    state.focus = null;
  }
  const label = $("scrubLabel");
  if (label && view) {
    const end = Math.min(view.dur, view.start + (view.span || 0));
    label.textContent = view.windowed
      ? `${view.start.toFixed(2)} to ${end.toFixed(2)} s`
      : (view.span
        ? `${view.zoom0.toFixed(2)} to ${view.zoom1.toFixed(2)} s`
        : (state.playTimer || Number($("scrub").value) > 0 ? `Cursor ${view.cursor.toFixed(2)} s` : "All"));
  }
  renderMetrics();
  drawAll();
}

function chartScale() {
  const grid = !$("grid") || $("grid").checked;
  return {
    yMin: readNum("yMin"),
    yMax: readNum("yMax"),
    fMin: readNum("fMin"),
    fMax: readNum("fMax"),
    specMax: readNum("specMax"),
    grid,
  };
}

/* --- Live view: polls, conditioning, and sliding time axis --- */

function liveShows() {
  return { x: true, y: true, z: true, rss: $("chRss") ? $("chRss").checked : false };
}

function liveCondition() {
  return {
    gate: Number($("gate") && $("gate").value) || 0,
    emaAlpha: Number($("ema") && $("ema").value) || 0,
  };
}

function liveQuantity() {
  const value = $("liveQty") ? $("liveQty").value : "accel";
  if (value === "velocity" || value === "displacement") return value;
  return "accel";
}

function liveOrder() {
  const qty = liveQuantity();
  if (qty === "velocity") return 1;
  if (qty === "displacement") return 2;
  return 0;
}

/* Wall clock stretches the time axis forward while new packets arrive (trace scrolls). */
function liveClockEnd() {
  const dt = state.live && state.live.dt > 0 ? state.live.dt : 0.01;
  const n = state.live && state.live.x ? state.live.x.length : 0;
  const span = n > 1 ? (n - 1) * dt : 1;
  if (!state.liveAt) return span;
  return Math.max(span, (state.liveAt - state.liveClock) / 1000);
}

function liveTimeStart() {
  const dt = state.live && state.live.dt > 0 ? state.live.dt : 0.01;
  const n = state.live && state.live.x ? state.live.x.length : 0;
  const span = n > 1 ? (n - 1) * dt : 1;
  return liveClockEnd() - span;
}

function gatedRaw() {
  const raw = state.liveRaw && state.liveRaw.series;
  if (!raw) return null;
  const gate = Number($("gate") && $("gate").value) || 0;
  if (!(gate > 0) || !VibeDSP.conditionSeries) return raw;
  return VibeDSP.conditionSeries(raw, { gate });
}

function withEma(series) {
  const alpha = Number($("ema") && $("ema").value) || 0;
  if (!(alpha > 0) || !series || !VibeDSP.conditionSeries) return series;
  return VibeDSP.conditionSeries(series, { emaAlpha: alpha });
}

/* Decay envelope fits raw accel peaks; EMA would flatten the hit and bias damping high. */
function liveEnvelope(series, fs, t0) {
  if (!$("decayEnv") || !$("decayEnv").checked) return null;
  const raw = state.liveRaw && state.liveRaw.series;
  const rawFs = state.liveRaw && state.liveRaw.fs;
  if (!raw || !(rawFs > 0) || !series || !series.x || !VibeDSP.decayOf) return null;
  const picked = chartMarks.liveCanvas && chartMarks.liveCanvas.selected;
  const fit = VibeDSP.decayOf(raw, rawFs, picked || "");
  if (!fit) return { fit: null };
  const n = series.x.length;
  const amp = VibeDSP.envelopeAmp(fit.amp, fit.wn, liveOrder());
  const dataEnd = t0 + (n - 1) / fs;
  const rawSpan = Math.max(0, raw.x.length - 1) / rawFs;
  const rawStart = dataEnd - rawSpan;
  const tPeak = rawStart + fit.index / rawFs;
  const pos = new Float32Array(n);
  const neg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fs;
    if (t < tPeak || t + 1e-9 < rawStart) {
      pos[i] = NaN;
      neg[i] = NaN;
      continue;
    }
    const env = amp * Math.exp(-fit.sigma * (t - tPeak));
    pos[i] = env;
    neg[i] = -env;
  }
  return { key: fit.key, pos, neg, fit };
}

function paintIntegratedLevels(series, quantity) {
  if (!$("rss") || !series) return;
  const gain = displayScale(quantity);
  const digits = quantity === "displacement" ? (usesUs() ? 5 : 2) : 2;
  const unit = unitName(quantity);
  const rmsOf = (values) => {
    if (!values || !values.length) return 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      sum += v * v;
      n++;
    }
    return n ? Math.sqrt(sum / n) : 0;
  };
  const rx = rmsOf(series.x);
  const ry = rmsOf(series.y);
  const rz = rmsOf(series.z);
  $("rss").textContent = fmt(Math.hypot(rx, ry, rz) * gain, digits);
  $("rx").textContent = fmt(rx * gain, digits);
  $("ry").textContent = fmt(ry * gain, digits);
  $("rz").textContent = fmt(rz * gain, digits);
  document.querySelectorAll(".levels .live-unit").forEach((el) => { el.textContent = unit; });
  let peak = 0;
  const n = series.x.length;
  for (let i = 0; i < n; i++) {
    const mag = Math.hypot(series.x[i] || 0, series.y[i] || 0, series.z[i] || 0);
    if (mag > peak) peak = mag;
  }
  if ($("peakLive")) $("peakLive").textContent = `Peak ${fmt(peak * gain, digits)} ${unit}`;
}

function paintDamp() {
  const box = $("dampQ");
  if (!box) return;
  const spec = state.liveRawSpec && state.liveRawSpec.spectrum;
  const fs = state.liveRawSpec && state.liveRawSpec.sampleRate;
  const picked = chartMarks.liveSpecCanvas && chartMarks.liveSpecCanvas.selected;
  let res = null;
  if (spec && fs && VibeDSP.halfPower) {
    const keys = picked && spec[picked] ? [picked] : ["x", "y", "z"];
    keys.forEach((key) => {
      const one = VibeDSP.halfPower(spec[key], spec.df, Math.max(spec.df, 0.5), fs * 0.45);
      if (one && one.q > 0 && (!res || one.amp > res.amp)) res = Object.assign({ key }, one);
    });
  }
  const bar = $("dampBar");
  const fill = $("dampFill");
  const note = $("dampNote");
  const fit = state.decayFit;
  if (!res) {
    box.textContent = "-";
    if ($("dampZ")) $("dampZ").textContent = "-";
    if (fill) fill.style.width = "0";
    if (bar) {
      bar.className = "damp-bar";
      bar.setAttribute("aria-valuenow", "0");
    }
    if (note) note.textContent = "Waiting for a live peak.";
    return;
  }
  box.textContent = fmt(res.q, res.q >= 100 ? 0 : 1);
  if ($("dampZ")) $("dampZ").textContent = fmt(res.damping, 3);
  const frac = Math.max(0.04, Math.min(1, res.q / 40));
  if (fill) fill.style.width = (frac * 100).toFixed(1) + "%";
  if (bar) {
    bar.className = "damp-bar" + (res.q >= 25 ? " light" : res.q < 8 ? " heavy" : "");
    bar.setAttribute("aria-valuenow", String(Math.round(res.q)));
  }
  let text = res.key.toUpperCase() + " " + fmt(res.hz, 1) + " Hz. Half-power " + fmt(res.bandwidthHz, 2) + " Hz, from the raw acceleration.";
  if ($("decayEnv") && $("decayEnv").checked) {
    if (fit && fit.zeta > 0) {
      text += " Ring ζ " + fmt(fit.zeta, 3) + " from the raw peaks.";
      if (fit.rises > 0) text += " Some peaks grew, so this is not a clean log decay.";
    } else text += " No clean decay in the raw window.";
  }
  if (note) note.textContent = text;
}

function paintLivePeak() {
  const el = $("livePeak");
  if (!el) return;
  const peak = state.liveSpec && state.liveSpec.peaks && state.liveSpec.peaks[0];
  const qty = liveQuantity();
  const gain = displayScale(qty);
  const digits = qty === "accel" && gain === 1 ? 4 : 3;
  el.textContent = peak
    ? `Live peak ${fmt(peak.hz, 2)} Hz\nLevel ${fmt(peak.amp * gain, digits)} ${unitName(qty)}`
    : "No distinct live peak.";
}

/* liveRawSpec stays un-gated for Q/zeta; liveSpec follows live chart conditioning. */
function rebuildLiveSpectrum() {
  const packet = state.livePacket;
  if (!packet || !VibeDSP.liveLook || !VibeDSP.liveAccel) return;
  const count = packet.count;
  state.liveRaw = { series: VibeDSP.liveAccel(packet.samples, count, packet.lsb), fs: packet.rate };
  state.liveRawSpec = VibeDSP.liveLook(packet.samples, count, packet.lsb, packet.rate, {});
  const order = liveOrder();
  const opt = liveCondition();
  const plain = order === 0 && !(opt.gate > 0) && !(opt.emaAlpha > 0 && opt.emaAlpha < 1);
  state.liveSpec = plain
    ? state.liveRawSpec
    : VibeDSP.liveLook(packet.samples, count, packet.lsb, packet.rate, {
      gate: opt.gate,
      emaAlpha: opt.emaAlpha,
      integrate: order,
    });
  paintLivePeak();
  paintDamp();
}

function spectrumPeaks(spectrum, show, fMin, fMax, canvasId, enabled) {
  if (!enabled || !spectrum || !VibeDSP.topPeaks) return null;
  const picked = canvasId && chartMarks[canvasId] && chartMarks[canvasId].selected;
  const peaks = [];
  ["x", "y", "z", "rss"].forEach((key) => {
    if (!show[key] || !spectrum[key]) return;
    if (picked && key !== picked) return;
    const df = spectrum.df || 1;
    const lo = Math.max(fMin > 0 ? fMin : 0, df, 0.5);
    const hi = fMax > lo ? fMax : lo + 1;
    VibeDSP.topPeaks(spectrum[key], df, lo, hi).forEach((peak) => {
      const i = Math.min(spectrum[key].length - 1, Math.max(0, Math.round(peak.hz / df)));
      peaks.push({ key, hz: i * df, amp: spectrum[key][i], labelHz: peak.hz });
    });
  });
  return peaks;
}

function analyzePeakMarks(spectrum, show, scale) {
  const rate = (state.result && state.result.sampleRate) || 1;
  const autoF = (state.result && (state.result.lowpassHz || rate * 0.45)) || rate * 0.45;
  const fMax = scale && scale.fMax != null ? scale.fMax : autoF;
  const fMin = scale && scale.fMin != null ? scale.fMin : 0;
  return spectrumPeaks(spectrum, show, fMin, fMax, "specCanvas", $("analyzePeaks") && $("analyzePeaks").checked);
}

function tailSeries(series, fs, t0, span) {
  if (!(span > 0) || !series || !series.x || series.x.length < 4) return { series, t0 };
  const keep = Math.max(8, Math.min(series.x.length, Math.round(span * fs)));
  if (keep >= series.x.length) return { series, t0 };
  const start = series.x.length - keep;
  const cut = (arr) => (arr && arr.length === series.x.length ? arr.subarray(start) : arr);
  return {
    series: { x: cut(series.x), y: cut(series.y), z: cut(series.z) },
    t0: t0 + start / fs,
  };
}

/* Keep Live Signal and Analyze View on the same quantity; clear manual Y limits when switching. */
function syncSignal(source) {
  const fromLive = source === "live";
  const qty = fromLive ? liveQuantity() : ($("quantity") ? $("quantity").value : "accel");
  if (fromLive && $("quantity") && $("quantity").value !== qty) $("quantity").value = qty;
  if (!fromLive && qty !== "gyro" && $("liveQty") && $("liveQty").value !== qty) $("liveQty").value = qty;
  if ($("yMin")) $("yMin").value = "";
  if ($("yMax")) $("yMax").value = "";
  if ($("specMax")) $("specMax").value = "";
  saveUi();
  rebuildLiveSpectrum();
  if (state.parsed) runAnalysis();
  else drawAll();
  if (liveQuantity() === "accel" && state.status) applyStatus(state.status);
}

/* Accel uses /api/live packets when available; velocity/displacement integrate in the browser. */
function drawLiveWave() {
  const live = $("liveCanvas");
  if (!live || !document.getElementById("live").classList.contains("active")) return;
  const qty = liveQuantity();
  const order = liveOrder();
  let series = null;
  let fs = 100;
  let t0 = 0;
  if (order === 0) {
    fs = state.live && state.live.dt > 0 ? 1 / state.live.dt : 100;
    t0 = liveTimeStart();
    if (state.live && VibeDSP.conditionSeries) {
      series = VibeDSP.conditionSeries({ x: state.live.x, y: state.live.y, z: state.live.z }, liveCondition());
    }
  } else {
    const gated = gatedRaw();
    if (gated && state.liveRaw && VibeDSP.integrateSeries) {
      fs = state.liveRaw.fs;
      series = withEma(VibeDSP.integrateSeries(gated, fs, order));
      const span = series.x.length > 1 ? (series.x.length - 1) / fs : 1;
      t0 = liveClockEnd() - span;
    }
  }
  if (order !== 0) {
    if (series) paintIntegratedLevels(series, qty);
    else if ($("rss")) {
      $("rss").textContent = "-";
      $("rx").textContent = "-";
      $("ry").textContent = "-";
      $("rz").textContent = "-";
      document.querySelectorAll(".levels .live-unit").forEach((el) => { el.textContent = unitName(qty); });
    }
  }
  const zoomed = tailSeries(series, fs, t0, Number($("liveSpan") && $("liveSpan").value) || 0);
  series = zoomed.series;
  t0 = zoomed.t0;
  const env = series ? liveEnvelope(series, fs, t0) : null;
  state.decayFit = env && env.fit ? env.fit : null;
  const guides = env && env.pos ? [
    { key: env.key, values: env.pos, color: "#f0b429", dash: [6, 5] },
    { key: env.key, values: env.neg, color: "#f0b429", dash: [6, 5] },
  ] : null;
  const shownEnd = t0 + (series && series.x && series.x.length > 1 ? (series.x.length - 1) / fs : 1);
  drawWave(live, series, fs, liveShows(), {
    title: "Live " + quantityLabel(qty).toLowerCase(),
    yTitle: quantityLabel(qty) + " (" + unitName(qty) + ")",
    empty: "Waiting for samples from the Stick",
    gain: displayScale(qty),
    grid: true,
    t0,
    guides,
    edges: { xMin: true },
    axis(edge, raw) {
      if (edge !== "xMin") return;
      if (raw === "") setLimit("liveSpan", "0");
      else {
        const span = shownEnd - Number(raw);
        if (span > 0.05) setLimit("liveSpan", String(Math.round(span * 1000) / 1000));
      }
    },
  });
  chartRedraw.liveCanvas = () => drawLiveWave();
  paintDamp();
}

function drawLiveSpectrum() {
  const canvas = $("liveSpecCanvas");
  if (!canvas || !document.getElementById("live").classList.contains("active")) return;
  const logAmp = false;
  const logF = $("logF") && $("logF").checked;
  const show = liveShows();
  const spec = state.liveSpec && state.liveSpec.spectrum;
  const autoF = state.liveSpec ? state.liveSpec.sampleRate * 0.45 : 200;
  const fLo = readNum("liveFmin");
  const fHi = readNum("liveFmax");
  const fMax = fHi != null ? fHi : autoF;
  const qty = liveQuantity();
  drawSpectrum(canvas, spec, logAmp, show, {
    title: "Live spectrum",
    yTitle: logAmp ? "Level (dB re peak)" : "Amplitude (" + unitName(qty) + ")",
    empty: "Waiting for samples from the Stick",
    fMin: fLo != null ? fLo : 0,
    fMax,
    gain: displayScale(qty),
    logF,
    curve: true,
    grid: true,
    autoPeaks: spectrumPeaks(spec, show, fLo != null ? fLo : 0, fMax, "liveSpecCanvas", $("markPeaks") && $("markPeaks").checked),
    edges: { xMin: true, xMax: true },
    axis: limitAxis({ xMin: "liveFmin", xMax: "liveFmax" }),
  });
  chartRedraw.liveSpecCanvas = () => drawLiveSpectrum();
}

/* Spectrogram uses pre-gate accel so a noise gate does not erase stripes. */
function gramSeries(series, sampleStart, sampleCount) {
  const full = state.result;
  const src = (full && full.quantity === "accel" && full.beforeGate && full.beforeGate.x) ? full.beforeGate : series;
  if (!src || !src.x) return series;
  const a = Math.max(0, sampleStart || 0);
  let len = sampleCount > 0 ? sampleCount : src.x.length - a;
  if (a + len > src.x.length) len = src.x.length - a;
  if (len < 1) return series;
  if (a === 0 && len === src.x.length) return src;
  return {
    x: src.x.subarray(a, a + len),
    y: src.y.subarray(a, a + len),
    z: src.z.subarray(a, a + len),
  };
}

function spectrogramSeries(series, sampleStart, sampleCount) {
  const use = gramSeries(series, sampleStart, sampleCount);
  if (!use || !use.x || use.x.length < 64 || !state.result) return null;
  const win = Number($("stftWin") && $("stftWin").value) || 256;
  const key = [state.result.count, state.result.quantity, sampleStart || 0, use.x.length, win].join(":");
  if (state.gramCache && state.gramKey === key) return state.gramCache;
  const rss = new Float32Array(use.x.length);
  for (let i = 0; i < rss.length; i++) rss[i] = Math.hypot(use.x[i] || 0, use.y[i] || 0, use.z[i] || 0);
  const picture = VibeDSP.spectrogram(rss, state.result.sampleRate, { win });
  state.gramKey = key;
  state.gramCache = picture;
  return picture;
}

function drawAll() {
  if (document.getElementById("live").classList.contains("active")) {
    drawLiveWave();
    drawLiveSpectrum();
  }
  if (!document.getElementById("analyze").classList.contains("active")) return;
  const view = viewWindow();
  const fs = state.result ? state.result.sampleRate : 1;
  const full = selectedSeries();
  const rawFull = state.result && state.result.raw;
  let wave = full;
  let raw = rawFull;
  let t0 = 0;
  let sampleStart = 0;
  let sampleCount = full && full.x ? full.x.length : 0;
  if (view && full && full.x && fs > 0) {
    const a = Math.max(0, Math.min(full.x.length, Math.round(view.zoom0 * fs)));
    const b = Math.max(a, Math.min(full.x.length, Math.round(view.zoom1 * fs)));
    sampleStart = a;
    sampleCount = b - a;
    if (a > 0 || b < full.x.length) {
      const cut = (series) => series && series.x ? {
        x: series.x.subarray(a, b),
        y: series.y ? series.y.subarray(a, b) : series.y,
        z: series.z ? series.z.subarray(a, b) : series.z,
      } : series;
      wave = cut(full);
      raw = cut(rawFull);
      t0 = view.zoom0;
    }
  }
  const spectrum = state.focus ? state.focus.spectrum : (state.result && state.result.spectrum);
  const windowAt = view && view.windowed ? [view.start, Math.min(view.dur, view.start + view.span)] : null;
  const cursor = view && !view.windowed && (state.playTimer || Number($("scrub").value) > 0) ? view.cursor : null;
  const scale = chartScale();
  const quantity = state.result && state.result.quantity;
  const unit = unitName(quantity);
  const gain = displayScale(quantity);
  const logF = $("logF") && $("logF").checked;
  const show = channelShow();
  drawWave($("waveCanvas"), wave, fs, show, {
    under: raw,
    cursor,
    windowAt,
    t0,
    title: quantityLabel(quantity) + " waveform",
    yTitle: quantityLabel(quantity) + " (" + unit + ")",
    yMin: scale.yMin,
    yMax: scale.yMax,
    gain,
    grid: scale.grid,
    edges: { xMin: true, xMax: true, yMin: true, yMax: true },
    axis: limitAxis({ xMin: "tFrom", xMax: "tTo", yMin: "yMin", yMax: "yMax" }),
  });
  const logAmp = $("logSpec").checked;
  drawSpectrum($("specCanvas"), spectrum, logAmp, show, {
    title: quantityLabel(quantity) + " spectrum",
    yTitle: "Amplitude (" + unit + ")",
    fMin: scale.fMin,
    fMax: scale.fMax,
    yMax: scale.specMax,
    gain,
    logF,
    grid: scale.grid,
    autoPeaks: analyzePeakMarks(spectrum, show, scale),
    edges: { xMin: true, xMax: true, yMax: !logAmp },
    axis: limitAxis({ xMin: "fMin", xMax: "fMax", yMax: "specMax" }),
  });
  const gram = $("gramCanvas");
  const picture = full ? spectrogramSeries(full, sampleStart, sampleCount) : null;
  if (gram) {
    drawSpectrogram(gram, picture, {
      title: "Spectrogram, RSS",
      t0,
      windowAt,
      fMin: scale.fMin,
      fMax: scale.fMax,
      logF,
      grid: scale.grid,
      empty: "Open a capture to see how the tones decay",
      edges: { xMin: true, xMax: true, yMin: true, yMax: true },
      axis: limitAxis({ xMin: "tFrom", xMax: "tTo", yMin: "fMin", yMax: "fMax" }),
    });
  }
  const camp = $("campCanvas");
  if (camp) {
    drawCampbell(camp, picture, {
      t0,
      windowAt,
      fMin: scale.fMin,
      fMax: scale.fMax,
      logF,
      grid: scale.grid,
      edges: { xMin: true, xMax: true, yMin: true, yMax: true, xTitle: true },
      axis(edge, raw) {
        if (edge === "xTitle") {
          const rpm0 = readNum("rpmFrom");
          const rpm1 = readNum("rpmTo");
          const runUp = rpm0 != null && rpm1 != null && Math.abs(rpm1 - rpm0) > 0.5;
          if (runUp) {
            setLimit("rpmFrom", "");
            setLimit("rpmTo", "");
          } else {
            setLimit("rpmFrom", "0");
            setLimit("rpmTo", "3000");
          }
          return;
        }
        const rpm0 = readNum("rpmFrom");
        const rpm1 = readNum("rpmTo");
        const runUp = rpm0 != null && rpm1 != null && Math.abs(rpm1 - rpm0) > 0.5;
        const map = runUp
          ? { xMin: "rpmFrom", xMax: "rpmTo", yMin: "fMin", yMax: "fMax" }
          : { xMin: "tFrom", xMax: "tTo", yMin: "fMin", yMax: "fMax" };
        if (map[edge]) setLimit(map[edge], raw);
      },
    });
  }
}

function blockFromSeries(series) {
  const one = (values) => {
    let sum = 0;
    let peak = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const n = values ? values.length : 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    return { rms, peak, peakToPeak: n ? hi - lo : 0, crest: rms > 0 ? peak / rms : 0 };
  };
  if (!series || !series.x) return null;
  const x = one(series.x);
  const y = one(series.y);
  const z = one(series.z);
  return { x, y, z, rss: Math.hypot(x.rms, y.rms, z.rms) };
}

function renderMetrics() {
  const result = state.result;
  $("srcLabel").textContent = state.source || "No capture yet";
  const box = $("metrics");
  const notes = $("notes");
  const peaks = $("peaks");
  notes.innerHTML = "";
  peaks.innerHTML = "";
  if (!result || !result.metrics) {
    box.innerHTML = "<p>Press Start on Live, open a save from the Stick list, or drop a .vibe file.</p>";
    return;
  }
  const rows = (title, block, digits) => {
    if (!block) return "";
    const line = (name, item) => `<tr><td>${name}</td><td>${fmt(item.rms, digits)}</td><td>${fmt(item.peak, digits)}</td><td>${fmt(item.peakToPeak, digits)}</td><td>${fmt(item.crest, 2)}</td></tr>`;
    return `<h3>${title}</h3><table><tr><th></th><th>RMS</th><th>Peak</th><th>Pk-Pk</th><th>Crest</th></tr>
      ${line("X", block.x)}${line("Y", block.y)}${line("Z", block.z)}
      <tr><td>RSS</td><td>${fmt(block.rss, digits)}</td><td></td><td></td><td></td></tr></table>`;
  };
  const shown = state.focus || result;
  const peakList = shown.peaks || result.peaks;
  const resonance = shown.resonance || result.resonance;
  const vert = result.vertical ? `<p>Gravity sits mostly on <strong>${result.vertical}</strong> (means ${result.means.map((v) => fmt(v, 3)).join(", ")} g).</p>` : "";
  const windowNote = state.focus ? `<p>Window metrics, ${state.focus.count} samples.</p>` : "";
  const present = (block, quantity) => {
    if (!block) return null;
    const k = displayScale(quantity);
    if (k === 1) return block;
    const one = (item) => item && {
      rms: item.rms * k,
      peak: item.peak * k,
      peakToPeak: item.peakToPeak * k,
      crest: item.crest,
    };
    return { x: one(block.x), y: one(block.y), z: one(block.z), rss: block.rss * k };
  };
  const accelBlock = present(state.focus ? state.focus.metrics.accel : result.metrics.accel, "accel");
  const digits = usesUs() ? 3 : 4;
  const qty = result.quantity || "accel";
  const catalog = {
    accel: ["Acceleration (" + unitName("accel") + ")", accelBlock, digits],
    velocity: ["Velocity (" + unitName("velocity") + ")", present(result.metrics.velocity, "velocity"), 3],
    displacement: ["Displacement (" + unitName("displacement") + ")", present(result.metrics.displacement, "displacement"), usesUs() ? 5 : 2],
    gyro: ["Gyroscope (dps)", result.metrics.gyro, 2],
  };
  const main = catalog[qty] || catalog.accel;
  if (state.focus && state.focus.series && qty !== "accel" && qty !== "gyro") {
    main[1] = present(blockFromSeries(state.focus.series), qty);
  }
  const rest = ["accel", "velocity", "displacement", "gyro"].filter((key) => key !== qty).map((key) => {
    const item = catalog[key];
    if (!item || !item[1] || !Number.isFinite(item[1].rss)) return "";
    return `<p class="s">${item[0]} RSS ${fmt(item[1].rss, item[2])}</p>`;
  }).join("");
  box.innerHTML = vert + windowNote + `<div class="metric-scroll">${rows(main[0], main[1], main[2])}</div>` + rest;
  const ampScale = displayScale(result.quantity);
  if (peakList && peakList.length) {
    peaks.innerHTML = "<ul>" + peakList.map((p) => `<li>${fmt(p.hz, 2)} Hz · ${fmt(p.amp * ampScale, 4)} ${unitName()}</li>`).join("") + "</ul>";
  } else peaks.textContent = "No distinct peaks.";
  const resBox = $("resonance");
  if (resonance) {
    resBox.innerHTML = [
      `Natural frequency <strong>${fmt(resonance.hz, 2)} Hz</strong>`,
      `Half-power bandwidth ${fmt(resonance.bandwidthHz, 2)} Hz`,
      `Damping ratio ${fmt(resonance.damping, 3)}`,
      `Q ${fmt(resonance.q, 1)}`,
    ].map((line) => `<div>${line}</div>`).join("");
  } else resBox.textContent = "";
  renderBaseline(resonance, accelBlock);
  (result.notes || []).forEach((note) => {
    const li = document.createElement("li");
    li.textContent = note;
    notes.appendChild(li);
  });
}

function renderBaseline(resonance, accel) {
  const el = $("baseline");
  if (!state.baseline) {
    el.textContent = "Set a baseline from a settled test, then capture the change.";
    return;
  }
  const base = state.baseline;
  const lines = [`Baseline ${base.label}: ${fmt(base.hz, 2)} Hz, RSS ${fmt(base.rss, 4)} g.`];
  if (resonance && base.hz) {
    lines.push(`Frequency change ${fmt(resonance.hz - base.hz, 2)} Hz. Amplitude change ${fmt(100 * (resonance.amp - base.amp) / base.amp, 1)}%. Damping change ${fmt(resonance.damping - base.damping, 3)}.`);
  }
  if (accel && base.rss) lines.push(`RSS change ${fmt(100 * (accel.rss - base.rss) / base.rss, 1)}%.`);
  el.textContent = lines.join(" ");
}

/* --- Captures: load, CSV import, and VibeDSP analyze --- */

function runAnalysis() {
  if (!state.parsed) return;
  const opt = options();
  if (opt.quantity === "displacement") opt.displacement = true;
  state.result = VibeDSP.processCapture(state.parsed, opt);
  refreshView();
}

function parseCsv(text) {
  const rawLines = text.split(/\r?\n/);
  let rate = 0;
  const rows = [];
  let header = null;
  rawLines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const rateMatch = trimmed.match(/sample_rate_hz\s*=\s*([0-9.]+)/i);
    if (rateMatch) rate = Number(rateMatch[1]);
    if (trimmed.startsWith("#")) return;
    const cells = trimmed.split(",").map((cell) => cell.trim());
    if (!header && cells.some((cell) => /[A-Za-z]/.test(cell))) {
      header = cells.map((cell) => cell.toLowerCase());
      return;
    }
    const nums = cells.map(Number);
    if (nums.some((n) => Number.isFinite(n))) rows.push(nums);
  });
  if (!rows.length) throw new Error("CSV has no samples");
  const find = (names) => header ? header.findIndex((name) => names.includes(name)) : -1;
  let ix = find(["x", "ax", "ax_g", "accx"]);
  let iy = find(["y", "ay", "ay_g", "accy"]);
  let iz = find(["z", "az", "az_g", "accz"]);
  const it = find(["t", "time", "time_s", "time_sec"]);
  if (ix < 0) {
    ix = it >= 0 ? 1 : 0;
    iy = ix + 1;
    iz = ix + 2;
  }
  const count = rows.length;
  const lsb = 16384;
  const samples = new Int16Array(count * 3);
  const times = [];
  for (let i = 0; i < count; i++) {
    samples[i * 3] = Math.round((rows[i][ix] || 0) * lsb);
    samples[i * 3 + 1] = Math.round((rows[i][iy] || 0) * lsb);
    samples[i * 3 + 2] = Math.round((rows[i][iz] || 0) * lsb);
    if (it >= 0) times.push(rows[i][it]);
  }
  let note = "Imported CSV. Values were read as g.";
  if ((!rate || !Number.isFinite(rate)) && times.length > 2) {
    const dt = (times[times.length - 1] - times[0]) / (times.length - 1);
    if (dt > 0) rate = 1 / dt;
  }
  if (!rate || !Number.isFinite(rate)) {
    rate = 800;
    note = "CSV had no sample rate. Assumed 800 Hz. Values were read as g.";
  }
  return {
    sampleRate: rate,
    rangeG: 16,
    flags: 0,
    count,
    epoch: 0,
    durationUs: Math.round((count / rate) * 1e6),
    gapCount: 0,
    lsbPerG: lsb,
    measuredMilliHz: Math.round(rate * 1000),
    lsbPerDps: 0,
    channels: 3,
    note,
    samples,
  };
}

async function loadBuffer(buffer, source) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : await buffer.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  const magic = String.fromCharCode(head[0] || 0, head[1] || 0, head[2] || 0, head[3] || 0);
  state.parsed = magic === "VIBE" ? VibeDSP.parseVibe(bytes) : parseCsv(new TextDecoder().decode(bytes));
  clearChartMarks("waveCanvas");
  clearChartMarks("specCanvas");
  state.source = source;
  state.result = null;
  state.focus = null;
  $("scrub").value = "0";
  runAnalysis();
  banner("Analysis is ready.", true);
}

async function loadLatest() {
  const res = await fetch("/api/capture.vibe");
  if (!res.ok) return;
  await loadBuffer(await res.arrayBuffer(), "Latest capture from the Stick");
}

function paintRecBar(s) {
  const bar = $("recBar");
  if (!bar) return;
  if (!s || !s.recording) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $("recBarLabel").textContent = state.calibrating
    ? "Measuring noise. Leave the Stick on the floor."
    : "Recording. Leave the Stick alone.";
  const secs = (s.elapsedMs / 1000).toFixed(1);
  const timed = s.durationSec > 0 && s.target > 0;
  const pct = timed ? Math.min(100, (100 * s.samples) / s.target) : 0;
  $("recBarTime").textContent = timed
    ? secs + " s · " + s.samples + " samples · " + pct.toFixed(0) + "%"
    : secs + " s · " + s.samples + " samples";
  bar.classList.toggle("open", !timed);
  const fill = $("recBarFill");
  const meter = $("recBarMeter");
  if (timed) {
    fill.style.width = pct.toFixed(1) + "%";
    meter.setAttribute("aria-valuenow", String(Math.round(pct)));
  } else {
    fill.style.width = "";
    meter.removeAttribute("aria-valuenow");
  }
}

/* Status poll drives chrome, recording flow, and first-time form sync from the Stick. */
function applyStatus(s) {
  state.status = s;
  const ended = state.wasRecording && !s.recording && s.captureReady;
  state.wasRecording = s.recording;
  state.recording = s.recording;
  $("conn").textContent = s.imu
    ? `${s.apSsid} · ${s.apIp}${s.staConnected ? " · also " + s.staIp : ""}`
    : (s.error || "IMU not ready");
  const statusLine = $("deviceStatus");
  if (statusLine) {
    const parts = [s.imu ? "Sensor ready" : "Sensor not ready", s.recording ? "Recording" : "Idle"];
    if (Number.isFinite(s.battery) && s.battery >= 0) {
      let bat = "Battery " + Math.round(s.battery) + "%";
      if (s.batteryMv > 500) bat += ", " + (s.batteryMv / 1000).toFixed(2) + " V";
      parts.push(bat);
      if (s.charging === true) parts.push("Charging");
    }
    statusLine.textContent = parts.join(" · ");
  }
  if (liveQuantity() === "accel") {
    const accelScale = displayScale("accel");
    const accelDigits = accelScale === 1 ? 4 : 2;
    const accelUnit = unitName("accel");
    $("rss").textContent = fmt(s.rssRms * accelScale, accelDigits);
    $("rx").textContent = fmt(s.rms[0] * accelScale, accelDigits);
    $("ry").textContent = fmt(s.rms[1] * accelScale, accelDigits);
    $("rz").textContent = fmt(s.rms[2] * accelScale, accelDigits);
    document.querySelectorAll(".levels .live-unit").forEach((el) => { el.textContent = accelUnit; });
    $("peakLive").textContent = `Peak ${fmt(s.peakRss * accelScale, accelDigits)} ${accelUnit}`;
  }
  $("rateLive").textContent = `${s.sampleRate} Hz`;
  $("rangeLive").textContent = `±${s.rangeG} g`;
  const btn = $("recBtn");
  btn.textContent = s.recording ? "Stop" : "Start";
  btn.classList.toggle("stop", s.recording);
  btn.disabled = state.busy || !s.imu;
  const pct = s.target ? Math.min(100, (100 * s.samples) / s.target) : 0;
  paintRecBar(s);
  if ($("capMeta")) {
    $("capMeta").textContent = s.recording
      ? `Recording ${ (s.elapsedMs / 1000).toFixed(1) } s · ${s.samples} samples · ${pct.toFixed(0)}%. Do not touch the Stick.`
      : `Ready at ${s.sampleRate} Hz, ±${s.rangeG} g. Up to ${Math.floor(s.capacity / s.sampleRate)} s fits in memory.`;
  }
  if ($("netInfo")) {
    $("netInfo").textContent = `Onboard network ${s.apSsid} / ${s.apPass} at ${s.apIp}` +
      (s.staConnected ? `. Joined ${s.staSsid} at ${s.staIp}.` : s.staSsid ? `. Trying to join ${s.staSsid}.` : ".") +
      " USB serial and Bluetooth Tremble use the same commands.";
  }
  $("gyroLive").textContent = s.gyro
    ? `Gyro X ${fmt(s.gyroRms[0], 2)} dps\nGyro Y ${fmt(s.gyroRms[1], 2)} dps\nGyro Z ${fmt(s.gyroRms[2], 2)} dps`
    : "";
  if (!state.settingsSeen) {
    $("rate").value = String(s.sampleRate);
    $("range").value = String(s.rangeG);
    $("seconds").value = String(s.durationSec);
    $("gyro").checked = !!s.gyro;
    state.settingsSeen = true;
    const ranges = ["2", "4", "8", "16"];
    const idx = Math.max(0, ranges.indexOf(String(s.rangeG)));
    if ($("liveRange") && document.activeElement !== $("liveRange")) {
      $("liveRange").value = String(idx);
      $("liveRangeLabel").textContent = "±" + ranges[idx] + " g";
    }
    if (!state.ssidSeen && $("staSsid") && !$("staSsid").value && s.staSsid) $("staSsid").value = s.staSsid;
    state.ssidSeen = true;
  }
  if ($("calStart")) $("calStart").disabled = state.busy || s.recording || !s.imu;
  syncApplyBtn();
  renderNoise();
  if (s.recording) banner("");
  else if (ended && state.calibrating) finishCalibration();
  else if (ended) {
    banner("Capture finished. Opening Analyze…", true);
    loadLatest()
      .then(() => showTab("analyze"))
      .catch((err) => banner(stickDown(err) || "Capture finished, but Analyze could not load it.", false));
  }
}

/* --- Stick HTTP: status, live samples, and SoftAP pacing --- */

/* One in-flight Stick request at a time (state.netBusy) so polls do not pile up on SoftAP. */
function fetchStick(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function linkOk() {
  state.linkMisses = 0;
}

/* After several timeouts, stop hammering live polls and show a lost-link message. */
function linkFail() {
  state.linkMisses += 1;
  if (state.linkMisses < 6) return;
  $("conn").textContent = "Website lost the Stick";
  if ($("deviceStatus")) $("deviceStatus").textContent = "No status from the Stick";
}

async function pollStatus() {
  if (state.netBusy) return;
  state.netBusy = true;
  try {
    const res = await fetchStick("/api/status", softApOnly() || stickLinkDown() ? 8000 : 4000);
    if (!res.ok) throw new Error("status");
    linkOk();
    applyStatus(await res.json());
  } catch (err) {
    linkFail();
  } finally {
    state.netBusy = false;
  }
}

function parseLive(buf) {
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf);
  const dt = view.getFloat32(0, true);
  const count = view.getUint16(4, true);
  if (count < 2) return null;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  let offset = 8;
  // New packets use int16 milli-g (6 bytes/sample). Old firmware sent floats.
  if (buf.byteLength >= 8 + count * 6 && buf.byteLength < 8 + count * 12) {
    for (let i = 0; i < count; i++) {
      x[i] = view.getInt16(offset, true) / 1000;
      y[i] = view.getInt16(offset + 2, true) / 1000;
      z[i] = view.getInt16(offset + 4, true) / 1000;
      offset += 6;
    }
  } else if (buf.byteLength >= 8 + count * 12) {
    for (let i = 0; i < count; i++) {
      x[i] = view.getFloat32(offset, true);
      y[i] = view.getFloat32(offset + 4, true);
      z[i] = view.getFloat32(offset + 8, true);
      offset += 12;
    }
  } else {
    return null;
  }
  return { dt, x, y, z };
}

function pageVisible() {
  return document.visibilityState !== "hidden";
}

/* True when the page should use the lighter livefft-only path (hotspot or AP-only Stick). */
function softApOnly() {
  const host = (location.hostname || "").toLowerCase();
  const s = state.status;
  // Hit the SoftAP IP directly: keep the light feed.
  if (host === "192.168.4.1") return true;
  if (s && s.apIp && host === s.apIp) return true;
  // Lab STA address: full feed is fine.
  if (s && s.staIp && host === s.staIp) return false;
  if (s && s.staConnected && !s.apOn) return false;
  // SoftAP-only Stick (no lab join yet), including tremble.local on the hotspot.
  if (s && s.apOn && !s.staConnected) return true;
  // AP+STA via tremble.local usually means lab mDNS. Do not throttle that path.
  return false;
}

function stickLinkDown() {
  return state.linkMisses >= 3;
}

/* On SoftAP, waveform samples are derived from the livefft tail (no separate /api/live). */
function liveFromSpectrum(samples, count, rate) {
  const n = Math.min(count, 300);
  const start = (count - n) * 3;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = start + i * 3;
    x[i] = samples[o] / 1000;
    y[i] = samples[o + 1] / 1000;
    z[i] = samples[o + 2] / 1000;
  }
  return { dt: rate > 0 ? 1 / rate : 0.001, x, y, z };
}

async function pollLive() {
  if (state.paused || state.netBusy || !pageVisible() || stickLinkDown()) return;
  // SoftAP gets one feed via /api/livefft so the hotspot is not double-hit.
  if (softApOnly()) return;
  if (!$("live").classList.contains("active") && !state.recording) return;
  state.netBusy = true;
  try {
    const res = await fetchStick("/api/live", 3000);
    if (!res.ok) throw new Error("live");
    const data = parseLive(await res.arrayBuffer());
    if (!data) return;
    linkOk();
    state.live = data;
    state.liveAt = performance.now();
    if ($("live").classList.contains("active")) drawLiveWave();
  } catch (err) {
    linkFail();
  } finally {
    state.netBusy = false;
  }
}

function formCaptureSettings() {
  return {
    rate: String($("rate").value),
    range: String($("range").value),
    seconds: String($("seconds").value || "0"),
    gyro: !!$("gyro").checked,
  };
}

function settingsDirty() {
  const s = state.status;
  if (!s) return true;
  const form = formCaptureSettings();
  return form.rate !== String(s.sampleRate)
    || form.range !== String(s.rangeG)
    || form.seconds !== String(s.durationSec)
    || form.gyro !== !!s.gyro;
}

function syncApplyBtn() {
  const btn = $("apply");
  if (!btn) return;
  btn.disabled = !settingsDirty() || !!state.recording || !!state.busy;
}

async function applySettings() {
  const form = formCaptureSettings();
  await post("/api/settings", {
    rate: form.rate,
    range: form.range,
    seconds: form.seconds,
    gyro: form.gyro ? "1" : "0",
  });
  if (state.status) {
    state.status.sampleRate = Number(form.rate);
    state.status.rangeG = Number(form.range);
    state.status.durationSec = Number(form.seconds);
    state.status.gyro = form.gyro;
  }
  syncApplyBtn();
}

/* livefft returns int16 milli-g blocks; firmware also supplies rate and lsb for VibeDSP.liveLook. */
async function pollSpectrum() {
  if (state.paused || state.netBusy || !pageVisible() || stickLinkDown()) return;
  if (!$("live").classList.contains("active")) return;
  state.netBusy = true;
  try {
    const soft = softApOnly();
    const res = await fetchStick("/api/livefft", soft ? 8000 : 3000);
    if (!res.ok) throw new Error("spectrum");
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 18) return;
    const view = new DataView(buf);
    const rate = view.getUint32(0, true);
    const lsb = view.getFloat32(4, true);
    const count = view.getUint16(8, true);
    if (count < 32 || buf.byteLength < 12 + count * 6) return;
    const want = Number($("fftWin") && $("fftWin").value) || count;
    const use = Math.max(32, Math.min(count, soft ? Math.min(want, 256) : want));
    const samples = new Int16Array(buf, 12 + (count - use) * 6, use * 3);
    const copy = Int16Array.from(samples);
    state.livePacket = { samples: copy, count: use, lsb, rate };
    if (soft) {
      state.live = liveFromSpectrum(copy, use, rate);
      state.liveAt = performance.now();
    }
    linkOk();
    rebuildLiveSpectrum();
    if ($("live").classList.contains("active")) {
      drawLiveSpectrum();
      if (soft || liveOrder() !== 0) drawLiveWave();
    }
  } catch (err) {
    linkFail();
  } finally {
    state.netBusy = false;
  }
}

function feedPace() {
  const mode = ($("feedRate") && $("feedRate").value) || "slow";
  // SoftAP on the StickS3 falls over if the page hammers /api/live.
  let pace;
  if (mode === "fast") pace = { live: 500, spec: 1500, status: 5000, idle: 2000 };
  else if (mode === "slow") pace = { live: 1500, spec: 4500, status: 10000, idle: 3500 };
  else pace = { live: 1000, spec: 3000, status: 8000, idle: 3000 };
  if (softApOnly()) {
    // SoftAP can take a modest update rate now that only livefft runs.
    return {
      live: Math.max(pace.live, 2000),
      spec: Math.max(pace.spec, 2500),
      status: Math.max(pace.status, 6000),
      idle: Math.max(pace.idle, 4000),
    };
  }
  return pace;
}

/* Self-scheduling poll loop: skips live work when tab hidden unless recording. */
function pace(fn, pickMs) {
  const tick = async () => {
    const visible = pageVisible();
    const hot = visible && document.getElementById("live").classList.contains("active");
    const started = performance.now();
    const recording = visible && state.recording && fn !== pollStatus;
    if (fn === pollStatus || hot || recording) {
      try { await fn(); } catch (err) { /* the poll itself reports a miss */ }
    }
    const spent = performance.now() - started;
    setTimeout(tick, Math.max(50, pickMs(hot) - spent));
  };
  tick();
}

function renderNoise() {
  const noise = state.noise;
  const live = $("noiseLive");
  const box = $("calLevels");
  const note = $("calResult");
  const gateBtn = $("calGate");
  const clearBtn = $("calClear");
  if (!box) return;
  if (!noise || !Number.isFinite(noise.rss)) {
    if (live) live.textContent = "";
    box.hidden = true;
    if (note) note.textContent = "";
    if (gateBtn) gateBtn.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    return;
  }
  const scale = displayScale("accel");
  const digits = scale === 1 ? 4 : 2;
  const unit = unitName("accel");
  $("calRss").textContent = fmt(noise.rss * scale, digits);
  $("calX").textContent = fmt(noise.x * scale, digits);
  $("calY").textContent = fmt(noise.y * scale, digits);
  $("calZ").textContent = fmt(noise.z * scale, digits);
  document.querySelectorAll(".cal-unit, #calUnit").forEach((el) => { el.textContent = unit; });
  box.hidden = false;
  if (gateBtn) gateBtn.hidden = false;
  if (clearBtn) clearBtn.hidden = false;
  if (note) {
    note.textContent = noise.rss > 0.02
      ? "That is high for a sensor sitting still. Put the Stick on the floor again and measure."
      : "Quiet reading, 8 seconds. The gate can use this RSS.";
  }
  if (live) live.textContent = "Noise floor " + fmt(noise.rss * scale, digits) + " " + unit;
}

function loadNoise() {
  try {
    const saved = JSON.parse(localStorage.getItem("tremble-noise") || "null");
    if (saved && Number.isFinite(saved.rss)) state.noise = saved;
  } catch (err) {
    state.noise = null;
  }
  renderNoise();
}

async function restoreCaptureSeconds() {
  const seconds = state.calRestoreSeconds;
  state.calRestoreSeconds = null;
  if (seconds == null) return;
  try {
    await post("/api/settings", {
      rate: $("rate").value,
      range: $("range").value,
      seconds: seconds || "0",
      gyro: $("gyro").checked ? "1" : "0",
    });
  } catch (err) { /* the next Apply sends the duration again */ }
}

async function finishCalibration() {
  state.calibrating = false;
  try {
    const res = await fetch("/api/capture.vibe");
    if (!res.ok) throw new Error("The noise reading did not come back.");
    const parsed = VibeDSP.parseVibe(await res.arrayBuffer());
    const result = VibeDSP.processCapture(parsed, {
      highpassHz: 0.5,
      lowpassHz: 0,
      quantity: "accel",
      displacement: false,
      axes: [axisSpec("mapX"), axisSpec("mapY"), axisSpec("mapZ")],
    });
    const block = result.metrics && result.metrics.accel;
    if (!block || !Number.isFinite(block.rss)) throw new Error("That reading was too short. Leave it still and measure again.");
    state.noise = {
      rss: block.rss,
      x: block.x.rms,
      y: block.y.rms,
      z: block.z.rms,
      rate: parsed.sampleRate,
      range: parsed.rangeG,
    };
    localStorage.setItem("tremble-noise", JSON.stringify(state.noise));
    renderNoise();
    banner(state.noise.rss > 0.02
      ? "That floor reading is high. The Stick may have moved. Set it down and measure again."
      : "Noise floor saved from the floor reading.", true);
  } catch (err) {
    banner(err.message, false);
  }
  await restoreCaptureSeconds();
}

async function measureNoise() {
  if (state.busy || state.recording) return;
  state.busy = true;
  state.calibrating = true;
  state.calRestoreSeconds = $("seconds").value;
  if ($("calStart")) $("calStart").disabled = true;
  try {
    await post("/api/settings", {
      rate: $("rate").value,
      range: $("range").value,
      seconds: "8",
      gyro: "0",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await post("/api/record", { action: "start" });
    banner("Measuring noise. Leave the Stick on the floor. Do not touch it.", false);
    await pollStatus();
  } catch (err) {
    state.calibrating = false;
    banner(err.message, false);
    await restoreCaptureSeconds();
  } finally {
    state.busy = false;
  }
}

async function toggleRecord() {
  if (state.busy) return;
  state.busy = true;
  $("recBtn").disabled = true;
  try {
    if (!state.recording) {
      const s = state.status;
      const same = s && String(s.sampleRate) === String($("rate").value)
        && String(s.rangeG) === String($("range").value)
        && String(s.durationSec) === String($("seconds").value || "0")
        && !!s.gyro === !!$("gyro").checked;
      if (!same) {
        await applySettings();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await post("/api/record", { action: "start" });
      banner("Recording. Leave the Stick alone until this finishes.", false);
    } else {
      await post("/api/record", { action: "stop" });
    }
    await pollStatus();
  } catch (err) {
    banner(stickDown(err) || "Could not start the recording.", false);
  } finally {
    state.busy = false;
    syncApplyBtn();
  }
}

function usePreset(name) {
  const preset = PRESETS[name];
  $("rate").value = preset.rate;
  $("range").value = preset.range;
  $("seconds").value = preset.seconds;
  $("hp").value = preset.hp;
  $("lp").value = preset.lp;
  saveUi();
  syncApplyBtn();
  if (state.parsed) runAnalysis();
}

function stickDown(err) {
  const msg = err && err.message ? err.message : "";
  if (!msg || err.name === "TypeError" || msg === "Failed to fetch" || msg === "Load failed") {
    return "The Stick did not answer. Check the list in a moment.";
  }
  return msg;
}

function selectedFileNames() {
  return [...document.querySelectorAll("#fileList .file-pick input:checked")].map((box) => box.value);
}

function syncFileTools() {
  const boxes = [...document.querySelectorAll("#fileList .file-pick input")];
  const picked = boxes.filter((box) => box.checked).length;
  boxes.forEach((box) => { box.disabled = state.fileBusy; });
  document.querySelectorAll("#fileList button").forEach((btn) => { btn.disabled = state.fileBusy; });
  const del = $("fileDelete");
  if (del) del.disabled = state.fileBusy || picked === 0;
  const all = $("fileAll");
  if (all) {
    all.checked = boxes.length > 0 && picked === boxes.length;
    all.disabled = state.fileBusy || boxes.length === 0;
  }
  if ($("analyzeSave")) $("analyzeSave").disabled = state.fileBusy;
}

/* --- Stick file list (ETag avoids rebuilding the DOM when nothing changed) --- */

async function refreshFiles() {
  const headers = {};
  if (state.filesEtag) headers["If-None-Match"] = state.filesEtag;
  const res = await fetch("/api/files", { headers, cache: "no-store" });
  if (res.status === 304) {
    syncFileTools();
    return;
  }
  if (!res.ok) {
    syncFileTools();
    return;
  }
  const etag = res.headers.get("ETag");
  if (etag) state.filesEtag = etag;
  const data = await res.json();
  const pct = data.total ? (100 * data.used) / data.total : 0;
  $("usedBar").style.width = pct.toFixed(1) + "%";
  $("usedText").textContent = `${(data.used / 1024).toFixed(0)} KB used of ${(data.total / 1024).toFixed(0)} KB`;
  const list = $("fileList");
  list.innerHTML = "";
  if (!data.files.length) {
    list.innerHTML = "<li>No files saved on the Stick yet.</li>";
    syncFileTools();
    return;
  }
  data.files.forEach((file) => {
    const li = document.createElement("li");
    const pick = document.createElement("label");
    pick.className = "check file-pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = file.name;
    box.addEventListener("change", syncFileTools);
    const name = document.createElement("span");
    name.textContent = `${file.name}.vibe · ${(file.bytes / 1024).toFixed(0)} KB`;
    pick.append(box, name);
    const actions = document.createElement("span");
    actions.className = "file-actions";
    const open = document.createElement("button");
    open.className = "ghost";
    open.type = "button";
    open.textContent = "Open";
    open.addEventListener("click", async () => {
      if (state.fileBusy) return;
      try {
        const response = await fetch("/api/files/get?name=" + encodeURIComponent(file.name), { cache: "no-store" });
        const bytes = await response.arrayBuffer();
        if (!response.ok) {
          let detail = "";
          try { detail = JSON.parse(new TextDecoder().decode(bytes)).error || ""; } catch (err) { /* binary or empty */ }
          throw new Error(detail || ("Could not open that file (" + response.status + ")"));
        }
        if (bytes.byteLength < 64) {
          throw new Error("That capture came back empty. Flash the Stick and try Open again.");
        }
        const head = new Uint8Array(bytes, 0, 4);
        const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
        if (magic !== "VIBE") throw new Error("That file is not a Tremble capture");
        await loadBuffer(bytes, file.name + ".vibe");
        showTab("analyze");
      } catch (err) {
        banner(stickDown(err) || "Could not open that file", false);
      }
    });
    const del = document.createElement("button");
    del.className = "ghost";
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteCaptures([file.name]));
    actions.append(open, del);
    li.append(pick, actions);
    list.appendChild(li);
  });
  syncFileTools();
}

async function deleteCaptures(names) {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length || state.fileBusy) return;
  const label = unique.length === 1 ? unique[0] : unique.length + " files";
  if (!confirm("Delete " + label + "?")) return;
  state.fileBusy = true;
  syncFileTools();
  banner("Deleting " + label + "…", false);
  try {
    const body = new URLSearchParams();
    unique.forEach((name) => body.append("name", name));
    const res = await fetch("/api/files/delete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "Could not delete");
    state.filesEtag = "";
    banner(unique.length === 1 ? "Deleted " + unique[0] + "." : "Deleted " + unique.length + " files.", true);
  } catch (err) {
    banner(stickDown(err), false);
  } finally {
    state.fileBusy = false;
    try { await refreshFiles(); } catch (err) { syncFileTools(); }
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/* --- Browser-side exports (no server round trip beyond opening captures) --- */

function exportCsv() {
  const result = state.result;
  const parsed = state.parsed;
  if (!result || !parsed) return;
  const scale = 1 / result.lsbPerG;
  const lines = [
    `# Tremble sample_rate_hz=${result.sampleRate} highpass_hz=${result.highpassHz} lowpass_hz=${result.lowpassHz} ema=${result.emaAlpha || result.emaSeconds || 0} gate_g=${result.gate || 0} range_g=${parsed.rangeG} units=${usesUs() ? "us" : "metric"}`,
    "time_s,ax_g,ay_g,az_g,ax_filtered_g,ay_filtered_g,az_filtered_g,vx_mms,vy_mms,vz_mms" + (result.gyro ? ",gx_dps,gy_dps,gz_dps" : ""),
  ];
  const chunks = [lines.join("\n") + "\n"];
  let batch = [];
  for (let i = 0; i < parsed.count; i++) {
    const t = i / result.sampleRate;
    const stride = parsed.channels === 6 ? 6 : 3;
    const ax = parsed.samples[i * stride] * scale;
    const ay = parsed.samples[i * stride + 1] * scale;
    const az = parsed.samples[i * stride + 2] * scale;
    const gyro = result.gyro
      ? "," + [result.gyro.x[i], result.gyro.y[i], result.gyro.z[i]].map((v) => v.toFixed(3)).join(",")
      : "";
    batch.push([
      t.toFixed(6), ax.toFixed(6), ay.toFixed(6), az.toFixed(6),
      result.dynamic.x[i].toFixed(6), result.dynamic.y[i].toFixed(6), result.dynamic.z[i].toFixed(6),
      result.velocity.x[i].toFixed(4), result.velocity.y[i].toFixed(4), result.velocity.z[i].toFixed(4),
    ].join(",") + gyro);
    if (batch.length === 2000) {
      chunks.push(batch.join("\n") + "\n");
      batch = [];
    }
  }
  if (batch.length) chunks.push(batch.join("\n") + "\n");
  downloadBlob(new Blob(chunks, { type: "text/csv" }), `tremble-${stamp()}.csv`);
}

function exportSpectrum() {
  const spec = state.result && state.result.spectrum;
  if (!spec) return;
  const fmax = state.result.lowpassHz || state.result.sampleRate * 0.45;
  const rows = [`frequency_hz,x,y,z,combined,unit_${unitName()}`];
  for (let k = 0; k < spec.x.length; k++) {
    const hz = k * spec.df;
    if (hz > fmax) break;
    rows.push([hz.toFixed(4), spec.x[k], spec.y[k], spec.z[k], spec.rss[k]].join(","));
  }
  downloadBlob(new Blob([rows.join("\n")], { type: "text/csv" }), `tremble-spectrum-${stamp()}.csv`);
}

function exportJson() {
  if (!state.result) return;
  const r = state.result;
  const slim = {
    sampleRate: r.sampleRate,
    count: r.count,
    highpassHz: r.highpassHz,
    lowpassHz: r.lowpassHz,
    vertical: r.vertical,
    means: r.means,
    metrics: r.metrics,
    peaks: r.peaks,
    resonance: r.resonance,
    emaSeconds: r.emaSeconds,
    gyro: r.metrics.gyro || null,
    notes: r.notes,
  };
  downloadBlob(new Blob([JSON.stringify(slim, null, 2)], { type: "application/json" }), `tremble-${stamp()}.json`);
}

function exportFea() {
  if (!state.result) return;
  if (!state.result.displacement) {
    $("displacement").checked = true;
    runAnalysis();
  }
  const current = state.result;
  const disp = current && current.displacement;
  if (!disp) {
    banner("This capture is too short for a displacement export.", false);
    return;
  }
  const k = displayScale("displacement");
  const unit = unitName("displacement");
  const looked = VibeDSP.spectrumSet(disp, current.sampleRate, current.highpassHz, current.lowpassHz);
  const chunks = [`# Tremble FEA\n# displacement unit ${unit}\n# sample_rate_hz=${current.sampleRate} highpass_hz=${current.highpassHz}\ntime_s,x,y,z,rss\n`];
  let batch = [];
  for (let i = 0; i < disp.x.length; i++) {
    const x = disp.x[i] * k;
    const y = disp.y[i] * k;
    const z = disp.z[i] * k;
    batch.push([(i / current.sampleRate).toFixed(6), x.toExponential(6), y.toExponential(6), z.toExponential(6), Math.hypot(x, y, z).toExponential(6)].join(","));
    if (batch.length === 2000) {
      chunks.push(batch.join("\n") + "\n");
      batch = [];
    }
  }
  if (batch.length) chunks.push(batch.join("\n") + "\n");
  const amp = looked.spectrum;
  const fmax = current.lowpassHz || current.sampleRate * 0.45;
  const specRows = ["\n# spectrum, same displacement unit\nfrequency_hz,x,y,z,rss\n"];
  for (let i = 1; i < amp.x.length; i++) {
    const hz = i * amp.df;
    if (hz > fmax) break;
    specRows.push([hz.toFixed(4), (amp.x[i] * k).toExponential(6), (amp.y[i] * k).toExponential(6), (amp.z[i] * k).toExponential(6), (amp.rss[i] * k).toExponential(6)].join(","));
  }
  chunks.push(specRows.join("\n") + "\n");
  downloadBlob(new Blob(chunks, { type: "text/csv" }), `tremble-fea-${stamp()}.csv`);
}

let crcTable = null;

function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Minimal ZIP store for Word report packaging (DOCX is OPC zip). */
function zipStore(files) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  files.forEach((file) => {
    const name = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, data);
    const head = new Uint8Array(46 + name.length);
    const dir = new DataView(head.buffer);
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    head.set(name, 46);
    central.push(head);
    offset += local.length + data.length;
  });
  const dirBytes = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, files.length, true);
  tail.setUint16(10, files.length, true);
  tail.setUint32(12, dirBytes, true);
  tail.setUint32(16, offset, true);
  return new Blob([...locals, ...central, end], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function xmlEscape(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function docParagraph(text, opts) {
  const style = opts || {};
  const bold = style.bold ? "<w:b/>" : "";
  const size = style.size ? `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>` : "";
  const color = style.color ? `<w:color w:val="${style.color}"/>` : "";
  return `<w:p><w:r><w:rPr>${bold}${size}${color}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function docTable(rows) {
  const border = (edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="C5CED8"/>`;
  const borders = `<w:tblBorders>${border("top")}${border("left")}${border("bottom")}${border("right")}${border("insideH")}${border("insideV")}</w:tblBorders>`;
  const body = rows.map((row, index) => {
    const cells = row.map((cell) => {
      const bold = index === 0 ? "<w:b/>" : "";
      return `<w:tc><w:p><w:r><w:rPr>${bold}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEscape(cell)}</w:t></w:r></w:p></w:tc>`;
    }).join("");
    return `<w:tr>${cells}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${borders}</w:tblPr>${body}</w:tbl>`;
}

function docImage(relId, name, cx, cy, docId) {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${cx}" cy="${cy}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:docPr id="${docId}" name="${xmlEscape(name)}"/>
    <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
      <pic:nvPicPr><pic:cNvPr id="${docId}" name="${xmlEscape(name)}"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
    </pic:pic></a:graphicData></a:graphic>
  </wp:inline></w:drawing></w:r></w:p>`;
}

function scaledMetric(block, quantity) {
  if (!block || !Number.isFinite(block.rss)) return null;
  const k = displayScale(quantity);
  if (k === 1) return block;
  const one = (item) => item && {
    rms: item.rms * k,
    peak: item.peak * k,
    peakToPeak: item.peakToPeak * k,
    crest: item.crest,
  };
  return { x: one(block.x), y: one(block.y), z: one(block.z), rss: block.rss * k };
}

function metricRows(block, digits) {
  const cell = (item, key) => (item ? fmt(item[key], key === "crest" ? 2 : digits) : "");
  const line = (name, item) => [name, cell(item, "rms"), cell(item, "peak"), cell(item, "peakToPeak"), cell(item, "crest")];
  return [
    ["", "RMS", "Peak", "Pk-Pk", "Crest"],
    line("X", block.x),
    line("Y", block.y),
    line("Z", block.z),
    ["RSS", fmt(block.rss, digits), "", "", ""],
  ];
}

async function chartPng(draw, width, height) {
  const fake = document.createElement("canvas");
  fake.style.width = width + "px";
  fake.style.height = height + "px";
  fake.style.position = "fixed";
  fake.style.left = "-4000px";
  document.body.appendChild(fake);
  draw(fake);
  const blob = await new Promise((resolve) => fake.toBlob(resolve, "image/png"));
  fake.remove();
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportDocx() {
  const result = state.result;
  const series = selectedSeries();
  if (!result || !series || !result.spectrum) {
    banner("Open a capture before writing the report.", false);
    return;
  }
  const view = viewWindow();
  const scale = chartScale();
  const unit = unitName();
  const show = channelShow();
  const quantity = result.quantity || "accel";
  const when = state.parsed && state.parsed.epoch
    ? new Date(state.parsed.epoch * 1000).toISOString()
    : new Date().toISOString();
  const seconds = result.sampleRate > 0 ? result.count / result.sampleRate : 0;
  const parts = [];
  parts.push(docParagraph("Tremble", { bold: true, size: 36, color: "142033" }));
  parts.push(docParagraph("Vibration report", { size: 28, color: "415066" }));
  parts.push(docParagraph(when, { size: 20, color: "66788C" }));
  if (state.source) parts.push(docParagraph(state.source, { size: 20, color: "66788C" }));
  parts.push(docParagraph("Capture", { bold: true, size: 28 }));
  const facts = [
    result.sampleRate + " Hz, " + result.count + " samples, " + fmt(seconds, 2) + " s",
    "Range ±" + ((state.parsed && state.parsed.rangeG) || "?") + " g",
    "High-pass " + result.highpassHz + " Hz, low-pass " + (result.lowpassHz || "off"),
    "View " + quantityLabel(quantity).toLowerCase() + ", " + (usesUs() ? "US units" : "metric units"),
  ];
  if (result.gate) facts.push("Noise gate " + fmt(result.gate, 3) + " g");
  if (result.emaAlpha) facts.push("EMA weight " + result.emaAlpha);
  if (result.vertical) facts.push("Gravity sits mostly on " + result.vertical + " (means " + result.means.map((v) => fmt(v, 3)).join(", ") + " g).");
  if (state.focus) facts.push("The numbers below use the window on screen, " + state.focus.count + " samples.");
  facts.forEach((line) => parts.push(docParagraph(line, { size: 22 })));

  const blocks = [
    ["Acceleration", scaledMetric(state.focus && state.focus.metrics ? state.focus.metrics.accel : result.metrics.accel, "accel"), usesUs() ? 3 : 4, unitName("accel")],
    ["Velocity", scaledMetric(result.metrics.velocity, "velocity"), 3, unitName("velocity")],
    ["Displacement", scaledMetric(result.metrics.displacement, "displacement"), usesUs() ? 5 : 2, unitName("displacement")],
    ["Gyroscope", result.metrics.gyro, 2, "dps"],
  ];
  if (state.focus && state.focus.series && quantity !== "accel" && quantity !== "gyro") {
    const names = { velocity: "Velocity", displacement: "Displacement" };
    const match = blocks.find((item) => item[0] === names[quantity]);
    if (match) match[1] = scaledMetric(blockFromSeries(state.focus.series), quantity);
  }
  blocks.forEach((item) => {
    if (!item[1]) return;
    parts.push(docParagraph(item[0] + " (" + item[3] + ")", { bold: true, size: 26 }));
    parts.push(docTable(metricRows(item[1], item[2])));
  });

  const peakList = (state.focus && state.focus.peaks) || result.peaks || [];
  parts.push(docParagraph("Peaks", { bold: true, size: 28 }));
  if (peakList.length) {
    peakList.forEach((peak) => {
      parts.push(docParagraph(fmt(peak.hz, 2) + " Hz, " + fmt(peak.amp * displayScale(quantity), 4) + " " + unit, { size: 22 }));
    });
  } else parts.push(docParagraph("No distinct peaks.", { size: 22 }));

  const resonance = (state.focus && state.focus.resonance) || result.resonance;
  if (resonance) {
    parts.push(docParagraph("Resonance", { bold: true, size: 28 }));
    parts.push(docParagraph(
      "Natural frequency " + fmt(resonance.hz, 2) + " Hz. Half-power bandwidth " + fmt(resonance.bandwidthHz, 2)
      + " Hz. Damping ratio " + fmt(resonance.damping, 3) + ". Q " + fmt(resonance.q, 1) + ".",
      { size: 22 }
    ));
  }
  if (state.baseline) {
    const base = state.baseline;
    parts.push(docParagraph("Baseline", { bold: true, size: 28 }));
    parts.push(docParagraph("Baseline " + (base.label || "capture") + ": " + fmt(base.hz, 2) + " Hz, RSS " + fmt(base.rss, 4) + " g.", { size: 22 }));
    if (resonance && base.hz && base.amp) {
      parts.push(docParagraph(
        "Frequency change " + fmt(resonance.hz - base.hz, 2) + " Hz. Amplitude change "
        + fmt(100 * (resonance.amp - base.amp) / base.amp, 1) + "%. Damping change " + fmt(resonance.damping - base.damping, 3) + ".",
        { size: 22 }
      ));
    }
  }
  if (result.notes && result.notes.length) {
    parts.push(docParagraph("Notes", { bold: true, size: 28 }));
    result.notes.forEach((note) => parts.push(docParagraph(note, { size: 22 })));
  }

  const fs = result.sampleRate || 1;
  let wave = series;
  let raw = result.raw;
  let t0 = 0;
  let sampleStart = 0;
  let sampleCount = series.x ? series.x.length : 0;
  if (view && series.x && fs > 0) {
    const a = Math.max(0, Math.min(series.x.length, Math.round(view.zoom0 * fs)));
    const b = Math.max(a, Math.min(series.x.length, Math.round(view.zoom1 * fs)));
    sampleStart = a;
    sampleCount = b - a;
    if (a > 0 || b < series.x.length) {
      const cut = (src) => src && src.x ? {
        x: src.x.subarray(a, b),
        y: src.y ? src.y.subarray(a, b) : src.y,
        z: src.z ? src.z.subarray(a, b) : src.z,
      } : src;
      wave = cut(series);
      raw = cut(result.raw);
      t0 = view.zoom0;
    }
  }
  const spectrum = state.focus ? state.focus.spectrum : result.spectrum;
  const windowAt = view && view.windowed ? [view.start, Math.min(view.dur, view.start + view.span)] : null;
  const picture = spectrogramSeries(series, sampleStart, sampleCount);
  const shots = [
    ["wave.png", "Waveform", () => chartPng((fake) => drawWave(fake, wave, fs, show, {
      under: raw, windowAt, t0,
      title: quantityLabel(quantity) + " waveform",
      yTitle: quantityLabel(quantity) + " (" + unit + ")",
      yMin: scale.yMin, yMax: scale.yMax, gain: displayScale(quantity), grid: scale.grid,
    }), 1320, 420)],
    ["spectrum.png", "Spectrum", () => chartPng((fake) => drawSpectrum(fake, spectrum, $("logSpec").checked, show, {
      title: quantityLabel(quantity) + " spectrum",
      yTitle: "Amplitude (" + unit + ")",
      fMin: scale.fMin, fMax: scale.fMax, yMax: scale.specMax,
      gain: displayScale(quantity), logF: $("logF") && $("logF").checked, grid: scale.grid,
      autoPeaks: analyzePeakMarks(spectrum, show, scale),
    }), 1320, 420)],
  ];
  if (picture) {
    shots.push(["spectrogram.png", "Spectrogram", () => chartPng((fake) => drawSpectrogram(fake, picture, {
      title: "Spectrogram, RSS", t0, windowAt,
      fMin: scale.fMin, fMax: scale.fMax, logF: $("logF") && $("logF").checked, grid: scale.grid,
    }), 1320, 280)]);
    shots.push(["campbell.png", "Mode tracks", () => chartPng((fake) => drawCampbell(fake, picture, {
      t0, windowAt, fMin: scale.fMin, fMax: scale.fMax,
      logF: $("logF") && $("logF").checked, grid: scale.grid,
    }), 1320, 320)]);
  }
  parts.push(docParagraph("Charts", { bold: true, size: 28 }));
  const images = [];
  for (let i = 0; i < shots.length; i++) {
    const png = await shots[i][2]();
    const rel = "rId" + (10 + i);
    const cx = 6858000;
    const cy = Math.round(cx * (shots[i][0].indexOf("spectro") >= 0 ? 280 : shots[i][0].indexOf("campbell") >= 0 ? 320 : 420) / 1320);
    parts.push(docParagraph(shots[i][1], { bold: true, size: 24 }));
    parts.push(docImage(rel, shots[i][0], cx, cy, i + 1));
    images.push({ name: "word/media/" + shots[i][0], data: png, rel, file: shots[i][0] });
  }
  parts.push(docParagraph(
    "BMI270 on an M5Stack StickS3. This is a screening plot, not a calibrated vibration certificate.",
    { size: 18, color: "66788C" }
  ));
  parts.push(docParagraph("Copyright 2026 José Miranda. MIT license.", { size: 18, color: "66788C" }));
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${parts.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${images.map((image) => `<Relationship Id="${image.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.file}"/>`).join("")}
</Relationships>`;
  const enc = new TextEncoder();
  const files = [
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`) },
    { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(rels) },
  ];
  images.forEach((image) => files.push({ name: image.name, data: image.data }));
  downloadBlob(zipStore(files), `tremble-${stamp()}.docx`);
}

function exportPng() {
  const result = state.result;
  const series = selectedSeries();
  if (!result || !series || !result.spectrum) return;
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = 980;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 1400, 980);
  ctx.fillStyle = "#142033";
  ctx.font = "bold 32px Segoe UI, sans-serif";
  ctx.fillText("Tremble", 40, 52);
  ctx.font = "16px Segoe UI, sans-serif";
  ctx.fillStyle = "#415066";
  const when = state.parsed.epoch ? new Date(state.parsed.epoch * 1000).toISOString() : new Date().toISOString();
  ctx.fillText(`${when}   ${result.sampleRate} Hz   ${result.count} samples   HP ${result.highpassHz} Hz   LP ${result.lowpassHz || "off"}`, 40, 80);
  const m = result.metrics.accel;
  const v = result.metrics.velocity;
  ctx.fillStyle = "#142033";
  ctx.fillText(`Accel RSS RMS ${fmt(m.rss, 4)} g    Velocity RSS RMS ${fmt(v.rss, 3)} mm/s    Vertical ${result.vertical}`, 40, 112);
  if (result.peaks && result.peaks[0]) {
    ctx.fillText(`Largest peak ${fmt(result.peaks[0].hz, 2)} Hz at ${fmt(result.peaks[0].amp, 4)} ${unitName()}`, 40, 136);
  }
  const view = viewWindow();
  const scale = chartScale();
  const unit = unitName();
  const mount = (draw) => {
    const fake = document.createElement("canvas");
    fake.style.width = "1320px";
    fake.style.height = "320px";
    fake.style.position = "fixed";
    fake.style.left = "-4000px";
    document.body.appendChild(fake);
    draw(fake);
    return fake;
  };
  const waveShot = mount((fake) => drawWave(fake, series, result.sampleRate, channelShow(), {
    under: result.raw,
    t0: view && view.span ? view.start : 0,
    title: quantityLabel(result.quantity) + " waveform",
    yTitle: quantityLabel(result.quantity) + " (" + unit + ")",
    yMin: scale.yMin,
    yMax: scale.yMax,
    grid: scale.grid,
    marks: chartMarks.waveCanvas,
  }));
  ctx.drawImage(waveShot, 40, 160, 1320, 320);
  waveShot.remove();
  const specShot = mount((fake) => drawSpectrum(fake, result.spectrum, $("logSpec").checked, channelShow(), {
    title: quantityLabel(result.quantity) + " spectrum",
    yTitle: "Amplitude (" + unit + ")",
    fMin: scale.fMin,
    fMax: scale.fMax,
    yMax: scale.specMax,
    grid: scale.grid,
    marks: chartMarks.specCanvas,
    autoPeaks: analyzePeakMarks(result.spectrum, channelShow(), scale),
  }));
  ctx.drawImage(specShot, 40, 500, 1320, 320);
  specShot.remove();
  ctx.fillStyle = "#66788c";
  ctx.font = "14px Segoe UI, sans-serif";
  ctx.fillText("BMI270 on M5Stack StickS3. Screening plot, not a calibrated vibration certificate.", 40, 950);
  canvas.toBlob((blob) => downloadBlob(blob, `tremble-${stamp()}.png`));
}

/* --- Chart marks, axis editor, and expand modal --- */

function marksFor(canvas, extra) {
  if (extra && extra.marks) return extra.marks;
  if (!canvas.id) return null;
  return chartMarks[canvas.id] || null;
}

function chosenKey(canvas, extra, keys) {
  const marks = marksFor(canvas, extra);
  if (marks && keys.indexOf(marks.selected) >= 0) return marks.selected;
  return "";
}

function clearChartMarks(id) {
  const marks = chartMarks[id];
  if (!marks) return;
  marks.points = [];
  marks.activePoint = 0;
  marks.selected = "";
}

function pointInBox(p, box) {
  return p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
}

function ensureMarks(id) {
  if (!chartMarks[id]) chartMarks[id] = { selected: "", points: [], hover: null, activePoint: 0 };
  return chartMarks[id];
}

function hitMark(probe, marks, p) {
  let best = null;
  marks.points.forEach((pt) => {
    if (probe.keys.indexOf(pt.key) < 0) return;
    const hit = probe.sample(pt.key, pt.x);
    if (!hit) return;
    const d = Math.hypot(hit.pixelX - p.x, hit.pixelY - p.y);
    if (d <= 12 && (!best || d < best.d)) best = { d, pt };
  });
  return best && best.pt;
}

function nearestKey(probe, p) {
  const dataX = probe.frame.xFrom(p.x);
  let best = null;
  probe.keys.forEach((key) => {
    const span = probe.spanAt ? probe.spanAt(key, dataX) : null;
    const hit = probe.sample(key, dataX);
    if (!hit) return;
    const y0 = span ? span.y0 : hit.pixelY;
    const y1 = span ? span.y1 : hit.pixelY;
    const top = Math.min(y0, y1);
    const bot = Math.max(y0, y1);
    const d = p.y >= top && p.y <= bot ? 0 : Math.min(Math.abs(p.y - top), Math.abs(p.y - bot));
    if (!best || d < best.d) best = { key, d };
  });
  return best;
}

function paintMarks(ctx, probe, marks) {
  if (!marks || !probe) return;
  const frame = probe.frame;
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.box.left, frame.box.top, frame.plotW, frame.plotH);
  ctx.clip();
  ctx.lineWidth = 1;
  if (marks.hover && pointInBox(marks.hover, frame.box)) {
    ctx.strokeStyle = "rgba(201,211,226,0.45)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(marks.hover.x, frame.box.top);
    ctx.lineTo(marks.hover.x, frame.box.bottom);
    ctx.moveTo(frame.box.left, marks.hover.y);
    ctx.lineTo(frame.box.right, marks.hover.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const dataX = frame.xFrom(marks.hover.x);
    probe.keys.forEach((key) => {
      const hit = probe.sample(key, dataX);
      if (!hit) return;
      ctx.fillStyle = COLORS[key];
      ctx.beginPath();
      ctx.arc(hit.pixelX, hit.pixelY, key === marks.selected ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  marks.points.forEach((pt) => {
    if (probe.keys.indexOf(pt.key) < 0) return;
    const hit = probe.sample(pt.key, pt.x);
    if (!hit) return;
    const on = marks.activePoint === pt.id;
    ctx.fillStyle = COLORS[pt.key];
    ctx.strokeStyle = on ? "#f7f1e3" : "#121820";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hit.pixelX, hit.pixelY, on ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const text = probe.pointLabel(hit);
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const width = ctx.measureText(text).width + 8;
    const tx = Math.min(Math.max(frame.box.left + 2, hit.pixelX + 8), frame.box.right - width - 2);
    const ty = Math.max(frame.box.top + 16, hit.pixelY - 6);
    ctx.fillStyle = "rgba(18,24,32,0.88)";
    ctx.fillRect(tx - 2, ty - 14, width, 16);
    ctx.fillStyle = COLORS[pt.key];
    ctx.fillText(text, tx + 2, ty);
  });
  ctx.restore();
  if (marks.hover && pointInBox(marks.hover, frame.box)) {
    const dataX = frame.xFrom(marks.hover.x);
    const parts = [];
    probe.keys.forEach((key) => {
      const hit = probe.sample(key, dataX);
      if (!hit) return;
      const name = key === "rss" ? "RSS" : key.toUpperCase();
      parts.push(name + " " + tickLabel(hit.v));
    });
    if (parts.length) {
      const text = (probe.kind === "wave" ? tickLabel(dataX) + " s" : tickLabel(dataX) + " Hz") + "   " + parts.join("   ");
      ctx.font = "12px Segoe UI, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const width = ctx.measureText(text).width + 10;
      ctx.fillStyle = "rgba(18,24,32,0.9)";
      ctx.fillRect(frame.box.left + 6, frame.box.top + 6, Math.min(width, frame.plotW - 12), 18);
      ctx.fillStyle = "#e7edf5";
      ctx.fillText(text, frame.box.left + 10, frame.box.top + 8);
    }
  }
}

function bindChart(canvas) {
  if (!canvas || canvas.dataset.bound) return;
  canvas.dataset.bound = "1";
  const at = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const probe = chartProbes[canvas.id];
    if (!probe) return;
    const marks = ensureMarks(canvas.id);
    const pt = hitMark(probe, marks, at(event));
    if (!pt) return;
    chartDrag = { id: canvas.id, pointId: pt.id, moved: false };
    marks.activePoint = pt.id;
    marks.selected = pt.key;
    chartHoverId = canvas.id;
    canvas.setPointerCapture(event.pointerId);
    const redraw = chartRedraw[canvas.id];
    if (redraw) redraw();
  });
  canvas.addEventListener("pointermove", (event) => {
    const p = at(event);
    const probe = chartProbes[canvas.id];
    if (!probe) {
      canvas.style.cursor = axisAt(canvas, p) ? "pointer" : "crosshair";
      return;
    }
    const marks = ensureMarks(canvas.id);
    chartHoverId = canvas.id;
    if (chartDrag && chartDrag.id === canvas.id) {
      const pt = marks.points.find((item) => item.id === chartDrag.pointId);
      if (pt) {
        pt.x = probe.frame.xFrom(p.x);
        chartDrag.moved = true;
      }
      canvas.style.cursor = "grabbing";
    } else if (axisAt(canvas, p)) {
      marks.hover = null;
      canvas.style.cursor = "pointer";
    } else {
      marks.hover = p;
      canvas.style.cursor = hitMark(probe, marks, p) ? "grab" : "crosshair";
    }
    const redraw = chartRedraw[canvas.id];
    if (redraw) redraw();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (chartDrag && chartDrag.id === canvas.id && chartDrag.moved) chartSkipClick = true;
    chartDrag = null;
    const p = at(event);
    canvas.style.cursor = axisAt(canvas, p) ? "pointer" : "crosshair";
  });
  canvas.addEventListener("pointerleave", () => {
    if (chartDrag && chartDrag.id === canvas.id) return;
    const marks = chartMarks[canvas.id];
    if (marks) marks.hover = null;
    if (chartHoverId === canvas.id) chartHoverId = "";
    canvas.style.cursor = "crosshair";
    const redraw = chartRedraw[canvas.id];
    if (redraw) redraw();
  });
  canvas.addEventListener("click", (event) => {
    const p = at(event);
    if (openAxisEditor(canvas, p)) return;
    if (chartSkipClick) {
      chartSkipClick = false;
      return;
    }
    const probe = chartProbes[canvas.id];
    if (!probe) return;
    const marks = ensureMarks(canvas.id);
    chartHoverId = canvas.id;
    const legend = (probe.frame.legendHits || []).find((hit) => p.x >= hit.x && p.x <= hit.x + hit.w && p.y >= hit.y && p.y <= hit.y + hit.h);
    if (legend) {
      marks.selected = marks.selected === legend.key ? "" : legend.key;
      marks.activePoint = 0;
      chartRedraw[canvas.id]();
      return;
    }
    if (!pointInBox(p, probe.frame.box)) return;
    const existing = hitMark(probe, marks, p);
    if (existing) {
      marks.activePoint = existing.id;
      marks.selected = existing.key;
      chartRedraw[canvas.id]();
      return;
    }
    const near = nearestKey(probe, p);
    if (near && near.d <= 12 && near.key !== marks.selected) {
      marks.selected = near.key;
      marks.activePoint = 0;
      chartRedraw[canvas.id]();
      return;
    }
    const key = marks.selected && probe.keys.indexOf(marks.selected) >= 0
      ? marks.selected
      : ((near && near.key) || probe.keys[0]);
    if (!key) return;
    marks.selected = key;
    const snapped = probe.sample(key, probe.frame.xFrom(p.x));
    if (!snapped) return;
    const dup = marks.points.find((pt) => {
      if (pt.key !== key) return false;
      const hit = probe.sample(pt.key, pt.x);
      return hit && Math.hypot(hit.pixelX - snapped.pixelX, hit.pixelY - snapped.pixelY) < 10;
    });
    if (dup) {
      marks.activePoint = dup.id;
    } else if (marks.points.length < 16) {
      const id = markSeq++;
      marks.points.push({ id, key, x: snapped.dataX });
      marks.activePoint = id;
    }
    chartRedraw[canvas.id]();
  });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const probe = chartProbes[canvas.id];
    if (!probe) return;
    const marks = ensureMarks(canvas.id);
    const existing = hitMark(probe, marks, at(event));
    if (!existing) return;
    marks.points = marks.points.filter((pt) => pt.id !== existing.id);
    if (marks.activePoint === existing.id) marks.activePoint = 0;
    chartRedraw[canvas.id]();
  });
}

let chartHome = null;

function openChart(canvas) {
  const modal = $("chartModal");
  const stage = $("chartModalStage");
  if (!canvas || !modal || !stage) return;
  if (chartHome && chartHome.canvas === canvas) return;
  if (chartHome) closeChart();
  chartHome = { canvas, parent: canvas.parentElement, next: canvas.nextSibling };
  stage.appendChild(canvas);
  modal.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(drawAll));
}

function closeChart() {
  if (!chartHome) return;
  const { canvas, parent, next } = chartHome;
  chartHome = null;
  if (parent) {
    if (next && next.parentElement === parent) parent.insertBefore(canvas, next);
    else parent.appendChild(canvas);
  }
  const modal = $("chartModal");
  if (modal) modal.hidden = true;
  requestAnimationFrame(drawAll);
}

function bindCharts() {
  ["liveCanvas", "liveSpecCanvas", "waveCanvas", "specCanvas", "gramCanvas", "campCanvas"].forEach((id) => bindChart($(id)));
  document.querySelectorAll(".plot-max").forEach((btn) => {
    btn.addEventListener("click", () => openChart($(btn.dataset.chart)));
  });
  $("chartModalClose").addEventListener("click", closeChart);
  $("chartModal").addEventListener("click", (event) => {
    if (event.target === $("chartModal")) closeChart();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && chartHome) closeChart();
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!chartHoverId) return;
    const marks = chartMarks[chartHoverId];
    if (!marks || !marks.activePoint) return;
    event.preventDefault();
    marks.points = marks.points.filter((pt) => pt.id !== marks.activePoint);
    marks.activePoint = 0;
    const redraw = chartRedraw[chartHoverId];
    if (redraw) redraw();
  });
}

document.querySelectorAll("nav.tabs button").forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});
$("recBtn").addEventListener("click", toggleRecord);
$("calStart").addEventListener("click", () => measureNoise());
$("calGate").addEventListener("click", () => {
  if (!state.noise) return;
  const gate = Math.min(0.05, Math.max(0.001, Math.ceil(state.noise.rss * 1000) / 1000));
  $("gate").value = String(gate);
  const emaWasOff = !(Number($("ema").value) > 0);
  if (emaWasOff) $("ema").value = "0.25";
  onProcessSlider();
  banner(emaWasOff
    ? "Noise gate is " + gate.toFixed(3) + " g. Quiet live samples sit on zero, and a little smoothing is on so the line stays calm."
    : "Noise gate is " + gate.toFixed(3) + " g. Quiet live samples sit on zero.", true);
});
$("calClear").addEventListener("click", () => {
  state.noise = null;
  localStorage.removeItem("tremble-noise");
  renderNoise();
});
$("apply").addEventListener("click", () => {
  if ($("apply").disabled) return;
  state.busy = true;
  syncApplyBtn();
  applySettings()
    .catch((err) => banner(stickDown(err) || "Could not apply those settings.", false))
    .finally(() => {
      state.busy = false;
      syncApplyBtn();
    });
});
["rate", "range", "seconds", "gyro"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("input", syncApplyBtn);
  el.addEventListener("change", syncApplyBtn);
});

/* Form controls persisted in localStorage (tremble-ui); uiReady gates save during loadUi. */
const UI_DEFAULTS = {
  units: "metric",
  liveQty: "accel",
  ema: "0",
  gate: "0",
  fftWin: "512",
  feedRate: "slow",
  logF: false,
  markPeaks: false,
  analyzePeaks: false,
  decayEnv: false,
  liveSpan: "0",
  liveFmin: "",
  liveFmax: "",
  tFrom: "",
  tTo: "",
  hp: "0.5",
  lp: "0",
  quantity: "accel",
  displacement: false,
  chX: true,
  chY: true,
  chZ: true,
  chRss: false,
  logSpec: false,
  showRaw: true,
  mapX: "+0",
  mapY: "+1",
  mapZ: "+2",
  span: "0",
  stftWin: "256",
  yMin: "",
  yMax: "",
  fMin: "",
  fMax: "",
  specMax: "",
  rpmFrom: "",
  rpmTo: "",
  grid: true,
  rate: "800",
  range: "2",
  seconds: "10",
  gyro: false,
  staSsid: "",
};

async function resetSettings() {
  const ok = window.confirm("Reset this page and the Stick to 800 Hz, ±2 g, and 10 seconds? The lab network is cleared. Saved captures stay.");
  if (!ok) return;
  UI_IDS.forEach((id) => {
    const el = $(id);
    if (!el || !Object.prototype.hasOwnProperty.call(UI_DEFAULTS, id)) return;
    const value = UI_DEFAULTS[id];
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = value;
  });
  if ($("staPass")) $("staPass").value = "";
  if ($("liveRange")) {
    $("liveRange").value = "0";
    if ($("liveRangeLabel")) $("liveRangeLabel").textContent = "±2 g";
  }
  if ($("scrub")) $("scrub").value = "0";
  labelSliders();
  saveUi();
  banner("Settings are back to the defaults.", true);
  rebuildLiveSpectrum();
  drawAll();
  if (state.parsed) runAnalysis();
  try {
    await applySettings();
    await post("/api/wifi", { ssid: "", pass: "" });
  } catch (err) {
    banner("The page is reset. The Stick did not take the new capture settings.", false);
  }
}

$("resetSettings").addEventListener("click", () => resetSettings());
document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => usePreset(btn.dataset.preset));
});
$("saveWifi").addEventListener("click", () => {
  post("/api/wifi", { ssid: $("staSsid").value.trim(), pass: $("staPass").value })
    .then(() => banner("Network saved. The Stick is trying to join it.", true))
    .catch((err) => banner(err.message, false));
});
["mapX", "mapY", "mapZ"].forEach((id) => {
  const select = $(id);
  [["+0", "+X"], ["-0", "-X"], ["+1", "+Y"], ["-1", "-Y"], ["+2", "+Z"], ["-2", "-Z"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  select.value = id === "mapX" ? "+0" : id === "mapY" ? "+1" : "+2";
});
["yMin", "yMax", "fMin", "fMax", "specMax", "tFrom", "tTo", "rpmFrom", "rpmTo", "liveFmin", "liveFmax"].forEach((id) => {
  $(id).addEventListener("input", () => {
    if (state.result) refreshView();
    else drawAll();
  });
});
$("grid").addEventListener("change", () => {
  if (state.result) refreshView();
  else drawAll();
});
["hp", "lp", "quantity", "displacement", "logSpec", "showRaw", "chX", "chY", "chZ", "chRss", "mapX", "mapY", "mapZ"].forEach((id) => {
  $(id).addEventListener("change", () => {
    if (id === "quantity") {
      syncSignal("analyze");
      return;
    }
    if (id === "logSpec" || id === "showRaw" || id.startsWith("ch")) refreshView();
    else if (state.parsed) runAnalysis();
  });
});
function labelSliders() {
  const ema = Number($("ema").value) || 0;
  $("emaLabel").textContent = ema > 0 ? ema.toFixed(2) : "off";
  const gate = Number($("gate").value) || 0;
  $("gateLabel").textContent = gate > 0 ? gate.toFixed(3) + " g" : "off";
}
let sliderTimer = 0;
function onProcessSlider() {
  labelSliders();
  saveUi();
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => {
    rebuildLiveSpectrum();
    if (state.parsed) runAnalysis();
    else drawAll();
  }, 120);
}
$("ema").addEventListener("input", onProcessSlider);
$("gate").addEventListener("input", onProcessSlider);
labelSliders();
$("units").addEventListener("change", () => {
  $("yMin").value = "";
  $("yMax").value = "";
  $("specMax").value = "";
  rebuildLiveSpectrum();
  if (state.status) applyStatus(state.status);
  renderNoise();
  refreshView();
});
["logF", "stftWin", "fftWin", "markPeaks", "analyzePeaks", "liveQty", "decayEnv", "liveSpan"].forEach((id) => {
  $(id).addEventListener("change", () => {
    if (id === "liveQty") {
      syncSignal("live");
      return;
    }
    if (id === "decayEnv") rebuildLiveSpectrum();
    if (state.result) refreshView();
    else drawAll();
  });
});
$("liveRange").addEventListener("input", () => {
  const ranges = ["2", "4", "8", "16"];
  $("liveRangeLabel").textContent = "±" + (ranges[Number($("liveRange").value)] || "2") + " g";
});
$("liveRange").addEventListener("change", () => {
  const ranges = ["2", "4", "8", "16"];
  const value = ranges[Number($("liveRange").value)] || "2";
  $("range").value = value;
  $("liveRangeLabel").textContent = "±" + value + " g";
  if (state.recording) {
    banner("Range changes after the capture stops.", false);
    return;
  }
  applySettings().catch((err) => banner(stickDown(err) || "Could not apply those settings.", false));
});
$("span").addEventListener("change", refreshView);
$("scrub").addEventListener("input", refreshView);
$("play").addEventListener("click", () => {
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = 0;
    $("play").textContent = "Play";
    refreshView();
    return;
  }
  if (!state.result) return;
  $("play").textContent = "Pause";
  const step = () => {
    let pos = Number($("scrub").value) + 8;
    if (pos > 1000) pos = 0;
    $("scrub").value = String(pos);
    refreshView();
  };
  state.playTimer = setInterval(step, 120);
  refreshView();
});
$("baseSet").addEventListener("click", () => {
  const result = state.result;
  if (!result || !result.resonance) {
    banner("Need a capture with a clear peak before setting a baseline.", false);
    return;
  }
  state.baseline = {
    label: state.source || "baseline",
    hz: result.resonance.hz,
    amp: result.resonance.amp,
    damping: result.resonance.damping,
    rss: result.metrics.accel.rss,
  };
  refreshView();
});
$("baseClear").addEventListener("click", () => {
  state.baseline = null;
  refreshView();
});
$("reanalyze").addEventListener("click", runAnalysis);
$("openFile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  await loadBuffer(await file.arrayBuffer(), file.name);
  showTab("analyze");
});
const drop = $("drop");
drop.addEventListener("dragover", (event) => event.preventDefault());
drop.addEventListener("drop", async (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;
  await loadBuffer(await file.arrayBuffer(), file.name);
  showTab("analyze");
});
async function saveCapture(name) {
  if (state.fileBusy) return;
  state.fileBusy = true;
  syncFileTools();
  banner("Saving on the Stick…", false);
  try {
    const saved = await post("/api/files/save", { name: (name || "").trim() });
    state.filesEtag = "";
    banner("Saved " + saved.name + ".vibe on the Stick.", true);
  } catch (err) {
    banner(stickDown(err), false);
  } finally {
    state.fileBusy = false;
    try { await refreshFiles(); } catch (err) { syncFileTools(); }
  }
}
$("fileAll").addEventListener("change", () => {
  document.querySelectorAll("#fileList .file-pick input").forEach((box) => {
    box.checked = $("fileAll").checked;
  });
  syncFileTools();
});
$("fileDelete").addEventListener("click", () => {
  deleteCaptures(selectedFileNames());
});
$("analyzeSave").addEventListener("click", () => {
  saveCapture($("analyzeName").value).catch((err) => banner(err.message, false));
});
$("expPng").addEventListener("click", exportPng);
$("expDoc").addEventListener("click", () => {
  exportDocx().catch((err) => banner(err.message, false));
});
$("expCsv").addEventListener("click", exportCsv);
$("expSpec").addEventListener("click", exportSpectrum);
$("expJson").addEventListener("click", exportJson);
$("expFea").addEventListener("click", exportFea);
$("expAll").addEventListener("click", () => {
  exportCsv();
  setTimeout(exportSpectrum, 400);
  setTimeout(exportJson, 800);
});
const UI_IDS = [
  "units", "liveQty", "ema", "gate", "fftWin", "feedRate", "logF", "markPeaks", "analyzePeaks", "decayEnv", "liveSpan", "liveFmin", "liveFmax",
  "tFrom", "tTo", "rpmFrom", "rpmTo",
  "hp", "lp", "quantity", "displacement",
  "chX", "chY", "chZ", "chRss", "logSpec", "showRaw",
  "mapX", "mapY", "mapZ", "span", "stftWin",
  "yMin", "yMax", "fMin", "fMax", "specMax", "grid",
  "rate", "range", "seconds", "gyro", "staSsid",
];
let uiReady = false;

function saveUi() {
  if (!uiReady) return;
  const data = {};
  UI_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    data[id] = el.type === "checkbox" ? el.checked : el.value;
  });
  const tab = document.querySelector("nav.tabs button[aria-selected='true']");
  if (tab) data.tab = tab.dataset.tab;
  ["chartDock", "liveDock"].forEach((id) => {
    const el = $(id);
    if (el) data[id] = el.open;
  });
  try { localStorage.setItem("tremble-ui", JSON.stringify(data)); } catch (err) { /* private mode */ }
}

function loadUi() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem("tremble-ui") || "null"); } catch (err) { data = null; }
  if (data) {
    UI_IDS.forEach((id) => {
      const el = $(id);
      if (!el || data[id] == null) return;
      if (el.type === "checkbox") el.checked = !!data[id];
      else if (data[id] !== "") el.value = String(data[id]);
    });
  }
  ["chartDock", "liveDock"].forEach((id) => {
    const el = $(id);
    if (el) el.open = !!(data && data[id]);
  });
  labelSliders();
  uiReady = true;
  syncApplyBtn();
  if (data && data.tab && data.tab !== "live") {
    const tab = (data.tab === "files" || data.tab === "capture") ? (data.tab === "files" ? "analyze" : "live") : data.tab;
    if (tab !== "live") showTab(tab);
  }
}

document.addEventListener("input", (event) => {
  if (event.target && UI_IDS.indexOf(event.target.id) >= 0) saveUi();
});
document.addEventListener("change", (event) => {
  if (event.target && UI_IDS.indexOf(event.target.id) >= 0) saveUi();
});
$("livePause").addEventListener("click", () => {
  state.paused = !state.paused;
  $("livePause").textContent = state.paused ? "Resume" : "Pause";
  $("livePause").setAttribute("aria-pressed", state.paused ? "true" : "false");
});

["chartDock", "liveDock"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("toggle", () => {
    saveUi();
    requestAnimationFrame(() => requestAnimationFrame(drawAll));
  });
});
window.addEventListener("resize", drawAll);
$("axisEdit").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitAxisEdit(false);
  } else if (event.key === "Escape") {
    event.preventDefault();
    commitAxisEdit(true);
  }
});
$("axisEdit").addEventListener("blur", () => {
  commitAxisEdit(false);
});
document.addEventListener("pointerdown", (event) => {
  const input = $("axisEdit");
  if (!input || input.hidden || event.target === input) return;
  commitAxisEdit(false);
});
bindCharts();
loadUi();
loadNoise();

/* Boot: restore UI, then start paced polls (status always; live split by softApOnly). */
drawAll();
post("/api/time", { epoch: String(Date.now()) }).catch(() => {});
pollStatus();
pace(pollStatus, () => {
  const ms = feedPace().status;
  return pageVisible() ? ms : ms * 2;
});
pace(pollLive, (hot) => hot ? feedPace().live : feedPace().idle);
pace(pollSpectrum, (hot) => hot ? feedPace().spec : feedPace().idle);
document.addEventListener("visibilitychange", () => {
  if (!pageVisible()) return;
  pollStatus().catch(() => {});
  if ($("live").classList.contains("active")) {
    pollLive().catch(() => {});
    pollSpectrum().catch(() => {});
  }
});
