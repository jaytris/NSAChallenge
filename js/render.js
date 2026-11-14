/* SAR Atlas - render.js
 * Turns a dataset + view state into per-cell fields, RGBA frames and canvases.
 * Palettes are colour-blind safe: grey for backscatter, sequential blue for water,
 * sequential yellow-orange-brown for loss, PuOr diverging for signed change.
 */
(function () {
  'use strict';
  const SAR = (window.SAR = window.SAR || {});
  const R = (SAR.render = {});
  const fin = Number.isFinite;

  R.RAMPS = {
    gray: ['#0d1014', '#5a6068', '#f4f4f2'],
    water: ['#0d2b52', '#2367b0', '#53a7e8', '#c4e8ff'],
    loss: ['#fde7a9', '#f6a623', '#d2581a', '#7a2610'],
    puor: ['#7f3b08', '#e08214', '#fdb863', '#f2efe9', '#b2abd2', '#8073ac', '#2d004b'],
    viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
    magma: ['#1b0c41', '#721f81', '#d1426f', '#fd9f6c', '#fcfdbf']
  };
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const LUT = {};
  for (const [k, stops] of Object.entries(R.RAMPS)) {
    const c = stops.map(hex), lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const p = (i / 255) * (c.length - 1), a = Math.floor(p), b = Math.min(a + 1, c.length - 1), f = p - a;
      for (let q = 0; q < 3; q++) lut[i * 3 + q] = Math.round(c[a][q] + (c[b][q] - c[a][q]) * f);
    }
    LUT[k] = lut;
  }
  R.rampCss = (k) => `linear-gradient(90deg, ${R.RAMPS[k].join(', ')})`;
  R.color = (k, x) => { const i = Math.max(0, Math.min(255, Math.round(x * 255))) * 3, l = LUT[k]; return [l[i], l[i + 1], l[i + 2]]; };

  /* Layer catalogue. `researcher` layers only show in Researcher mode. */
  R.LAYERS = {
    backscatter: { label: 'Backscatter', units: 'dB (gamma-0)', ramp: 'gray', desc: 'Raw radar brightness for the chosen polarization' },
    water: { label: 'Water / flood extent', units: 'fraction of cell inundated', ramp: 'water', desc: 'Open water and flooded vegetation' },
    vegloss: { label: 'Vegetation loss (HV)', units: 'HV drop vs reference, dB', ramp: 'loss', desc: 'Cross-pol drop where canopy volume scattering disappears' },
    disp: { label: 'Displacement', units: 'LOS change vs reference, cm', ramp: 'puor', desc: 'Line-of-sight ground motion from interferometry' },
    change: { label: 'Change detection', units: 'backscatter difference, dB', ramp: 'puor', researcher: true, desc: 'Thresholded log-ratio between reference and current date' },
    classifier: { label: 'Flood classifier (LR)', units: 'P(new open water)', ramp: 'water', researcher: true, desc: 'Earth Waltz logistic regression, reference to current date' },
    bandmath: { label: 'Band math', units: 'expression value', ramp: 'viridis', researcher: true, desc: 'Your expression evaluated per cell' },
    corrmap: { label: 'Correlation map', units: 'Pearson r over time', ramp: 'puor', researcher: false, hidden: true, desc: 'Per-cell temporal correlation of two variables' }
  };

  /** Per-cell value of the active layer at time t. NaN means transparent. */
  R.field = function (ds, st, t) {
    const N = ds.N, out = new Float32Array(N), o = t * N, rf = st.refT * N, v = ds.v, thr = st.threshold;
    let range = [0, 1];
    switch (st.layer) {
      case 'backscatter': { const a = v[st.pol]; for (let k = 0; k < N; k++) out[k] = a[o + k]; range = [-25, 0]; break; }
      case 'water': for (let k = 0; k < N; k++) { const w = v.water[o + k]; out[k] = w > 0.05 ? w : NaN; } break;
      case 'vegloss': for (let k = 0; k < N; k++) { const d = v.HV[o + k] - v.HV[rf + k]; out[k] = d < -thr ? -d : NaN; } range = [thr, Math.max(thr + 1, 12)]; break;
      case 'disp': for (let k = 0; k < N; k++) out[k] = ds.s.landuse[k] === 0 ? NaN : v.disp[o + k] - v.disp[rf + k]; range = [-ds.dispCap, ds.dispCap]; break;
      case 'change': { const a = v[st.pol]; for (let k = 0; k < N; k++) { const d = a[o + k] - a[rf + k]; out[k] = Math.abs(d) >= thr ? d : NaN; } range = [-10, 10]; break; }
      case 'classifier': {
        const M = SAR.models;
        for (let k = 0; k < N; k++) { const p = M.classify(v.HH[rf + k], v.HV[rf + k], v.HH[o + k], v.HV[o + k]); out[k] = p >= M.CLASSIFIER.threshold ? p : NaN; }
        range = [SAR.models.CLASSIFIER.threshold, 1]; break;
      }
      case 'bandmath': {
        if (st.exprFn) { const vals = {}; for (let k = 0; k < N; k++) { vals.HH = v.HH[o + k]; vals.HV = v.HV[o + k]; vals.VV = v.VV[o + k]; vals.water = v.water[o + k]; vals.disp = v.disp[o + k]; vals.rain = v.rain[o + k]; vals.pop = ds.s.pop[k]; const q = st.exprFn(vals); out[k] = fin(q) ? q : NaN; } }
        else out.fill(NaN);
        range = st.exprRange || [0, 1]; break;
      }
      case 'corrmap': if (st.corrField) out.set(st.corrField); else out.fill(NaN); range = [-1, 1]; break;
    }
    return { vals: out, range, ramp: R.LAYERS[st.layer].ramp };
  };

  /** Blend layer + human-activity overlays into a per-cell RGBA array (N*4). */
  R.compose = function (ds, st, t, fld) {
    const N = ds.N, px = new Uint8ClampedArray(N * 4), lut = LUT[fld.ramp], [lo, hi] = fld.range, span = hi - lo || 1;
    const op = st.opacity, ov = st.overlays, oa = st.ovOpacity, LU = ds.landuse, o = t * N;
    let popMax = 1; if (ov.pop) for (let k = 0; k < N; k++) popMax = Math.max(popMax, ds.s.pop[k]);
    const lpm = Math.log10(1 + popMax);
    for (let k = 0; k < N; k++) {
      let r = 0, g = 0, b = 0, a = 0;
      const x = fld.vals[k];
      if (fin(x)) {
        const i = Math.max(0, Math.min(255, Math.round(((x - lo) / span) * 255))) * 3;
        r = lut[i]; g = lut[i + 1]; b = lut[i + 2];
        a = st.layer === 'water' ? op * (0.45 + 0.55 * x) : op;
      }
      const over = (cr, cg, cb, ca) => { const na = ca + a * (1 - ca); if (na <= 0) return; r = (cr * ca + r * a * (1 - ca)) / na; g = (cg * ca + g * a * (1 - ca)) / na; b = (cb * ca + b * a * (1 - ca)) / na; a = na; };
      if (ov.landuse) { const lu = ds.s.landuse[k]; if (lu !== 0) { const c = LU[lu].color; over(c[0], c[1], c[2], oa * 0.75); } }
      if (ov.pop) { const p = ds.s.pop[k]; if (p > 1) { const c = R.color('magma', Math.log10(1 + p) / lpm); over(c[0], c[1], c[2], oa * 0.8); } }
      if (ov.roads && ds.v.urban[o + k] > 0.5) over(236, 240, 245, oa * 0.35);
      px[k * 4] = r; px[k * 4 + 1] = g; px[k * 4 + 2] = b; px[k * 4 + 3] = Math.round(a * 255);
    }
    return px;
  };

  const small = document.createElement('canvas');
  /** Upscale a per-cell RGBA frame into a crisp canvas, then draw the road network as lines. */
  R.toCanvas = function (ds, px, st, t, scale) {
    scale = scale || 8;
    small.width = ds.nx; small.height = ds.ny;
    const sctx = small.getContext('2d');
    sctx.putImageData(new ImageData(px, ds.nx, ds.ny), 0, 0);
    const c = document.createElement('canvas'); c.width = ds.nx * scale; c.height = ds.ny * scale;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, c.width, c.height);
    if (st && st.overlays.roads) {
      const N = ds.N, o = t * N, rd = ds.v.roads, nx = ds.nx;
      ctx.strokeStyle = `rgba(245,248,252,${0.55 + 0.45 * st.ovOpacity})`; ctx.lineWidth = Math.max(1.5, scale * 0.28); ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = 0; k < N; k++) {
        if (rd[o + k] < 0.5) continue;
        const i = k % nx, j = (k / nx) | 0, cx = (i + 0.5) * scale, cy = (j + 0.5) * scale;
        for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
          const ii = i + di, jj = j + dj; if (ii < 0 || ii >= nx || jj >= ds.ny) continue;
          if (rd[o + jj * nx + ii] > 0.5) { ctx.moveTo(cx, cy); ctx.lineTo(cx + di * scale, cy + dj * scale); }
        }
      }
      ctx.stroke();
    }
    return c;
  };

  /** Plain field -> canvas with a ramp (used for compare thumbnails and mini maps). */
  R.fieldCanvas = function (ds, vals, range, ramp, scale) {
    const N = ds.N, px = new Uint8ClampedArray(N * 4), lut = LUT[ramp], span = range[1] - range[0] || 1;
    for (let k = 0; k < N; k++) {
      const x = vals[k]; if (!fin(x)) { px[k * 4 + 3] = 0; continue; }
      const i = Math.max(0, Math.min(255, Math.round(((x - range[0]) / span) * 255))) * 3;
      px[k * 4] = lut[i]; px[k * 4 + 1] = lut[i + 1]; px[k * 4 + 2] = lut[i + 2]; px[k * 4 + 3] = 235;
    }
    return { px, canvas: R.toCanvas(ds, px, null, 0, scale || 4) };
  };

  /** Compare metric for a layer: what gets differenced between dates A and B, and its threshold. */
  R.compareMetric = function (ds, st) {
    switch (st.layer) {
      case 'water': case 'classifier': return { key: 'water', label: 'Water fraction', unit: '', thr: 0.3, get: (t, k) => ds.v.water[t * ds.N + k] };
      case 'disp': return { key: 'disp', label: 'LOS displacement', unit: 'cm', thr: ds.dispCap > 10 ? 3 : 0.8, get: (t, k) => ds.v.disp[t * ds.N + k] };
      case 'vegloss': return { key: 'HV', label: 'HV backscatter', unit: 'dB', thr: st.threshold, get: (t, k) => ds.v.HV[t * ds.N + k] };
      default: return { key: st.pol, label: st.pol + ' backscatter', unit: 'dB', thr: st.threshold, get: (t, k) => ds.v[st.pol][t * ds.N + k] };
    }
  };
  /** Difference layer + gained/lost statistics between two dates. */
  R.difference = function (ds, st, a, b) {
    const m = R.compareMetric(ds, st), N = ds.N, d = new Float32Array(N);
    let gain = 0, loss = 0, sa = 0, sb = 0, n = 0;
    for (let k = 0; k < N; k++) {
      const va = m.get(a, k), vb = m.get(b, k);
      if (m.key === 'disp' && ds.s.landuse[k] === 0) { d[k] = NaN; continue; }
      const x = vb - va; sa += va; sb += vb; n++;
      if (x > m.thr) { gain++; d[k] = x; } else if (x < -m.thr) { loss++; d[k] = x; } else d[k] = NaN;
    }
    const cap = m.key === 'water' ? 1 : m.key === 'disp' ? ds.dispCap : 10;
    const meanA = sa / n, meanB = sb / n;
    let pct;
    if (m.key === 'water') pct = sa > 0 ? ((sb - sa) / sa) * 100 : NaN;
    else if (m.unit === 'dB') pct = (Math.pow(10, (meanB - meanA) / 10) - 1) * 100; // change in mean power
    else pct = NaN;
    return { vals: d, range: [-cap, cap], metric: m, gainKm2: gain * ds.cellKm2, lossKm2: loss * ds.cellKm2, meanA, meanB, pct,
      extentA: m.key === 'water' ? sa * ds.cellKm2 : null, extentB: m.key === 'water' ? sb * ds.cellKm2 : null };
  };

  /** Legend markup for the current layer. */
  R.legendHTML = function (layerKey, range, extra) {
    const L = R.LAYERS[layerKey], f = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
    return `<div class="legend-title">${L.label}${extra ? ' <span class="mono dim">' + extra + '</span>' : ''}</div>
      <div class="legend-bar" style="background:${R.rampCss(L.ramp)}"></div>
      <div class="legend-ends mono"><span>${f(range[0])}</span><span>${f((range[0] + range[1]) / 2)}</span><span>${f(range[1])}</span></div>
      <div class="legend-units">${L.units}</div>`;
  };
})();
