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
  linkMisses: 0,
  liveClock: performance.now(),
  liveAt: 0,
  playTimer: 0,
};

const PRESETS = {
  structure: { rate: "400", range: "2", seconds: 30, hp: 0.3, lp: 40 },
  machine: { rate: "1600", range: "8", seconds: 10, hp: 2, lp: 500 },
  impact: { rate: "1600", range: "16", seconds: 5, hp: 1, lp: 0 },
};

const COLORS = { x: "#ff8d8d", y: "#8ee0a8", z: "#8cbcff", rss: "#f0b429" };
const chartMarks = {};
const chartProbes = {};
const chartRedraw = {};
let markSeq = 1;
let chartDrag = null;
let chartHoverId = "";
let chartSkipClick = false;

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

function showTab(name) {
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.setAttribute("aria-selected", btn.dataset.tab === name ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === name);
  });
  if (name === "files") refreshFiles();
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
    let lx = box.right - items.length * 54;
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
  ctx.fillText(opt.xTitle || "", (box.left + box.right) / 2, h - 8);
  ctx.strokeStyle = "#5c6b80";
  ctx.lineWidth = 1;
  ctx.strokeRect(box.left + 0.5, box.top + 0.5, plotW, plotH);
  const yTicks = logY ? logTicks(yMin, yMax) : tickValues(yMin, yMax, Math.max(3, Math.floor(plotH / 42)));
  const xTicks = logX ? logTicks(xMin, xMax) : tickValues(xMin, xMax, Math.max(3, Math.floor(plotW / 78)));
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
    ctx.fillStyle = "#c9d3e2";
    ctx.textBaseline = Math.abs(y - box.top) < 1 ? "top" : Math.abs(y - box.bottom) < 1 ? "bottom" : "middle";
    ctx.fillText(tickLabel(v), box.left - 7, y);
  });
  ctx.textBaseline = "top";
  xTicks.forEach((v) => {
    const x = xOf(v);
    if (x < box.left - 0.5 || x > box.right + 0.5) return;
    ctx.textAlign = x >= box.right - 1 ? "right" : x <= box.left + 1 ? "left" : "center";
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
    ctx.fillStyle = "#c9d3e2";
    ctx.fillText(tickLabel(v), x, box.bottom + 8);
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
  return { box, plotW, plotH, xOf, yOf, xFrom, xMin, xMax, yMin, yMax, legendHits };
}

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
  });
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
  ctx.lineWidth = 1;
  if (Number.isFinite(opt.cursor) && opt.span === 0) {
    const x = frame.xOf(opt.cursor);
    ctx.strokeStyle = "#f0b429";
    ctx.beginPath();
    ctx.moveTo(x, frame.box.top);
    ctx.lineTo(x, frame.box.bottom);
    ctx.stroke();
  }
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
  });
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
  const stops = [[22, 48, 86], [18, 70, 150], [24, 160, 150], [240, 176, 48], [255, 244, 220]];
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
  });
  if (!spec) {
    ctx.fillStyle = "#93a0b3";
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText(opt.empty || "Open a capture to see how the tones decay", frame.box.left + 12, frame.box.top + 28);
    return;
  }
  let peak = 0;
  for (let i = 0; i < spec.mag.length; i++) if (spec.mag[i] > peak) peak = spec.mag[i];
  if (!(peak > 0)) peak = 1;
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
      const bin = Math.max(0, Math.min(spec.bins - 1, Math.round(freq / spec.df)));
      const db = 20 * Math.log10(Math.max(spec.mag[base + bin], peak * 1e-7) / peak);
      ctx.fillStyle = heatColor((db + 70) / 70);
      ctx.fillRect(frame.box.left + x - 0.3, frame.box.top + y - 0.3, 1.6, 1.6);
    }
  }
}

function channelShow() {
  return {
    x: $("chX").checked,
    y: $("chY").checked,
    z: $("chZ").checked,
    rss: $("chRss") ? $("chRss").checked : false,
  };
}

function viewWindow() {
  const result = state.result;
  if (!result || !result.count) return null;
  const dur = result.count / result.sampleRate;
  const tFrom = readNum("tFrom");
  const tTo = readNum("tTo");
  if ((tFrom != null || tTo != null) && dur > 0) {
    let start = tFrom != null ? tFrom : 0;
    let end = tTo != null ? tTo : dur;
    if (start < 0) start = 0;
    if (end > dur) end = dur;
    if (!(end > start)) end = Math.min(dur, start + 0.05);
    return { start, span: end - start, dur, cursor: start };
  }
  const span = Number($("span").value) || 0;
  const maxStart = Math.max(0, dur - span);
  const pos = Number($("scrub").value) / 1000;
  const start = span ? pos * maxStart : 0;
  return { start, span, dur, cursor: span ? start : pos * dur };
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
  const spanSamples = view.span ? Math.max(16, Math.round(view.span * result.sampleRate)) : result.count;
  const startSample = Math.round(view.start * result.sampleRate);
  state.focus = view.span ? VibeDSP.focus(result, startSample, spanSamples) : null;
  const label = $("scrubLabel");
  if (label) {
    label.textContent = view.span
      ? `${view.start.toFixed(2)} to ${Math.min(view.dur, view.start + view.span).toFixed(2)} s`
      : `Cursor ${view.cursor.toFixed(2)} s`;
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

function liveSpectrumPeaks(spectrum, show, fMax) {
  if (!$("markPeaks") || !$("markPeaks").checked || !spectrum || !VibeDSP.topPeaks) return null;
  const picked = chartMarks.liveSpecCanvas && chartMarks.liveSpecCanvas.selected;
  const peaks = [];
  ["x", "y", "z", "rss"].forEach((key) => {
    if (!show[key] || !spectrum[key]) return;
    if (picked && key !== picked) return;
    const df = spectrum.df || 1;
    const fMin = Math.max(df, 0.5);
    const hi = fMax > fMin ? fMax : fMin + 1;
    VibeDSP.topPeaks(spectrum[key], df, fMin, hi).forEach((peak) => {
      const i = Math.min(spectrum[key].length - 1, Math.max(0, Math.round(peak.hz / df)));
      peaks.push({ key, hz: i * df, amp: spectrum[key][i], labelHz: peak.hz });
    });
  });
  return peaks;
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
  drawWave(live, series, fs, liveShows(), {
    title: "Live " + quantityLabel(qty).toLowerCase(),
    yTitle: quantityLabel(qty) + " (" + unitName(qty) + ")",
    empty: "Waiting for samples from the Stick",
    gain: displayScale(qty),
    grid: true,
    t0,
    guides,
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
    autoPeaks: liveSpectrumPeaks(spec, show, fMax),
  });
  chartRedraw.liveSpecCanvas = () => drawLiveSpectrum();
}

function gramSeries(series) {
  const full = state.result;
  if (!full || full.quantity !== "accel" || !full.beforeGate || !full.beforeGate.x) return series;
  const src = full.beforeGate;
  let a = 0;
  let len = src.x.length;
  if (state.focus && state.focus.count > 0) {
    a = Math.max(0, state.focus.start | 0);
    len = state.focus.count | 0;
    if (a + len > src.x.length) len = src.x.length - a;
  }
  if (len < 1) return series;
  if (a === 0 && len === src.x.length) return src;
  return {
    x: src.x.subarray(a, a + len),
    y: src.y.subarray(a, a + len),
    z: src.z.subarray(a, a + len),
  };
}

function spectrogramSeries(series) {
  const use = gramSeries(series);
  if (!use || !use.x || use.x.length < 64 || !state.result) return null;
  const rss = new Float32Array(use.x.length);
  for (let i = 0; i < rss.length; i++) rss[i] = Math.hypot(use.x[i] || 0, use.y[i] || 0, use.z[i] || 0);
  const win = Number($("stftWin") && $("stftWin").value) || 256;
  return VibeDSP.spectrogram(rss, state.result.sampleRate, { win });
}

function drawAll() {
  if (document.getElementById("live").classList.contains("active")) {
    drawLiveWave();
    drawLiveSpectrum();
  }
  if (!document.getElementById("analyze").classList.contains("active")) return;
  const view = viewWindow();
  const focused = state.focus;
  const series = focused ? focused.series : selectedSeries();
  const spectrum = focused ? focused.spectrum : (state.result && state.result.spectrum);
  const raw = focused ? focused.raw : (state.result && state.result.raw);
  const scale = chartScale();
  const quantity = state.result && state.result.quantity;
  const unit = unitName(quantity);
  const gain = displayScale(quantity);
  const logF = $("logF") && $("logF").checked;
  const show = channelShow();
  drawWave($("waveCanvas"), series, state.result ? state.result.sampleRate : 1, show, {
    under: raw,
    cursor: view && view.cursor,
    span: view ? view.span : 0,
    t0: view && view.span ? view.start : 0,
    title: quantityLabel(quantity) + " waveform",
    yTitle: quantityLabel(quantity) + " (" + unit + ")",
    yMin: scale.yMin,
    yMax: scale.yMax,
    gain,
    grid: scale.grid,
  });
  drawSpectrum($("specCanvas"), spectrum, $("logSpec").checked, show, {
    title: quantityLabel(quantity) + " spectrum",
    yTitle: "Amplitude (" + unit + ")",
    fMin: scale.fMin,
    fMax: scale.fMax,
    yMax: scale.specMax,
    gain,
    logF,
    grid: scale.grid,
  });
  const gram = $("gramCanvas");
  if (gram) {
    const picture = series ? spectrogramSeries(series) : null;
    drawSpectrogram(gram, picture, {
      title: "Spectrogram, RSS",
      t0: view && view.span ? view.start : 0,
      fMin: scale.fMin,
      fMax: scale.fMax,
      logF,
      grid: scale.grid,
      empty: "Open a capture to see how the tones decay",
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
    box.innerHTML = "<p>Start a capture, or open a .vibe file.</p>";
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
    resBox.innerHTML = `Natural frequency <strong>${fmt(resonance.hz, 2)} Hz</strong>. Half-power bandwidth ${fmt(resonance.bandwidthHz, 2)} Hz. Damping ratio ${fmt(resonance.damping, 3)}. Q ${fmt(resonance.q, 1)}.`;
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
  $("capMeta").textContent = s.recording
    ? `Recording ${ (s.elapsedMs / 1000).toFixed(1) } s · ${s.samples} samples · ${pct.toFixed(0)}%. Do not touch the Stick.`
    : `Ready at ${s.sampleRate} Hz, ±${s.rangeG} g. Up to ${Math.floor(s.capacity / s.sampleRate)} s fits in memory.`;
  $("netInfo").textContent = `Onboard network ${s.apSsid} / ${s.apPass} at ${s.apIp}` +
    (s.staConnected ? `. Joined ${s.staSsid} at ${s.staIp}.` : s.staSsid ? `. Trying to join ${s.staSsid}.` : ".") +
    " USB serial and Bluetooth Tremble use the same commands.";
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
  renderNoise();
  if (s.recording) banner("");
  else if (ended && state.calibrating) finishCalibration();
  else if (ended) {
    banner("Capture finished. Open Analyze, or stay here and start another.", true);
    loadLatest();
  }
}

function fetchStick(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function linkOk() {
  state.linkMisses = 0;
}

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
    const res = await fetchStick("/api/status", 4000);
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
  if (count < 2 || buf.byteLength < 8 + count * 12) return null;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  let offset = 8;
  for (let i = 0; i < count; i++) {
    x[i] = view.getFloat32(offset, true);
    y[i] = view.getFloat32(offset + 4, true);
    z[i] = view.getFloat32(offset + 8, true);
    offset += 12;
  }
  return { dt, x, y, z };
}

async function pollLive() {
  if (state.paused || state.netBusy) return;
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

async function applySettings() {
  await post("/api/settings", {
    rate: $("rate").value,
    range: $("range").value,
    seconds: $("seconds").value || "0",
    gyro: $("gyro").checked ? "1" : "0",
  });
}

async function pollSpectrum() {
  if (state.paused || state.netBusy || !$("live").classList.contains("active")) return;
  state.netBusy = true;
  try {
    const res = await fetchStick("/api/livefft", 3000);
    if (!res.ok) throw new Error("spectrum");
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 18) return;
    const view = new DataView(buf);
    const rate = view.getUint32(0, true);
    const lsb = view.getFloat32(4, true);
    const count = view.getUint16(8, true);
    if (count < 32 || buf.byteLength < 12 + count * 6) return;
    const want = Number($("fftWin") && $("fftWin").value) || count;
    const use = Math.max(32, Math.min(count, want));
    const samples = new Int16Array(buf, 12 + (count - use) * 6, use * 3);
    state.livePacket = { samples: Int16Array.from(samples), count: use, lsb, rate };
    linkOk();
    rebuildLiveSpectrum();
    if ($("live").classList.contains("active")) {
      drawLiveSpectrum();
      if (liveOrder() !== 0) drawLiveWave();
    }
  } catch (err) {
    linkFail();
  } finally {
    state.netBusy = false;
  }
}

function feedPace() {
  const mode = ($("feedRate") && $("feedRate").value) || "steady";
  if (mode === "fast") return { live: 300, spec: 1000, status: 3000, idle: 1500 };
  if (mode === "slow") return { live: 1200, spec: 3500, status: 5000, idle: 2500 };
  return { live: 700, spec: 2000, status: 4000, idle: 2000 };
}

function pace(fn, pickMs) {
  const tick = async () => {
    const hot = document.getElementById("live").classList.contains("active");
    const started = performance.now();
    const recording = state.recording && fn !== pollStatus;
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
      await applySettings();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await post("/api/record", { action: "start" });
      banner("Recording. Leave the Stick alone until this finishes.", false);
    } else {
      await post("/api/record", { action: "stop" });
    }
    await pollStatus();
  } catch (err) {
    banner(err.message, false);
  } finally {
    state.busy = false;
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
  if (state.parsed) runAnalysis();
}

async function refreshFiles() {
  const res = await fetch("/api/files");
  if (!res.ok) return;
  const data = await res.json();
  const pct = data.total ? (100 * data.used) / data.total : 0;
  $("usedBar").style.width = pct.toFixed(1) + "%";
  $("usedText").textContent = `${(data.used / 1024).toFixed(0)} KB used of ${(data.total / 1024).toFixed(0)} KB`;
  const list = $("fileList");
  list.innerHTML = "";
  if (!data.files.length) {
    list.innerHTML = "<li>No files saved on the Stick yet.</li>";
    return;
  }
  data.files.forEach((file) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${file.name}.vibe · ${(file.bytes / 1024).toFixed(0)} KB`;
    const actions = document.createElement("span");
    const open = document.createElement("button");
    open.className = "ghost";
    open.type = "button";
    open.textContent = "Open";
    open.addEventListener("click", async () => {
      const response = await fetch("/api/files/get?name=" + encodeURIComponent(file.name));
      if (!response.ok) return;
      await loadBuffer(await response.arrayBuffer(), file.name + ".vibe");
      showTab("analyze");
    });
    const del = document.createElement("button");
    del.className = "ghost";
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm("Delete " + file.name + "?")) return;
      await post("/api/files/delete", { name: file.name });
      refreshFiles();
    });
    actions.append(open, del);
    li.append(name, actions);
    list.appendChild(li);
  });
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
  }));
  ctx.drawImage(specShot, 40, 500, 1320, 320);
  specShot.remove();
  ctx.fillStyle = "#66788c";
  ctx.font = "14px Segoe UI, sans-serif";
  ctx.fillText("BMI270 on M5Stack StickS3. Screening plot, not a calibrated vibration certificate.", 40, 950);
  canvas.toBlob((blob) => downloadBlob(blob, `tremble-${stamp()}.png`));
}

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
    const probe = chartProbes[canvas.id];
    if (!probe) return;
    const marks = ensureMarks(canvas.id);
    const p = at(event);
    chartHoverId = canvas.id;
    if (chartDrag && chartDrag.id === canvas.id) {
      const pt = marks.points.find((item) => item.id === chartDrag.pointId);
      if (pt) {
        pt.x = probe.frame.xFrom(p.x);
        chartDrag.moved = true;
      }
      canvas.style.cursor = "grabbing";
    } else {
      marks.hover = p;
      canvas.style.cursor = hitMark(probe, marks, p) ? "grab" : "crosshair";
    }
    const redraw = chartRedraw[canvas.id];
    if (redraw) redraw();
  });
  canvas.addEventListener("pointerup", () => {
    if (chartDrag && chartDrag.id === canvas.id && chartDrag.moved) chartSkipClick = true;
    chartDrag = null;
    canvas.style.cursor = "crosshair";
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
    if (chartSkipClick) {
      chartSkipClick = false;
      return;
    }
    const probe = chartProbes[canvas.id];
    if (!probe) return;
    const marks = ensureMarks(canvas.id);
    const p = at(event);
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

function bindCharts() {
  ["liveCanvas", "liveSpecCanvas", "waveCanvas", "specCanvas"].forEach((id) => bindChart($(id)));
  window.addEventListener("keydown", (event) => {
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
$("apply").addEventListener("click", () => applySettings().catch((err) => banner(err.message, false)));

const UI_DEFAULTS = {
  units: "metric",
  liveQty: "accel",
  ema: "0",
  gate: "0",
  fftWin: "512",
  feedRate: "steady",
  logF: false,
  markPeaks: false,
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
["yMin", "yMax", "fMin", "fMax", "specMax", "tFrom", "tTo", "liveFmin", "liveFmax"].forEach((id) => {
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
["logF", "stftWin", "fftWin", "markPeaks", "liveQty", "decayEnv", "liveSpan"].forEach((id) => {
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
  applySettings().catch((err) => banner(err.message, false));
});
$("span").addEventListener("change", refreshView);
$("scrub").addEventListener("input", refreshView);
$("play").addEventListener("click", () => {
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = 0;
    $("play").textContent = "Play";
    return;
  }
  $("play").textContent = "Pause";
  state.playTimer = setInterval(() => {
    let pos = Number($("scrub").value) + 8;
    if (pos > 1000) pos = 0;
    $("scrub").value = String(pos);
    refreshView();
  }, 120);
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
$("saveFile").addEventListener("click", async () => {
  try {
    const saved = await post("/api/files/save", { name: $("fileName").value.trim() });
    banner("Saved " + saved.name + ".vibe on the Stick.", true);
    refreshFiles();
  } catch (err) {
    banner(err.message, false);
  }
});
$("expPng").addEventListener("click", exportPng);
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
  "units", "liveQty", "ema", "gate", "fftWin", "feedRate", "logF", "markPeaks", "decayEnv", "liveSpan", "liveFmin", "liveFmax",
  "tFrom", "tTo",
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
  labelSliders();
  uiReady = true;
  if (data && data.tab && data.tab !== "live") showTab(data.tab);
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

window.addEventListener("resize", drawAll);
bindCharts();
loadUi();
loadNoise();

drawAll();
post("/api/time", { epoch: String(Date.now()) }).catch(() => {});
pollStatus();
pace(pollStatus, () => feedPace().status);
pace(pollLive, (hot) => hot ? feedPace().live : feedPace().idle);
pace(pollSpectrum, (hot) => hot ? feedPace().spec : feedPace().idle);
