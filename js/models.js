/* SAR Atlas - models.js
 * Statistics, forecasting models (linear, seasonal decomposition, Holt-Winters),
 * backtesting, correlation tools, a safe band-math compiler and the
 * Earth Waltz open-water logistic classifier (weights from classifier/model.json).
 */
(function () {
  'use strict';
  const SAR = (window.SAR = window.SAR || {});
  const M = (SAR.models = {});
  const fin = Number.isFinite;

  /* ---------------- basic statistics ---------------- */
  M.mean = (a) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) if (fin(a[i])) { s += a[i]; n++; } return n ? s / n : NaN; };
  M.std = (a) => { const m = M.mean(a); let s = 0, n = 0; for (let i = 0; i < a.length; i++) if (fin(a[i])) { s += (a[i] - m) ** 2; n++; } return n > 1 ? Math.sqrt(s / (n - 1)) : NaN; };
  M.minmax = (a) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < a.length; i++) if (fin(a[i])) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; } return [lo, hi]; };
  M.quantile = (a, q) => { const b = Array.from(a).filter(fin).sort((x, y) => x - y); if (!b.length) return NaN; const p = (b.length - 1) * q, i = Math.floor(p); return b[i] + (b[Math.min(i + 1, b.length - 1)] - b[i]) * (p - i); };

  /** Pearson r over pairs where both values are finite. Returns NaN if undefined (e.g. constant series). */
  M.pearson = (x, y) => {
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < x.length; i++) if (fin(x[i]) && fin(y[i])) { n++; sx += x[i]; sy += y[i]; }
    if (n < 3) return NaN;
    const mx = sx / n, my = sy / n; let cxy = 0, cxx = 0, cyy = 0;
    for (let i = 0; i < x.length; i++) if (fin(x[i]) && fin(y[i])) { const a = x[i] - mx, b = y[i] - my; cxy += a * b; cxx += a * a; cyy += b * b; }
    if (cxx < 1e-12 || cyy < 1e-12) return NaN;
    return cxy / Math.sqrt(cxx * cyy);
  };
  /** Average ranks with ties. */
  M.ranks = (a) => {
    const idx = Array.from(a, (v, i) => i).sort((i, j) => a[i] - a[j]), r = new Float64Array(a.length);
    for (let k = 0; k < idx.length;) { let e = k; while (e + 1 < idx.length && a[idx[e + 1]] === a[idx[k]]) e++; const avg = (k + e) / 2 + 1; for (let q = k; q <= e; q++) r[idx[q]] = avg; k = e + 1; }
    return r;
  };
  M.spearman = (x, y) => {
    const xs = [], ys = [];
    for (let i = 0; i < x.length; i++) if (fin(x[i]) && fin(y[i])) { xs.push(x[i]); ys.push(y[i]); }
    if (xs.length < 3) return NaN;
    return M.pearson(M.ranks(xs), M.ranks(ys));
  };
  /** Lagged cross-correlation. Positive lag k: y(t+k) vs x(t), i.e. "y follows x by k steps". */
  M.xcorr = (x, y, maxLag) => {
    const out = [];
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const a = [], b = [];
      for (let t = 0; t < x.length; t++) { const u = t + lag; if (u >= 0 && u < y.length) { a.push(x[t]); b.push(y[u]); } }
      out.push({ lag, r: M.pearson(a, b), n: a.length });
    }
    return out;
  };
  /** Ordinary least squares y = a + b x. */
  M.ols = (x, y) => {
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < x.length; i++) if (fin(x[i]) && fin(y[i])) { n++; sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n; let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) if (fin(x[i]) && fin(y[i])) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    const b = sxx ? sxy / sxx : 0, a = my - b * mx;
    return { a, b, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0, n, mx, sxx };
  };
  M.rmse = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) if (fin(a[i]) && fin(b[i])) { s += (a[i] - b[i]) ** 2; n++; } return n ? Math.sqrt(s / n) : NaN; };
  M.mae = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) if (fin(a[i]) && fin(b[i])) { s += Math.abs(a[i] - b[i]); n++; } return n ? s / n : NaN; };

  /* ---------------- forecasting models ----------------
   * Every model: fit(y, period) -> { fitted:number[], sigma, predict(h) -> {mean, lo, hi} }
   * Bands are approximate 95% prediction intervals (1.96 sigma) under Gaussian residuals.
   */
  const Z = 1.96;
  function fitLinear(y) {
    const n = y.length, t = Array.from({ length: n }, (_, i) => i), f = M.ols(t, y);
    const fitted = t.map((i) => f.a + f.b * i);
    let sse = 0; for (let i = 0; i < n; i++) sse += (y[i] - fitted[i]) ** 2;
    const sigma = Math.sqrt(sse / Math.max(1, n - 2));
    return {
      fitted, sigma,
      predict(h) {
        const mean = [], lo = [], hi = [];
        for (let k = 1; k <= h; k++) {
          const tt = n - 1 + k, m = f.a + f.b * tt, se = sigma * Math.sqrt(1 + 1 / n + (tt - f.mx) ** 2 / f.sxx);
          mean.push(m); lo.push(m - Z * se); hi.push(m + Z * se);
        }
        return { mean, lo, hi };
      }
    };
  }
  function fitSeasonal(y, p) {
    const n = y.length, t = Array.from({ length: n }, (_, i) => i), f = M.ols(t, y);
    const season = new Array(p).fill(0), cnt = new Array(p).fill(0);
    for (let i = 0; i < n; i++) { season[i % p] += y[i] - (f.a + f.b * i); cnt[i % p]++; }
    for (let k = 0; k < p; k++) season[k] = cnt[k] ? season[k] / cnt[k] : 0;
    const sm = season.reduce((a, b) => a + b, 0) / p; for (let k = 0; k < p; k++) season[k] -= sm;
    const fitted = t.map((i) => f.a + f.b * i + season[i % p]);
    let sse = 0; for (let i = 0; i < n; i++) sse += (y[i] - fitted[i]) ** 2;
    const sigma = Math.sqrt(sse / Math.max(1, n - 2 - (p - 1)));
    return {
      fitted, sigma, season,
      predict(h) {
        const mean = [], lo = [], hi = [];
        for (let k = 1; k <= h; k++) {
          const tt = n - 1 + k, m = f.a + f.b * tt + season[tt % p], se = sigma * Math.sqrt(1 + 1 / n + (tt - f.mx) ** 2 / f.sxx);
          mean.push(m); lo.push(m - Z * se); hi.push(m + Z * se);
        }
        return { mean, lo, hi };
      }
    };
  }
  /** Additive Holt-Winters with a small grid search on alpha/beta/gamma (one-step SSE after warm-up). */
  function fitHolt(y, p) {
    const n = y.length;
    function run(al, be, ga) {
      const l0 = M.mean(y.slice(0, p)), l1 = M.mean(y.slice(p, 2 * p));
      let L = l0, B = (l1 - l0) / p; const S = y.slice(0, p).map((v) => v - l0);
      let sse = 0, cnt = 0; const fitted = [];
      for (let t = 0; t < n; t++) {
        const s = S[t % p], fc = L + B + s; fitted.push(fc);
        if (t >= p) { sse += (y[t] - fc) ** 2; cnt++; }
        const Ln = al * (y[t] - s) + (1 - al) * (L + B);
        B = be * (Ln - L) + (1 - be) * B;
        S[t % p] = ga * (y[t] - Ln) + (1 - ga) * s;
        L = Ln;
      }
      return { sse, cnt, L, B, S, fitted };
    }
    let best = null, par = null;
    for (const al of [0.2, 0.4, 0.6, 0.8]) for (const be of [0.02, 0.1, 0.2]) for (const ga of [0.1, 0.3, 0.5]) {
      const r = run(al, be, ga); if (!best || r.sse < best.sse) { best = r; par = { al, be, ga }; }
    }
    const sigma = Math.sqrt(best.sse / Math.max(1, best.cnt - 3));
    return {
      fitted: best.fitted, sigma, params: par,
      predict(h) {
        const mean = [], lo = [], hi = []; let acc = 0;
        for (let k = 1; k <= h; k++) {
          const m = best.L + k * best.B + best.S[(n + k - 1) % p];
          if (k > 1) acc += (par.al * (1 + (k - 1) * par.be)) ** 2; // approximate variance growth
          const se = sigma * Math.sqrt(1 + acc);
          mean.push(m); lo.push(m - Z * se); hi.push(m + Z * se);
        }
        return { mean, lo, hi };
      }
    };
  }
  M.MODELS = {
    linear: { name: 'Linear trend', short: 'Linear', fit: (y) => fitLinear(y) },
    seasonal: { name: 'Seasonal decomposition', short: 'Seasonal', fit: (y) => fitSeasonal(y, 12) },
    holt: { name: 'Holt-Winters smoothing', short: 'Holt-Winters', fit: (y) => fitHolt(y, 12) }
  };
  /** Hold out the last `hold` points, fit on the rest, score each model. */
  M.backtest = (y, hold) => {
    const train = y.slice(0, y.length - hold), test = y.slice(y.length - hold), out = {};
    for (const [key, m] of Object.entries(M.MODELS)) {
      const p = m.fit(train).predict(hold);
      let cov = 0; for (let i = 0; i < hold; i++) if (test[i] >= p.lo[i] && test[i] <= p.hi[i]) cov++;
      out[key] = { rmse: M.rmse(p.mean, test), mae: M.mae(p.mean, test), coverage: cov / hold, pred: p };
    }
    return out;
  };

  /* ---------------- band math ----------------
   * Whitelisted identifiers only, so user text can never reach anything but arithmetic.
   * Variables are in dB for HH/HV/VV; lin() and db() convert.
   */
  const VARS = ['HH', 'HV', 'VV', 'water', 'disp', 'rain', 'pop'];
  const FNS = { lin: (x) => Math.pow(10, x / 10), db: (x) => 10 * Math.log10(x), abs: Math.abs, sqrt: Math.sqrt, log10: Math.log10, exp: Math.exp, min: Math.min, max: Math.max };
  M.compileExpr = (expr) => {
    const src = String(expr || '').trim();
    if (!src) throw new Error('Expression is empty');
    if (src.length > 160) throw new Error('Expression is too long');
    if (!/^[\sA-Za-z0-9_.+\-*/(),^]*$/.test(src)) throw new Error('Only numbers, + - * / ^ ( ) and names are allowed');
    const ids = src.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    for (const id of ids) if (!VARS.includes(id) && !(id in FNS) && id !== 'PI') throw new Error('Unknown name: ' + id);
    const body = src.replace(/\^/g, '**');
    // eslint-disable-next-line no-new-func
    const f = new Function(...VARS, ...Object.keys(FNS), 'PI', '"use strict"; return (' + body + ');');
    const fnVals = Object.values(FNS);
    const test = f(-10, -17, -11, 0, 0, 100, 10, ...fnVals, Math.PI);
    if (typeof test !== 'number') throw new Error('Expression must return a number');
    return (vals) => f(vals.HH, vals.HV, vals.VV, vals.water, vals.disp, vals.rain, vals.pop, ...fnVals, Math.PI);
  };
  M.EXPR_VARS = VARS; M.EXPR_FNS = Object.keys(FNS);

  /* ---------------- Earth Waltz open-water classifier ----------------
   * Logistic regression trained by flood.py on simulated scenes (classifier/model.json).
   * Features: pre/post HH & HV (dB) and their differences. Uncalibrated score.
   */
  M.CLASSIFIER = {
    features: ['pre_hh_db', 'pre_hv_db', 'post_hh_db', 'post_hv_db', 'delta_hh_db', 'delta_hv_db'],
    weights: [0.18808092176914215, 0.02634560503065586, -0.11532500386238098, -0.3630158007144928, -0.3555148243904114, -0.5984928011894226],
    intercept: -14.360008239746094, threshold: 0.85,
    test: { precision: 0.988, recall: 0.963, iou: 0.953 }
  };
  M.classify = (preHH, preHV, postHH, postHV) => {
    const c = M.CLASSIFIER, f = [preHH, preHV, postHH, postHV, postHH - preHH, postHV - preHV];
    let z = c.intercept; for (let i = 0; i < 6; i++) z += c.weights[i] * f[i];
    return 1 / (1 + Math.exp(-z));
  };
})();
