/* SAR Atlas - charts.js
 * Tiny dependency-free SVG charts: line (with uncertainty bands), scatter, bars, lag plot.
 * All return SVG strings with role="img" and an aria-label.
 */
(function () {
  'use strict';
  const SAR = (window.SAR = window.SAR || {});
  const C = (SAR.charts = {});
  const fin = Number.isFinite;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function niceTicks(lo, hi, n) {
    if (!fin(lo) || !fin(hi)) return [0, 1];
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function tickFmt(ticks) {
    const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1, dec = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
    return (v) => (Math.abs(v) >= 1000 ? C.fmt(v) : v.toFixed(dec));
  }
  C.fmt = (v) => { if (!fin(v)) return 'n/a'; const a = Math.abs(v); return a >= 10000 ? (v / 1000).toFixed(0) + 'k' : a >= 1000 ? (v / 1000).toFixed(1) + 'k' : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2); };
  const monthLbl = (iso) => { const [y, m] = iso.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] + ' ' + y.slice(2); };
  C.monthLbl = monthLbl;

  /**
   * opts: { w, h, labels:[iso], series:[{y, start, color, width, dash, label}], bands:[{lo, hi, start, color}],
   *         marker, split, yUnit, aria, legend:true }
   */
  C.line = function (o) {
    const w = o.w || 320, h = o.h || 150, L = 40, Rm = 10, T = 12, B = 22, pw = w - L - Rm, ph = h - T - B;
    const n = o.labels.length;
    let lo = Infinity, hi = -Infinity;
    const scan = (arr) => { for (const v of arr) if (fin(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
    (o.series || []).forEach((s) => scan(s.y)); (o.bands || []).forEach((b) => { scan(b.lo); scan(b.hi); });
    if (!fin(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const ticks = niceTicks(lo, hi, 3), tf = tickFmt(ticks), X = (i) => L + (n > 1 ? (i / (n - 1)) * pw : pw / 2), Y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
    let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.aria || 'Time series chart')}">`;
    for (const tv of ticks) { if (tv < lo || tv > hi) continue; const y = Y(tv); s += `<line x1="${L}" x2="${w - Rm}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 3}" class="ax" text-anchor="end">${tf(tv)}</text>`; }
    const every = n > 30 ? 12 : 6;
    for (let i = 0; i < n; i += every) s += `<text x="${X(i)}" y="${h - 6}" class="ax" text-anchor="middle">${monthLbl(o.labels[i])}</text>`;
    if (o.split != null) s += `<line x1="${X(o.split)}" x2="${X(o.split)}" y1="${T}" y2="${T + ph}" class="split"/><text x="${X(o.split) + 4}" y="${T + 9}" class="ax">forecast</text>`;
    for (const b of o.bands || []) {
      const st = b.start || 0, pts = [];
      b.hi.forEach((v, i) => pts.push(`${X(st + i)},${Y(v)}`));
      for (let i = b.lo.length - 1; i >= 0; i--) pts.push(`${X(st + i)},${Y(b.lo[i])}`);
      s += `<polygon points="${pts.join(' ')}" fill="${b.color}" opacity="0.22"/>`;
    }
    for (const se of o.series || []) {
      const st = se.start || 0; let d = '', pen = false;
      se.y.forEach((v, i) => { if (fin(v)) { d += (pen ? 'L' : 'M') + X(st + i).toFixed(1) + ',' + Y(v).toFixed(1); pen = true; } else pen = false; });
      s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width || 1.6}" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''} stroke-linejoin="round"/>`;
    }
    if (o.marker != null && o.marker < n) s += `<line x1="${X(o.marker)}" x2="${X(o.marker)}" y1="${T}" y2="${T + ph}" class="marker"/>`;
    s += `<text x="${L}" y="9" class="ax unit">${esc(o.yUnit || '')}</text>`;
    s += '</svg>';
    if (o.legend !== false && (o.series || []).some((x) => x.label)) s += `<div class="chart-legend">${o.series.filter((x) => x.label).map((x) => `<span><i style="background:${x.color}"></i>${esc(x.label)}</span>`).join('')}</div>`;
    return s;
  };

  /** Scatter with OLS fit. Points are subsampled deterministically to keep the DOM small. */
  C.scatter = function (o) {
    const w = o.w || 320, h = o.h || 200, L = 42, Rm = 10, T = 10, B = 28, pw = w - L - Rm, ph = h - T - B;
    const xs = [], ys = [];
    for (let i = 0; i < o.x.length; i++) if (fin(o.x[i]) && fin(o.y[i])) { xs.push(o.x[i]); ys.push(o.y[i]); }
    if (xs.length < 3) return `<div class="empty small">Not enough paired values to plot.</div>`;
    let [x0, x1] = SAR.models.minmax(xs), [y0, y1] = SAR.models.minmax(ys);
    if (x0 === x1) { x0 -= 1; x1 += 1; } if (y0 === y1) { y0 -= 1; y1 += 1; }
    const px = (x1 - x0) * 0.05, py = (y1 - y0) * 0.06; x0 -= px; x1 += px; y0 -= py; y1 += py;
    const X = (v) => L + ((v - x0) / (x1 - x0)) * pw, Y = (v) => T + ph - ((v - y0) / (y1 - y0)) * ph;
    let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.aria || 'Scatter plot')}">`;
    for (const tv of niceTicks(y0, y1, 3)) if (tv >= y0 && tv <= y1) s += `<line x1="${L}" x2="${w - Rm}" y1="${Y(tv)}" y2="${Y(tv)}" class="grid"/><text x="${L - 6}" y="${Y(tv) + 3}" class="ax" text-anchor="end">${C.fmt(tv)}</text>`;
    for (const tv of niceTicks(x0, x1, 4)) if (tv >= x0 && tv <= x1) s += `<text x="${X(tv)}" y="${T + ph + 13}" class="ax" text-anchor="middle">${C.fmt(tv)}</text>`;
    const stride = Math.max(1, Math.ceil(xs.length / 1400));
    for (let i = 0; i < xs.length; i += stride) s += `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="1.7" class="pt"/>`;
    const f = SAR.models.ols(xs, ys);
    s += `<line x1="${X(x0)}" y1="${Y(f.a + f.b * x0)}" x2="${X(x1)}" y2="${Y(f.a + f.b * x1)}" class="fit"/>`;
    s += `<text x="${L + pw}" y="${h - 3}" class="ax" text-anchor="end">${esc(o.xLabel || '')}</text><text x="${L}" y="${T - 1}" class="ax unit">${esc(o.yLabel || '')}</text></svg>`;
    return s;
  };

  /** Horizontal bars: [{label, value, color}] */
  C.bars = function (items, o) {
    o = o || {}; const max = Math.max(1e-9, ...items.map((d) => Math.abs(d.value)));
    return `<div class="bars" role="list">${items.map((d) => `<div class="bar-row" role="listitem"><span class="bar-lbl">${esc(d.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${(Math.abs(d.value) / max) * 100}%;background:${d.color || 'var(--amber)'}"></span></span><span class="bar-val mono">${o.fmt ? o.fmt(d.value) : C.fmt(d.value)}</span></div>`).join('')}</div>`;
  };

  /** Cross-correlation by lag, best lag highlighted. */
  C.lags = function (xc, best, o) {
    o = o || {}; const w = o.w || 320, h = o.h || 120, L = 30, Rm = 8, T = 8, B = 20, pw = w - L - Rm, ph = h - T - B;
    const n = xc.length, bw = pw / n, Y = (v) => T + ph / 2 - (v * ph) / 2;
    let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Cross-correlation by lag">`;
    for (const tv of [-1, 0, 1]) s += `<line x1="${L}" x2="${w - Rm}" y1="${Y(tv)}" y2="${Y(tv)}" class="grid"/><text x="${L - 5}" y="${Y(tv) + 3}" class="ax" text-anchor="end">${tv}</text>`;
    xc.forEach((d, i) => {
      if (!fin(d.r)) return; const x = L + i * bw + 1, y0 = Y(0), y1 = Y(d.r);
      s += `<rect x="${x}" y="${Math.min(y0, y1)}" width="${Math.max(1, bw - 2)}" height="${Math.abs(y1 - y0)}" class="${d.lag === best ? 'lagbest' : 'lagbar'}"><title>lag ${d.lag}: r = ${d.r.toFixed(2)}</title></rect>`;
      if (d.lag % 6 === 0) s += `<text x="${x + bw / 2}" y="${h - 5}" class="ax" text-anchor="middle">${d.lag}</text>`;
    });
    return s + '</svg>';
  };
})();
