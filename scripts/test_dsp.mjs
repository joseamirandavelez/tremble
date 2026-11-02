import fs from "fs";
import vm from "vm";

const code = fs.readFileSync(new URL("../web/dsp.js", import.meta.url), "utf8");
const context = { console };
vm.createContext(context);
vm.runInContext(code, context);
const dsp = context.VibeDSP;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function sineCapture(fs, n, freq, ampG, gravityAxis) {
  const lsb = 16384;
  const samples = new Int16Array(n * 3);
  for (let i = 0; i < n; i++) {
    const value = ampG * Math.sin((2 * Math.PI * freq * i) / fs);
    samples[i * 3] = Math.round((gravityAxis === 0 ? 1 : 0) * lsb + (gravityAxis === 0 ? 0 : value) * (gravityAxis === 0 ? 0 : 1));
    samples[i * 3 + 0] = Math.round((gravityAxis === 0 ? 1 + value : value) * (gravityAxis === 0 ? 1 : 1) * lsb);
  }
  // Rebuild clearly.
  for (let i = 0; i < n; i++) {
    const tone = ampG * Math.sin((2 * Math.PI * freq * i) / fs);
    const g = [0, 0, 0];
    g[gravityAxis] = 1;
    g[0] += gravityAxis === 0 ? 0 : tone;
    if (gravityAxis !== 0) g[0] = tone;
    else g[0] = 1;
    if (gravityAxis !== 0) {
      g[0] = tone;
      g[gravityAxis] = 1;
    }
    samples[i * 3] = Math.round(g[0] * lsb);
    samples[i * 3 + 1] = Math.round(g[1] * lsb);
    samples[i * 3 + 2] = Math.round(g[2] * lsb);
  }
  return {
    sampleRate: fs,
    rangeG: 2,
    flags: 0,
    count: n,
    epoch: 0,
    durationUs: Math.round((n / fs) * 1e6),
    gapCount: 0,
    lsbPerG: lsb,
    measuredMilliHz: fs * 1000,
    samples,
  };
}

const parsed = sineCapture(800, 2048, 25, 0.5, 2);
const result = dsp.processCapture(parsed, {
  highpassHz: 0.5,
  lowpassHz: 0,
  quantity: "accel",
  displacement: false,
});

const rms = result.metrics.accel.x.rms;
const crest = result.metrics.accel.x.crest;
const zRms = result.metrics.accel.z.rms;
const peak = result.peaks[0];
const vrms = result.metrics.velocity.x.rms;
console.log({ rms, crest, zRms, peak, vrms, vertical: result.vertical });

assert(Math.abs(rms - 0.35355) < 0.02, "X RMS should be about 0.354 g, got " + rms);
assert(Math.abs(crest - Math.SQRT2) < 0.08, "crest factor should be near 1.414, got " + crest);
assert(zRms < 0.02, "gravity on Z should be removed, got " + zRms);
assert(result.vertical === "Z", "vertical axis");
assert(peak && Math.abs(peak.hz - 25) < 0.5, "dominant frequency, got " + (peak && peak.hz));
assert(peak && Math.abs(peak.amp - 0.5) < 0.05, "peak amplitude, got " + (peak && peak.amp));
assert(Math.abs(vrms - 22.07) < 1.2, "velocity RMS mm/s, got " + vrms);

const header = new ArrayBuffer(64 + 6);
const view = new DataView(header);
view.setUint8(0, 86); view.setUint8(1, 73); view.setUint8(2, 66); view.setUint8(3, 69);
view.setUint16(4, 1, true);
view.setUint16(6, 64, true);
view.setUint32(8, 400, true);
view.setUint16(12, 4, true);
view.setUint32(16, 1, true);
view.setFloat32(32, 8192, true);
view.setInt16(64, 8192, true);
const file = dsp.parseVibe(header);
assert(file.sampleRate === 400 && file.rangeG === 4 && file.samples[0] === 8192, "header parse");

const cutoff = sineCapture(800, 8000, 0.5, 1, 1);
const shaped = dsp.processCapture(cutoff, { highpassHz: 0.5, lowpassHz: 0, quantity: "accel", displacement: false });
console.log("cutoff rms", shaped.metrics.accel.x.rms);
assert(Math.abs(shaped.metrics.accel.x.rms - 0.5) < 0.08, "high-pass should be near -3 dB at 0.5 Hz, got " + shaped.metrics.accel.x.rms);

const swapped = dsp.processCapture(parsed, {
  highpassHz: 0.5,
  lowpassHz: 0,
  quantity: "accel",
  displacement: false,
  axes: [{ axis: 2, sign: 1 }, { axis: 0, sign: 1 }, { axis: 1, sign: 1 }],
});
assert(Math.abs(swapped.metrics.accel.y.rms - 0.35355) < 0.02, "remap should move the tone onto Y, got " + swapped.metrics.accel.y.rms);
assert(swapped.resonance && Math.abs(swapped.resonance.hz - 25) < 0.5, "resonance frequency");
assert(swapped.resonance.damping > 0 && swapped.resonance.damping < 0.2, "sine damping should be small, got " + swapped.resonance.damping);

const focused = dsp.focus(result, 400, 800);
assert(focused.count === 800, "window length");
assert(focused.peaks[0] && Math.abs(focused.peaks[0].hz - 25) < 1, "window peak");

const gated = dsp.processCapture(parsed, { highpassHz: 0.5, quantity: "accel", gate: 2 });
assert(gated.metrics.accel.x.rms < 0.02, "noise gate should silence a 0.5 g tone, got " + gated.metrics.accel.x.rms);

const calm = dsp.conditionSeries({
  x: Float32Array.from([0.001, -0.002, 0.2, 0.001]),
  y: Float32Array.from([0, 0, 0, 0]),
  z: Float32Array.from([0, 0, 0, 0]),
}, { gate: 0.01, emaAlpha: 0.25 });
assert(calm.x[0] === 0 && calm.x[1] === 0, "live gate should zero the noise floor");
assert(calm.x[2] > 0 && calm.x[2] < 0.2, "smoothing should round the spike, got " + calm.x[2]);

const gram = dsp.spectrogram(result.dynamic.x, 800, { win: 256 });
assert(gram && gram.columns > 4 && gram.bins > 8, "spectrogram");

const integrated = dsp.integrateSeries(result.raw, 800, 1);
let velSum = 0;
for (let i = 0; i < integrated.x.length; i++) velSum += integrated.x[i] * integrated.x[i];
const velRms = Math.sqrt(velSum / integrated.x.length);
assert(Math.abs(velRms - 22.07) < 1.5, "integrateSeries velocity RMS, got " + velRms);

function ringSamples(fs, n, freq, zeta, ampG) {
  const lsb = 16384;
  const wn = 2 * Math.PI * freq;
  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const samples = new Int16Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const a = ampG * Math.exp(-zeta * wn * t) * Math.cos(wd * t);
    samples[i * 3] = Math.round(a * lsb);
  }
  return samples;
}

const ringN = 1600;
const ringFs = 800;
const ring = ringSamples(ringFs, ringN, 40, 0.03, 0.5);
const ringAccel = dsp.liveAccel(ring, ringN, 16384);
const fit = dsp.decayOf(ringAccel, ringFs, "x");
console.log("decay", fit && { zeta: fit.zeta, hz: fit.hz, peaks: fit.peaks, rises: fit.rises });
assert(fit && Math.abs(fit.zeta - 0.03) < 0.008, "log decrement zeta, got " + (fit && fit.zeta));
assert(fit && Math.abs(fit.hz - 40) < 1, "decay frequency, got " + (fit && fit.hz));
assert(fit && fit.rises === 0, "clean ring should not grow");

const steady = dsp.liveAccel((() => {
  const lsb = 16384;
  const samples = new Int16Array(800 * 3);
  for (let i = 0; i < 800; i++) samples[i * 3] = Math.round(0.4 * Math.sin((2 * Math.PI * 30 * i) / 800) * lsb);
  return samples;
})(), 800, 16384);
assert(dsp.decayOf(steady, 800, "x") == null, "a steady tone is not a decay");

const smoothed = dsp.conditionSeries(ringAccel, { emaAlpha: 0.08 });
const biased = dsp.decayOf(smoothed, ringFs, "x");
console.log("ema decay", biased && biased.zeta);
assert(!biased || biased.zeta > fit.zeta + 0.005, "EMA before the fit should raise damping, got " + (biased && biased.zeta));

const looked = dsp.liveLook(ring, ringN, 16384, ringFs, {});
const hp = dsp.halfPower(looked.spectrum.x, looked.spectrum.df, 1, 200);
console.log("half power", hp);
assert(hp && Math.abs(hp.hz - 40) < 1.5, "half-power frequency, got " + (hp && hp.hz));
assert(hp && hp.damping > 0.01 && hp.damping < 0.08, "half-power zeta, got " + (hp && hp.damping));
assert(hp && hp.damping > 0.01 && hp.damping < 0.08, "half-power zeta, got " + (hp && hp.damping));

const chirpN = 800 * 4;
const chirp = new Float32Array(chirpN);
for (let i = 0; i < chirpN; i++) {
  const t = i / 800;
  chirp[i] = 0.4 * Math.sin(2 * Math.PI * (40 * t + 1.875 * t * t));
  chirp[i] += 0.25 * Math.sin(2 * Math.PI * 120 * t);
}
const chirpGram = dsp.spectrogram(chirp, 800, { win: 256 });
const tracked = dsp.modeTracks(chirpGram, { fMin: 10, fMax: 200 });
const rising = tracked.find((track) => track.points[track.points.length - 1].hz > track.points[0].hz + 6);
const steadyTone = tracked.find((track) => Math.abs(track.points[0].hz - 120) < 8 && Math.abs(track.points[track.points.length - 1].hz - 120) < 8);
console.log("tracks", tracked.map((track) => [track.points[0].hz.toFixed(1), track.points[track.points.length - 1].hz.toFixed(1), track.points.length]));
assert(rising, "a rising chirp should become one tracked mode");
assert(steadyTone, "a steady tone should stay on its own track");

const ampG = 0.5;
const wn = 2 * Math.PI * 40;
assert(Math.abs(dsp.envelopeAmp(ampG, wn, 0) - ampG) < 1e-9, "accel envelope stays in g");
assert(Math.abs(dsp.envelopeAmp(ampG, wn, 1) - ampG * dsp.G / wn * 1000) < 1e-6, "velocity envelope scale");

console.log("dsp tests passed");
