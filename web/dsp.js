/* Tremble signal tools. Keep parseVibe() in sync with include/vibe_format.h. */
(function (root) {
  const G = 9.80665;
  const HP_FIX = Math.pow(Math.SQRT2 - 1, 0.25);

  function parseVibe(buffer) {
    const view = new DataView(buffer);
    if (buffer.byteLength < 64) throw new Error("File is too small");
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== "VIBE") throw new Error("This is not a Tremble capture");
    const headerBytes = view.getUint16(6, true);
    const count = view.getUint32(16, true);
    const flags = view.getUint16(14, true);
    const channels = (flags & 4) ? 6 : 3;
    const need = headerBytes + count * channels * 2;
    if (headerBytes < 64 || buffer.byteLength < need) throw new Error("File is incomplete");
    const lsbPerDps = view.getFloat32(52, true);
    return {
      sampleRate: view.getUint32(8, true),
      rangeG: view.getUint16(12, true),
      flags,
      count,
      epoch: view.getUint32(20, true),
      durationUs: view.getUint32(24, true),
      gapCount: view.getUint32(28, true),
      lsbPerG: view.getFloat32(32, true),
      measuredMilliHz: view.getUint32(48, true),
      lsbPerDps: channels === 6 ? (lsbPerDps > 1 ? lsbPerDps : 16.384) : 0,
      channels,
      note: "",
      samples: new Int16Array(buffer, headerBytes, count * channels),
    };
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function subtractMean(x) {
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += x[i];
    const mean = sum / x.length;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] - mean;
    return y;
  }

  function butterworth(kind, fs, fc) {
    let design = kind === "hp" ? fc * HP_FIX : fc / HP_FIX;
    const ny = fs * 0.45;
    if (design < 0.05) design = 0.05;
    if (design > ny) design = ny;
    const w0 = (2 * Math.PI * design) / fs;
    const c = Math.cos(w0);
    const s = Math.sin(w0);
    const alpha = s / (2 * Math.SQRT1_2);
    const b0 = kind === "hp" ? (1 + c) / 2 : (1 - c) / 2;
    const b1 = kind === "hp" ? -(1 + c) : 1 - c;
    const b2 = b0;
    const a0 = 1 + alpha;
    return {
      b: [b0 / a0, b1 / a0, b2 / a0],
      a: [1, (-2 * c) / a0, (1 - alpha) / a0],
    };
  }

  function biquad(b, a, x) {
    const y = new Float32Array(x.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i];
      const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      y[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return y;
  }

  function padReflect(x, pad) {
    const n = x.length;
    const y = new Float32Array(n + pad * 2);
    for (let i = 0; i < pad; i++) {
      const src = Math.min(n - 1, i + 1);
      y[pad - 1 - i] = x[0] * 2 - x[src];
    }
    y.set(x, pad);
    for (let i = 0; i < pad; i++) {
      const src = Math.max(0, n - 2 - i);
      y[pad + n + i] = x[n - 1] * 2 - x[src];
    }
    return y;
  }

  function filtfilt(b, a, x, pad) {
    const padded = padReflect(x, pad);
    let y = biquad(b, a, padded);
    y.reverse();
    y = biquad(b, a, y);
    y.reverse();
    return y.slice(pad, pad + x.length);
  }

  function shape(x, fs, hp, lp) {
    let y = x;
    if (hp > 0 && hp < fs * 0.45) {
      const coeff = butterworth("hp", fs, hp);
      const pad = Math.min(x.length - 1, Math.max(64, Math.ceil(fs / hp)));
      y = filtfilt(coeff.b, coeff.a, y, pad);
    } else {
      y = subtractMean(y);
    }
    if (lp > hp && lp < fs * 0.45) {
      const coeff = butterworth("lp", fs, lp);
      const pad = Math.min(y.length - 1, Math.max(64, Math.ceil(fs / Math.max(lp, 0.5))));
      y = filtfilt(coeff.b, coeff.a, y, pad);
    }
    return y;
  }

  function integrate(x, dt) {
    const y = new Float32Array(x.length);
    for (let i = 1; i < x.length; i++) {
      y[i] = y[i - 1] + (x[i] + x[i - 1]) * 0.5 * dt;
    }
    return y;
  }

  function metricsOf(a) {
    let sum = 0;
    let peak = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      sum += v * v;
      const av = Math.abs(v);
      if (av > peak) peak = av;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const rms = Math.sqrt(sum / a.length);
    return {
      rms,
      peak,
      peakToPeak: max - min,
      crest: rms > 1e-12 ? peak / rms : 0,
    };
  }

  function center(a, fs) {
    const trim = Math.min(Math.floor(a.length / 4), Math.ceil(fs * 0.5));
    if (a.length - trim * 2 < 16) return a;
    return a.subarray(trim, a.length - trim);
  }

  function axisMetrics(series, fs) {
    return {
      x: metricsOf(center(series.x, fs)),
      y: metricsOf(center(series.y, fs)),
      z: metricsOf(center(series.z, fs)),
    };
  }

  function rssRms(m) {
    return Math.hypot(m.x.rms, m.y.rms, m.z.rms);
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + half] * wRe - im[i + k + half] * wIm;
          const vi = re[i + k + half] * wIm + im[i + k + half] * wRe;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + half] = ur - vr;
          im[i + k + half] = ui - vi;
          const next = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = next;
        }
      }
    }
  }

  function spectrumOf(x, fs) {
    const n = x.length;
    const nfft = Math.min(nextPow2(n), 262144);
    const use = Math.min(n, nfft);
    const re = new Float32Array(nfft);
    const im = new Float32Array(nfft);
    let cg = 0;
    for (let i = 0; i < use; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / use);
      cg += w;
      re[i] = x[i] * w;
    }
    if (cg === 0) cg = 1;
    fft(re, im);
    const bins = nfft >> 1;
    const amp = new Float32Array(bins);
    amp[0] = Math.hypot(re[0], im[0]) / cg;
    for (let k = 1; k < bins; k++) amp[k] = (2 * Math.hypot(re[k], im[k])) / cg;
    return { amp, df: fs / nfft };
  }

  function topPeaks(amp, df, fmin, fmax) {
    const found = [];
    for (let k = 2; k < amp.length - 2; k++) {
      const hz = k * df;
      if (hz < fmin || hz > fmax) continue;
      if (amp[k] >= amp[k - 1] && amp[k] > amp[k + 1] && amp[k] >= amp[k - 2]) {
        const a = amp[k - 1];
        const b = amp[k];
        const c = amp[k + 1];
        const denom = a - 2 * b + c;
        let delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
        if (delta > 0.5) delta = 0.5;
        if (delta < -0.5) delta = -0.5;
        found.push({ hz: hz + delta * df, amp: b - 0.25 * (a - c) * delta });
      }
    }
    found.sort((p, q) => q.amp - p.amp);
    const picked = [];
    for (const peak of found) {
      if (picked.length >= 5) break;
      if (picked.length && peak.amp < picked[0].amp * 0.08) break;
      if (picked.some((item) => Math.abs(item.hz - peak.hz) < Math.max(df * 4, 0.4))) continue;
      picked.push(peak);
    }
    return picked;
  }

  function integrateSpectrum(x, fs, fmin, order, fmax) {
    const n = x.length;
    const nfft = nextPow2(n);
    const re = new Float32Array(nfft);
    const im = new Float32Array(nfft);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n || 1;
    for (let i = 0; i < n; i++) re[i] = x[i] - mean;
    fft(re, im);
    const df = fs / nfft;
    for (let k = 0; k < nfft; k++) {
      const f = k <= nfft / 2 ? k * df : (k - nfft) * df;
      const w = 2 * Math.PI * f;
      if (Math.abs(f) < fmin || (fmax > 0 && Math.abs(f) > fmax) || w === 0) {
        re[k] = 0;
        im[k] = 0;
        continue;
      }
      if (order === 1) {
        const nr = im[k] / w;
        const ni = -re[k] / w;
        re[k] = nr;
        im[k] = ni;
      } else {
        const w2 = w * w;
        re[k] = -re[k] / w2;
        im[k] = -im[k] / w2;
      }
    }
    for (let i = 0; i < nfft; i++) im[i] = -im[i];
    fft(re, im);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = re[i] / nfft;
    return y;
  }

  function channel(samples, count, axis, stride, scale) {
    const y = new Float32Array(count);
    for (let i = 0; i < count; i++) y[i] = samples[i * stride + axis] * scale;
    return y;
  }

  function ema(x, fs, seconds) {
    if (!(seconds > 0) || x.length === 0) return x;
    return emaWeighted(x, 1 - Math.exp(-1 / (fs * seconds)));
  }

  function emaWeighted(x, alpha) {
    if (!(alpha > 0) || !(alpha < 1) || x.length === 0) return x;
    const y = new Float32Array(x.length);
    let acc = x[0];
    for (let i = 0; i < x.length; i++) {
      acc += alpha * (x[i] - acc);
      y[i] = acc;
    }
    return y;
  }

  function gateCopy(x, gate) {
    if (!(gate > 0)) return x;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = Math.abs(x[i]) < gate ? 0 : x[i];
    return y;
  }

  function spectrogram(values, fs, options) {
    const n = values.length;
    const win = Math.max(32, Math.min((options && options.win) || 256, n));
    if (n < win || !(fs > 0)) return null;
    const target = Math.min(160, Math.floor((n - win) / Math.max(1, Math.floor(win / 4))) + 1);
    const columns = Math.max(1, target);
    const hop = columns === 1 ? 0 : Math.max(1, Math.floor((n - win) / (columns - 1)));
    const nfft = nextPow2(win);
    const bins = (nfft >> 1) + 1;
    const mag = new Float32Array(columns * bins);
    const hann = new Float32Array(win);
    let weight = 0;
    for (let i = 0; i < win; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (win - 1)));
      weight += hann[i];
    }
    const norm = weight > 0 ? 2 / weight : 1;
    for (let c = 0; c < columns; c++) {
      const start = c * hop;
      const re = new Float32Array(nfft);
      const im = new Float32Array(nfft);
      for (let i = 0; i < win && start + i < n; i++) re[i] = values[start + i] * hann[i];
      fft(re, im);
      const base = c * bins;
      for (let k = 0; k < bins; k++) mag[base + k] = Math.hypot(re[k], im[k]) * norm;
    }
    return { columns, bins, df: fs / nfft, hop, win, mag, fs };
  }

  function applyMap(raw, map) {
    if (!map || map.length !== 3) return raw;
    return map.map((spec) => {
      const src = raw[spec.axis] || raw[0];
      if (!(spec.sign < 0)) return src;
      const y = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) y[i] = -src[i];
      return y;
    });
  }

  function asSeries(parts) {
    return { x: parts[0], y: parts[1], z: parts[2] };
  }

  function resonanceOf(amp, df, peak) {
    if (!peak || !(peak.hz > 0) || amp.length < 4) return null;
    let k = Math.round(peak.hz / df);
    if (k < 1) k = 1;
    if (k > amp.length - 2) k = amp.length - 2;
    const half = peak.amp * Math.SQRT1_2;
    let left = k;
    let right = k;
    while (left > 1 && amp[left] >= half) left--;
    while (right < amp.length - 2 && amp[right] >= half) right++;
    const bandwidthHz = Math.max(df, right * df - left * df);
    const damping = bandwidthHz / (2 * peak.hz);
    return {
      hz: peak.hz,
      amp: peak.amp,
      bandwidthHz,
      damping,
      q: damping > 1e-6 ? 1 / (2 * damping) : 0,
    };
  }

  function sliceSeries(series, a, b) {
    return {
      x: series.x.subarray(a, b),
      y: series.y.subarray(a, b),
      z: series.z.subarray(a, b),
    };
  }

  function spectrumSet(series, fs, hp, lp) {
    const specX = spectrumOf(series.x, fs);
    const specY = spectrumOf(series.y, fs);
    const specZ = spectrumOf(series.z, fs);
    const rss = new Float32Array(specX.amp.length);
    for (let i = 0; i < rss.length; i++) rss[i] = Math.hypot(specX.amp[i], specY.amp[i], specZ.amp[i]);
    const fmax = lp > hp ? lp : fs * 0.45;
    const peaks = topPeaks(rss, specX.df, Math.max(hp, specX.df), fmax);
    return {
      spectrum: { df: specX.df, x: specX.amp, y: specY.amp, z: specZ.amp, rss },
      peaks,
      resonance: resonanceOf(rss, specX.df, peaks[0]),
    };
  }

  function mean(x) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i];
    return s / x.length;
  }

  function scaleCopy(x, factor) {
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] * factor;
    return y;
  }

  function processCapture(parsed, options) {
    const fs = parsed.sampleRate;
    const hp = Number(options.highpassHz) || 0;
    const lp = Number(options.lowpassHz) || 0;
    const notes = [];
    if (!fs || parsed.count < 32) {
      notes.push("Capture is too short to analyze.");
      return { notes, count: parsed.count || 0, sampleRate: fs || 0 };
    }
    const lsb = parsed.lsbPerG > 1 ? parsed.lsbPerG : 32768 / (parsed.rangeG || 2);
    const stride = parsed.channels === 6 ? 6 : 3;
    const scale = 1 / lsb;
    let raw = [
      channel(parsed.samples, parsed.count, 0, stride, scale),
      channel(parsed.samples, parsed.count, 1, stride, scale),
      channel(parsed.samples, parsed.count, 2, stride, scale),
    ];
    raw = applyMap(raw, options.axes);
    let gyro = null;
    if (stride === 6 && parsed.lsbPerDps > 1) {
      const gscale = 1 / parsed.lsbPerDps;
      gyro = applyMap([
        channel(parsed.samples, parsed.count, 3, stride, gscale),
        channel(parsed.samples, parsed.count, 4, stride, gscale),
        channel(parsed.samples, parsed.count, 5, stride, gscale),
      ], options.axes);
    }
    const means = raw.map(mean);
    let vertical = "X";
    if (Math.abs(Math.abs(means[1]) - 1) < Math.abs(Math.abs(means[0]) - 1)) vertical = "Y";
    if (Math.abs(Math.abs(means[2]) - 1) < Math.abs(Math.abs(means[vertical === "Y" ? 1 : 0]) - 1)) vertical = "Z";

    const emaSeconds = Number(options.emaSeconds) || 0;
    const emaAlpha = Number(options.emaAlpha) || 0;
    const gate = Number(options.gate) || 0;
    let dynamic = {
      x: shape(raw[0], fs, hp, lp),
      y: shape(raw[1], fs, hp, lp),
      z: shape(raw[2], fs, hp, lp),
    };
    if (emaAlpha > 0 && emaAlpha < 1) {
      dynamic = {
        x: emaWeighted(dynamic.x, emaAlpha),
        y: emaWeighted(dynamic.y, emaAlpha),
        z: emaWeighted(dynamic.z, emaAlpha),
      };
      notes.push("EMA weight is " + emaAlpha.toFixed(2) + ". Higher weights follow the samples more closely.");
    } else if (emaSeconds > 0) {
      dynamic = {
        x: ema(dynamic.x, fs, emaSeconds),
        y: ema(dynamic.y, fs, emaSeconds),
        z: ema(dynamic.z, fs, emaSeconds),
      };
      notes.push("EMA smoothing is on. A long time constant shrinks short taps.");
    }
    const beforeGate = dynamic;
    if (gate > 0) {
      dynamic = {
        x: gateCopy(dynamic.x, gate),
        y: gateCopy(dynamic.y, gate),
        z: gateCopy(dynamic.z, gate),
      };
      notes.push("Noise gate is " + gate + " g. Samples quieter than that are drawn as zero. The spectrogram keeps the samples before the gate.");
    }
    const fmin = hp > 0 ? hp : Math.max(fs / parsed.count, 0.2);
    const bandLimit = lp > hp ? lp : 0;
    function integrated(series, order, scale) {
      return {
        x: scaleCopy(integrateSpectrum(scaleCopy(series[0], G), fs, fmin, order, bandLimit), scale),
        y: scaleCopy(integrateSpectrum(scaleCopy(series[1], G), fs, fmin, order, bandLimit), scale),
        z: scaleCopy(integrateSpectrum(scaleCopy(series[2], G), fs, fmin, order, bandLimit), scale),
      };
    }
    const velocity = integrated(raw, 1, 1000);

    let displacement = null;
    if (options.displacement) {
      displacement = integrated(raw, 2, 1e6);
      notes.push("Displacement is a double integral above the high-pass. Treat it as an estimate.");
    }

    let quantity = "accel";
    if (options.quantity === "velocity") quantity = "velocity";
    else if (options.quantity === "displacement" && displacement) quantity = "displacement";
    else if (options.quantity === "gyro" && gyro) quantity = "gyro";
    else if (options.quantity === "gyro") notes.push("This capture has no gyroscope samples.");
    const chosen = quantity === "velocity" ? velocity : quantity === "displacement" ? displacement : quantity === "gyro" ? asSeries(gyro) : dynamic;
    const looked = spectrumSet(chosen, fs, hp, quantity === "gyro" ? 0 : lp);
    const peaks = looked.peaks;

    const accelM = axisMetrics(dynamic, fs);
    const velM = axisMetrics(velocity, fs);
    const metrics = {
      accel: Object.assign(accelM, { rss: rssRms(accelM) }),
      velocity: Object.assign(velM, { rss: rssRms(velM) }),
    };
    if (displacement) {
      const dispM = axisMetrics(displacement, fs);
      metrics.displacement = Object.assign(dispM, { rss: rssRms(dispM) });
    }
    if (gyro) {
      const gyroSeries = asSeries(gyro);
      const gyroM = axisMetrics(gyroSeries, fs);
      metrics.gyro = Object.assign(gyroM, { rss: rssRms(gyroM) });
    }

    if (parsed.flags & 1 || parsed.gapCount) notes.push("The sensor dropped samples. Frequencies in this capture are less trustworthy.");
    if (parsed.flags & 2) notes.push("The capture filled the Stick's memory before the requested time.");
    const measured = (parsed.measuredMilliHz || 0) / 1000;
    if (measured && Math.abs(measured - fs) / fs > 0.02) {
      notes.push("The measured rate differs from the setting by more than 2%. Some samples may be missing.");
    }
    if (lp > 0 && lp <= hp) notes.push("Low-pass is at or below the high-pass, so it was not applied.");
    if (parsed.note) notes.push(parsed.note);
    if (looked.resonance) {
      notes.push("The strongest peak is treated as a natural frequency. Damping comes from its half-power width, so a long pure tone looks lightly damped.");
    }

    return {
      notes,
      count: parsed.count,
      sampleRate: fs,
      highpassHz: hp,
      lowpassHz: lp > hp ? lp : 0,
      emaSeconds,
      emaAlpha,
      gate,
      means,
      vertical,
      quantity,
      raw: asSeries(raw),
      beforeGate,
      dynamic,
      velocity,
      displacement,
      gyro: gyro ? asSeries(gyro) : null,
      spectrum: looked.spectrum,
      peaks,
      resonance: looked.resonance,
      metrics,
      lsbPerG: lsb,
    };
  }

  function chosenSeries(full) {
    if (full.quantity === "velocity") return full.velocity;
    if (full.quantity === "displacement" && full.displacement) return full.displacement;
    if (full.quantity === "gyro" && full.gyro) return full.gyro;
    return full.dynamic;
  }

  function focus(full, start, count) {
    const n = full.dynamic.x.length;
    let a = Math.max(0, start | 0);
    let len = count | 0;
    if (!(len > 0) || a >= n) {
      a = 0;
      len = n;
    }
    if (a + len > n) len = n - a;
    const series = sliceSeries(chosenSeries(full), a, a + len);
    const looked = spectrumSet(series, full.sampleRate, full.highpassHz, full.quantity === "gyro" ? 0 : full.lowpassHz);
    const accel = {
      x: metricsOf(full.dynamic.x.subarray(a, a + len)),
      y: metricsOf(full.dynamic.y.subarray(a, a + len)),
      z: metricsOf(full.dynamic.z.subarray(a, a + len)),
    };
    accel.rss = rssRms(accel);
    return {
      start: a,
      count: len,
      series,
      raw: sliceSeries(full.raw, a, a + len),
      spectrum: looked.spectrum,
      peaks: looked.peaks,
      resonance: looked.resonance,
      metrics: { accel },
    };
  }

  function conditionSeries(series, options) {
    if (!series || !series.x) return series;
    const opt = options || {};
    const gate = Number(opt.gate) || 0;
    const alpha = Number(opt.emaAlpha) || 0;
    const smooth = alpha > 0 && alpha < 1;
    if (!(gate > 0) && !smooth) return series;
    let x = series.x;
    let y = series.y;
    let z = series.z;
    if (gate > 0) {
      x = gateCopy(x, gate);
      y = gateCopy(y, gate);
      z = gateCopy(z, gate);
    }
    if (smooth) {
      x = emaWeighted(x, alpha);
      y = emaWeighted(y, alpha);
      z = emaWeighted(z, alpha);
    }
    return { x, y, z };
  }

  function liveAccel(samples, count, lsb) {
    const scale = 1 / (lsb > 1 ? lsb : 16384);
    return asSeries([
      subtractMean(channel(samples, count, 0, 3, scale)),
      subtractMean(channel(samples, count, 1, 3, scale)),
      subtractMean(channel(samples, count, 2, 3, scale)),
    ]);
  }

  function integrateSeries(series, fs, order) {
    const n = (series && series.x && series.x.length) || 1;
    const fmin = Math.max(0.5, fs / n);
    const scale = order >= 2 ? 1e6 : 1000;
    const one = (values) => scaleCopy(integrateSpectrum(scaleCopy(values, G), fs, fmin, order, 0), scale);
    return { x: one(series.x), y: one(series.y), z: one(series.z) };
  }

  function envelopeAmp(ampG, wn, order) {
    if (!(ampG > 0) || !(wn > 0)) return 0;
    if (order === 1) return ampG * G / wn * 1000;
    if (order >= 2) return ampG * G / (wn * wn) * 1e6;
    return ampG;
  }

  function decayFit(x, fs) {
    const n = x ? x.length : 0;
    if (n < 32 || !(fs > 0)) return null;
    let peakI = 0;
    let peakAbs = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a > peakAbs) {
        peakAbs = a;
        peakI = i;
      }
    }
    if (!(peakAbs > 1e-5)) return null;
    const sign = x[peakI] >= 0 ? 1 : -1;
    const minAmp = peakAbs * 0.08;
    const peaks = [];
    if (n > 1 && x[0] * sign >= x[1] * sign && x[0] * sign >= minAmp) peaks.push({ i: 0, amp: x[0] * sign });
    for (let i = 1; i < n - 1; i++) {
      const v = x[i] * sign;
      if (v < minAmp || v < x[i - 1] * sign || v <= x[i + 1] * sign) continue;
      if (i > 1 && v < x[i - 2] * sign) continue;
      peaks.push({ i, amp: v });
    }
    if (peaks.length < 3) return null;
    let start = 0;
    for (let i = 1; i < peaks.length; i++) if (peaks[i].amp > peaks[start].amp) start = i;
    const after = peaks.slice(start);
    if (after.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < after.length; i++) gaps.push(after[i].i - after[i - 1].i);
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    if (!(medianGap >= 3)) return null;
    const chain = [after[0]];
    for (let i = 1; i < after.length; i++) {
      const gap = after[i].i - chain[chain.length - 1].i;
      if (gap < medianGap * 0.65) continue;
      if (gap > medianGap * 1.7) break;
      chain.push(after[i]);
      if (chain.length >= 16) break;
    }
    if (chain.length < 3) return null;
    const deltas = [];
    let rises = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const a0 = chain[i].amp;
      const a1 = chain[i + 1].amp;
      if (!(a1 > 0)) break;
      if (a1 >= a0) {
        rises++;
        continue;
      }
      deltas.push(Math.log(a0 / a1));
    }
    if (deltas.length < 2 || rises > deltas.length) return null;
    const delta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    if (!(delta > 0.004) || delta > 2.5) return null;
    const zeta = delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta);
    const wd = (2 * Math.PI * fs) / medianGap;
    const wn = wd / Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
    return {
      index: chain[0].i,
      amp: chain[0].amp,
      zeta,
      wn,
      sigma: zeta * wn,
      hz: wn / (2 * Math.PI),
      peaks: chain.length,
      rises,
    };
  }

  function decayOf(series, fs, preferKey) {
    if (!series || !(fs > 0)) return null;
    const keys = preferKey ? [preferKey] : ["x", "y", "z"];
    let best = null;
    keys.forEach((key) => {
      if (!series[key]) return;
      const fit = decayFit(series[key], fs);
      if (!fit) return;
      if (!best || fit.peaks > best.peaks || (fit.peaks === best.peaks && fit.amp > best.amp)) {
        best = Object.assign({ key }, fit);
      }
    });
    return best;
  }

  function halfPower(amp, df, fmin, fmax) {
    if (!amp || !(df > 0)) return null;
    const lo = fmin > 0 ? fmin : df;
    const hi = fmax > lo ? fmax : (amp.length - 1) * df;
    const peaks = topPeaks(amp, df, lo, hi);
    if (!peaks.length) return null;
    return resonanceOf(amp, df, peaks[0]);
  }

  function liveLook(samples, count, lsb, fs, options) {
    const opt = options || {};
    let series = liveAccel(samples, count, lsb);
    const gate = Number(opt.gate) || 0;
    if (gate > 0) series = conditionSeries(series, { gate });
    const order = opt.integrate === 2 ? 2 : opt.integrate === 1 ? 1 : 0;
    if (order) series = integrateSeries(series, fs, order);
    const alpha = Number(opt.emaAlpha) || 0;
    if (alpha > 0 && alpha < 1) series = conditionSeries(series, { emaAlpha: alpha });
    const looked = spectrumSet(series, fs, Math.max(fs / count, 0.5), 0);
    return { sampleRate: fs, spectrum: looked.spectrum, peaks: looked.peaks, resonance: looked.resonance };
  }

  root.VibeDSP = {
    G, parseVibe, processCapture, focus, liveLook, liveAccel, integrateSeries, envelopeAmp,
    decayOf, halfPower, spectrogram, spectrumSet, conditionSeries, topPeaks,
  };
})(globalThis);
