/* SAR Atlas - data.js
 * Seeded synthetic NISAR-like data generator + the single data adapter.
 *
 * SCHEMA "sar-atlas/1" (in memory and on disk, see README):
 *   region   : id, name, bbox [w,s,e,n] (EPSG:4326), nx, ny  (row 0 = north)
 *   times    : ISO dates, one per monthly time step (T)
 *   v        : dynamic variables, Float32Array(T*N), index = t*N + j*nx + i
 *              HH, HV, VV (dB, gamma-0) | water (0..1 inundated fraction)
 *              veg (1 = vegetation lost since first date) | disp (LOS cm, cumulative)
 *              rain (mm/month) | urban (0/1 built) | roads (0/1 road/canal present)
 *   s        : static variables, Float32Array(N) / Uint8Array(N)
 *              pop (people/km2) | roadDist (km) | landuse (class id) | elev | rate
 *   series   : region-level series, e.g. rain Float32Array(T)
 *   simulated: true for everything this file generates. The UI labels it.
 */
(function () {
  'use strict';
  const SAR = (window.SAR = window.SAR || {});

  /* ---------------- seeded utilities ---------------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussFn(r) {
    let spare = null;
    return function () {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0; while (u === 0) u = r();
      const v = r(), m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    };
  }
  /** Smooth pseudo-noise in roughly [-1, 1]: a sum of seeded oriented sinusoids. */
  function makeNoise(r, octaves) {
    const comps = []; let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const f = Math.pow(2, o) * 2.2;
      for (let k = 0; k < 3; k++) {
        const a = r() * Math.PI * 2, w = 1 / Math.pow(2, o);
        comps.push([Math.cos(a) * f * 6.2832, Math.sin(a) * f * 6.2832, r() * 6.2832, w]);
        norm += w;
      }
    }
    return function (x, y) {
      let s = 0;
      for (let c = 0; c < comps.length; c++) { const q = comps[c]; s += q[3] * Math.sin(q[0] * x + q[1] * y + q[2]); }
      return (s / norm) * 1.6;
    };
  }
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
    t = clamp(t, 0, 1);
    const x = ax + t * dx - px, y = ay + t * dy - py;
    return Math.sqrt(x * x + y * y);
  }

  const NT = 30; // Jan 2024 .. Jun 2026, monthly
  function monthList(n) {
    const out = [];
    for (let k = 0; k < n; k++) out.push(`${2024 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-01`);
    return out;
  }

  /* Land-use classes shared by all regions (synthetic overlays). */
  const LANDUSE = [
    { id: 0, name: 'Open water', color: [44, 78, 120] },
    { id: 1, name: 'Wetland / marsh', color: [96, 150, 118] },
    { id: 2, name: 'Forest', color: [40, 110, 66] },
    { id: 3, name: 'Cropland', color: [214, 182, 92] },
    { id: 4, name: 'Pasture', color: [176, 150, 98] },
    { id: 5, name: 'Dense urban', color: [206, 98, 92] },
    { id: 6, name: 'Industrial / port', color: [150, 112, 196] },
    { id: 7, name: 'Residential', color: [226, 156, 124] },
    { id: 8, name: 'Protected forest', color: [28, 140, 120] },
    { id: 9, name: 'Green / open land', color: [138, 176, 96] }
  ];

  /* ---------------- region generators ---------------- */

  /** (1) Mississippi River Delta: wetland loss, spring floods, a hurricane surge, slow subsidence. */
  function genMississippi(c) {
    const { r, g, N, T, V, S, rainSeries, n1, n2, n3, dkm, cellKm, forCells } = c;
    const river = [[0.08, 0], [0.28, 0.2], [0.45, 0.4], [0.57, 0.6], [0.66, 0.78], [0.74, 0.97]];
    const canals = [
      [[0.16, 0.34], [0.4, 0.4]], [[0.1, 0.52], [0.42, 0.48]], [[0.6, 0.28], [0.9, 0.36]],
      [[0.68, 0.5], [0.95, 0.56]], [[0.22, 0.64], [0.47, 0.72]], [[0.3, 0.15], [0.3, 0.45]]
    ];
    const HUR = 19; // Aug 2025 (simulated storm)
    const clim = [130, 120, 115, 110, 130, 190, 170, 165, 150, 95, 105, 120];
    for (let t = 0; t < T; t++) rainSeries[t] = t === HUR ? 480 : clim[t % 12] * (1 + 0.18 * g());

    const sus = new Float32Array(N), swath = new Float32Array(N), tex = new Float32Array(N), road = new Uint8Array(N);
    forCells((k, u, v) => {
      const coast = 0.7 + 0.06 * Math.sin(u * 7 + 1) + 0.05 * n1(u * 1.3, 0.2);
      const dR = dkm(u, v, river);
      let dC = 1e9; for (const cn of canals) dC = Math.min(dC, dkm(u, v, cn));
      const ev = (coast - v) * 3.2 + 0.35 * n1(u, v) + (dR < 8 ? 0.9 * (1 - dR / 8) : 0); // relative elevation, m
      const lake = n2(u, v) < -0.72 && v < coast;
      let lu;
      if (v > coast || dR < cellKm * 0.6 || lake) lu = 0;
      else if (dR < 4 && ev > 0.8) lu = n2(u + 3, v) > 0.15 ? 5 : 3;
      else if (ev > 1.1) lu = n3(u, v) > 0 ? 3 : 2;
      else lu = 1;
      S.landuse[k] = lu; S.elev[k] = ev; S.roadDist[k] = Math.min(dR, dC);
      S.pop[k] = lu === 5 ? 900 + 600 * r() : lu === 3 ? 25 + 20 * r() : lu === 2 ? 8 : lu === 1 ? 1 + r() : 0;
      sus[k] = lu === 1 ? (1 - ev) * 0.7 + 0.55 * Math.exp(-dC / 3) + 0.3 * n2(u * 2, v * 2) + 0.4 * (v / coast) : -9;
      swath[k] = Math.exp(-Math.pow((u - 0.58) / 0.22, 2));
      tex[k] = 0.6 * n3(u * 4, v * 4);
      S.rate[k] = lu === 1 ? 1.0 + 0.9 * Math.max(0, 1 - ev) + 0.3 * g() : lu === 0 ? 0 : lu === 5 ? 0.8 + 0.2 * g() : 0.6 + 0.2 * g();
      road[k] = (dR < cellKm * 1.1 && lu !== 0) || dC < cellKm * 0.55 ? 1 : 0;
    });
    const thr0 = 1.3;
    for (let t = 0; t < T; t++) {
      const m = t % 12, yrs = t / 12, thr = thr0 - 0.0068 * t;
      const sf = [0, 0, 0.35, 0.8, 1, 0.55, 0.15, 0, 0, 0, 0, 0][m];
      const surge = t === HUR ? 1 : t === HUR + 1 ? 0.45 : t === HUR + 2 ? 0.12 : 0;
      const wind = 1.5 * g();
      for (let k = 0; k < N; k++) {
        const lu = S.landuse[k], e = S.elev[k];
        let lost = false;
        if (lu === 1) lost = sus[k] + (t >= HUR ? 0.22 * swath[k] : 0) > thr;
        let water = 0, hh, hv, vv;
        if (lu === 0 || lost) { water = 1; hh = -21 + wind * 0.8; hv = -27 + wind * 0.4; vv = -19 + wind; }
        else {
          const inund = (lu === 1 || lu === 2) && e < 0.3 * sf + 1.1 * surge + 0.02;
          if (inund) { water = 0.6; if (lu === 1) { hh = -5; vv = -9; hv = -16.5; } else { hh = -3; vv = -8; hv = -12; } } // double bounce
          else if (lu === 3 && surge > 0.4 && e < 1.4) { water = 0.5; hh = -15; vv = -14; hv = -22; }
          else if (lu === 1) { hh = -10.5; vv = -11.5; hv = -17.5; }
          else if (lu === 2) { hh = -7; vv = -8.5; hv = -12; }
          else if (lu === 3) { const gr = [0, 0, 0, 0.2, 0.6, 1, 1, 0.8, 0.4, 0, 0, 0][m]; hh = -11 + 2 * gr; vv = -11.5 + 2.5 * gr; hv = -20 + 5 * gr; }
          else { hh = -2.5; vv = -4.5; hv = -11; }
          hh += tex[k]; vv += tex[k]; hv += tex[k];
        }
        const i = t * N + k;
        V.HH[i] = hh; V.HV[i] = hv; V.VV[i] = vv; V.water[i] = water;
        V.veg[i] = lost && sus[k] <= thr0 ? 1 : 0;
        V.disp[i] = lu === 0 ? 0 : -(S.rate[k] * yrs) * 0.8 + 0.25 * Math.sin((2 * Math.PI * (m - 3)) / 12) + 0.15 * g();
        V.urban[i] = lu === 5 ? 1 : 0; V.roads[i] = road[k];
      }
    }
  }

  /** (2) Rondonia, Brazil: fishbone deforestation along BR-364 side roads, dry-season clearing, a protected reserve. */
  function genRondonia(c) {
    const { r, g, N, T, V, S, rainSeries, n1, n2, n3, dkm, cellKm, forCells } = c;
    const main = [[0, 0.26], [0.36, 0.4], [0.68, 0.58], [1, 0.74]];
    const river = [[0, 0.86], [0.25, 0.8], [0.5, 0.93], [0.78, 0.86], [1, 0.96]];
    const inReserve = (u, v) => Math.pow((u - 0.8) / 0.17, 2) + Math.pow((v - 0.22) / 0.13, 2) < 1;
    const town = [0.47, 0.47];
    const clim = [290, 300, 280, 200, 90, 30, 15, 25, 60, 130, 190, 260];
    for (let t = 0; t < T; t++) rainSeries[t] = clim[t % 12] * clamp(1 + 0.15 * g(), 0.5, 1.6);

    // side roads, perpendicular to the main highway (the "fishbone" pattern)
    const segLen = []; let tot = 0;
    for (let k = 0; k < main.length - 1; k++) { const l = Math.hypot(main[k + 1][0] - main[k][0], main[k + 1][1] - main[k][1]); segLen.push(l); tot += l; }
    const roads = []; let idx = 0;
    for (let f = 0.05; f < 0.96; f += 0.068, idx++) {
      let d = f * tot, s = 0; while (s < segLen.length - 1 && d > segLen[s]) { d -= segLen[s]; s++; }
      const a = main[s], b = main[s + 1], q = d / segLen[s];
      const P = [a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q];
      const tx = (b[0] - a[0]) / segLen[s], ty = (b[1] - a[1]) / segLen[s];
      for (const side of [1, -1]) {
        let L = 0.16 + 0.14 * r();
        let E = [P[0] - ty * side * L, P[1] + tx * side * L];
        for (let z = 0; z < 6 && inReserve(E[0], E[1]); z++) { L *= 0.75; E = [P[0] - ty * side * L, P[1] + tx * side * L]; }
        roads.push({ pts: [P, E], tb: idx % 3 !== 1 ? 0 : 3 + Math.floor(r() * 24) });
      }
    }
    const R = new Float32Array(T); let acc = 2.4;
    for (let t = 0; t < T; t++) { const m = t % 12; acc += m >= 5 && m <= 9 ? 0.09 : 0.012; R[t] = acc; }

    const clearedAt = new Uint8Array(N), river1 = new Uint8Array(N), townC = new Uint8Array(N), flood = new Uint8Array(N), roadT = new Uint8Array(N);
    const dT = new Float32Array(T);
    forCells((k, u, v) => {
      const dM = dkm(u, v, main), dRv = dkm(u, v, river);
      const dTown = Math.hypot((u - town[0]) * c.Wkm, (v - town[1]) * c.Hkm);
      const rd = roads.map((ro) => dkm(u, v, ro.pts));
      for (let t = 0; t < T; t++) { let m = dM; for (let q = 0; q < roads.length; q++) if (roads[q].tb <= t && rd[q] < m) m = rd[q]; dT[t] = m; }
      const res = inReserve(u, v); river1[k] = dRv < cellKm * 0.55 ? 1 : 0; townC[k] = dTown < 3.5 ? 1 : 0;
      flood[k] = dRv < 4 && !river1[k] ? 1 : 0;
      const patch = 1.4 * n1(u * 1.7, v * 1.7) + 0.6 * n2(u * 4, v * 4);
      let ca = 255;
      if (!res && !river1[k] && !townC[k]) for (let t = 0; t < T; t++) if (dT[t] + patch < R[t]) { ca = t; break; }
      clearedAt[k] = ca;
      let rt = 255; for (let t = 0; t < T; t++) if (dT[t] < cellKm * 0.55 && !res) { rt = t; break; }
      roadT[k] = rt;
      S.roadDist[k] = dT[T - 1];
      let lu;
      if (river1[k]) lu = 0; else if (townC[k]) lu = 5; else if (res) lu = 8;
      else if (ca === 0) lu = dM < 5 && n3(u * 3, v * 3) > 0.25 ? 3 : 4; else lu = 2;
      S.landuse[k] = lu;
      S.pop[k] = townC[k] ? 600 + 400 * r() : dT[0] < 3 ? 12 + 6 * r() : 0.6;
      S.elev[k] = 120 + 30 * n1(u, v); S.rate[k] = 0;
    });
    for (let t = 0; t < T; t++) {
      const m = t % 12, wet = clamp(rainSeries[t] / 300, 0, 1.2);
      const grow = [1, 1, 0.7, 0.3, 0, 0, 0, 0, 0, 0.2, 0.6, 0.9][m];
      for (let k = 0; k < N; k++) {
        const i = t * N + k, lu = S.landuse[k], ca = clearedAt[k];
        let hh, hv, vv, water = 0;
        if (river1[k]) { water = 1; hh = -20 + 0.8 * g(); hv = -27; vv = -18; }
        else if (townC[k]) { hh = -4; vv = -6; hv = -13; }
        else if (ca <= t) {
          const burn = t - ca <= 1 && ca > 0 ? 1 : 0;
          if (lu === 3) { hh = -12 + 2 * wet + 1.5 * grow; vv = -11 + 2 * wet + 2 * grow; hv = -21 + 6 * grow; }
          else { hh = -11.5 + 2.2 * wet - 2.5 * burn; vv = -10.5 + 1.8 * wet - 2 * burn; hv = -19 + 1.6 * wet - 1.5 * burn; }
        } else if (flood[k] && wet > 0.85) { water = 0.5; hh = -4.5; vv = -8; hv = -12.5; } // flooded forest, double bounce
        else { hh = -7.2 + 0.3 * wet; vv = -8.2 + 0.3 * wet; hv = -12.2 + 0.2 * wet; }
        V.HH[i] = hh; V.HV[i] = hv; V.VV[i] = vv; V.water[i] = water;
        V.veg[i] = ca <= t && ca > 0 ? 1 : 0;
        V.disp[i] = river1[k] ? 0 : 0.3 * Math.sin((2 * Math.PI * (m - 1)) / 12) * (ca <= t ? 1 : 0.3) + 0.2 * g();
        V.urban[i] = townC[k]; V.roads[i] = roadT[k] <= t ? 1 : 0;
      }
    }
  }

  /** (3) Jakarta: groundwater-driven subsidence bowls, monsoon floods that grow as land sinks, urban growth. */
  function genJakarta(c) {
    const { r, g, N, T, V, S, rainSeries, n1, n2, n3, dkm, cellKm, forCells, Hkm, Wkm } = c;
    const hot = [{ u: 0.3, v: 0.17, a: 13, s: 3.2 }, { u: 0.73, v: 0.22, a: 9, s: 3.8 }, { u: 0.52, v: 0.19, a: 5, s: 2.2 }];
    const waterways = [[[0.5, 1], [0.47, 0.6], [0.49, 0.3], [0.47, 0.12]], [[0.25, 0.45], [0.38, 0.4], [0.35, 0.12]], [[0.62, 0.55], [0.7, 0.35], [0.78, 0.12]]];
    const tolls = [
      [[0.2, 0.3], [0.5, 0.25], [0.8, 0.32], [0.82, 0.6], [0.5, 0.68], [0.2, 0.6], [0.2, 0.3]],
      [[0.05, 0.2], [0.4, 0.18], [0.95, 0.2]], [[0.5, 0.68], [0.52, 1]], [[0, 0.45], [0.2, 0.45]], [[0.82, 0.45], [1, 0.47]]
    ];
    const clim = [390, 340, 240, 180, 130, 95, 60, 50, 70, 115, 165, 260];
    for (let t = 0; t < T; t++) rainSeries[t] = clim[t % 12] * clamp(1 + 0.15 * g(), 0.5, 1.5);
    rainSeries[12] = 620; rainSeries[25] = 520; // simulated extreme monsoon months
    const pond = new Uint8Array(N), growT = new Uint8Array(N), e0 = new Float32Array(N), dco = new Float32Array(N), road = new Uint8Array(N);
    forCells((k, u, v) => {
      const coast = 0.13 + 0.025 * Math.sin(u * 11) + 0.02 * n1(u, 0.1);
      const sea = v < coast, dcoast = Math.max(0, (v - coast) * Hkm);
      let hs = 0; for (const h of hot) { const d2 = Math.pow((u - h.u) * Wkm, 2) + Math.pow((v - h.v) * Hkm, 2); hs += h.a * Math.exp(-d2 / (2 * h.s * h.s)); }
      let dW = 1e9; for (const w of waterways) dW = Math.min(dW, dkm(u, v, w));
      let dRd = 1e9; for (const w of tolls) dRd = Math.min(dRd, dkm(u, v, w));
      let lu;
      if (sea || dW < cellKm * 0.5) lu = 0;
      else if (u < 0.26 && dcoast < 2.2 && n2(u, v) > -0.3) { lu = 0; pond[k] = 1; }
      else if (dcoast < 5 && ((u > 0.62 && n2(u, v) > -0.1) || (u < 0.3 && n2(u, v) > 0.25))) lu = 6;
      else if (v < 0.62) lu = n2(u * 3, v * 3) < -0.35 ? 7 : 5;
      else lu = n1(u * 2, v * 2) > -0.05 ? 7 : 9;
      S.landuse[k] = lu; dco[k] = dcoast;
      growT[k] = lu === 9 && n2(u * 2 + 5, v * 2) > 0 ? 3 + Math.floor(r() * 26) : 255;
      let rate = lu === 0 ? 0 : 0.5 + hs * (lu === 6 ? 1.25 : lu === 5 ? 1 : 0.7) + 2.5 * Math.exp(-dcoast / 2.5) + 0.35 * n3(u * 3, v * 3);
      if (lu === 9) rate *= 0.5;
      S.rate[k] = lu === 0 ? 0 : clamp(rate, 0.2, 28);
      e0[k] = -0.2 + 0.22 * dcoast + 0.5 * n1(u * 2, v * 2) - 0.06 * hs; S.elev[k] = e0[k];
      S.pop[k] = lu === 5 ? 14000 + 4000 * r() : lu === 7 ? 8000 + 3000 * r() : lu === 6 ? 2500 + 800 * r() : lu === 9 ? 900 : 0;
      S.roadDist[k] = dRd; road[k] = dRd < cellKm * 0.6 ? 1 : 0;
    });
    for (let t = 0; t < T; t++) {
      const m = t % 12, yrs = t / 12, wind = 1.2 * g();
      const L = rainSeries[t] >= 250 ? 0.15 + (rainSeries[t] - 250) / 500 : -9; // flood water level, m
      const rice = [1, 1, 0.8, 0.3, 0, 0, 0, 0, 0, 0.2, 0.5, 0.8][m];
      for (let k = 0; k < N; k++) {
        const i = t * N + k, lu = S.landuse[k];
        const e = e0[k] - (S.rate[k] * yrs) / 100;
        const built = lu === 5 || lu === 6 || lu === 7 || growT[k] <= t;
        let hh, hv, vv, water = 0;
        if (lu === 0) { water = 1; if (pond[k]) { hh = -17.5; vv = -16; hv = -25; } else { hh = -21 + wind; vv = -19 + wind; hv = -27.5; } }
        else if (dco[k] < 14 && e < L) { water = 0.7; if (built) { hh = -1.5; vv = -5; hv = -12; } else { hh = -18; vv = -16; hv = -24; } }
        else if (lu === 6) { hh = -1.5; vv = -3.5; hv = -10.5; }
        else if (lu === 5) { hh = -2.5; vv = -4.5; hv = -10.8; }
        else if (growT[k] === t) { hh = -9; vv = -9.5; hv = -18; } // construction: bare soil
        else if (built) { hh = -5; vv = -6.5; hv = -13; }
        else { hh = -9.5 + 1.5 * rice; vv = -10; hv = -16 + 2.5 * rice; }
        V.HH[i] = hh; V.HV[i] = hv; V.VV[i] = vv; V.water[i] = water;
        V.veg[i] = growT[k] <= t ? 1 : 0;
        V.disp[i] = lu === 0 ? 0 : -(S.rate[k] * yrs) * 0.8 + 0.4 * Math.sin((2 * Math.PI * (m + 2)) / 12) + 0.25 * g();
        V.urban[i] = built ? 1 : 0; V.roads[i] = road[k];
      }
    }
  }

  /* ---------------- region catalogue ---------------- */
  const DEFS = {
    mississippi: {
      id: 'mississippi', seed: 1803, name: 'Mississippi River Delta', place: 'Louisiana, USA',
      theme: 'Wetland loss and flooding', bbox: [-90.4, 28.95, -89.2, 29.85], dispCap: 6,
      primary: 'water', gen: genMississippi
    },
    rondonia: {
      id: 'rondonia', seed: 3640, name: 'Rondonia Frontier', place: 'Rondonia, Brazil',
      theme: 'Deforestation', bbox: [-63.6, -10.5, -62.4, -9.5], dispCap: 3,
      primary: 'veg', gen: genRondonia
    },
    jakarta: {
      id: 'jakarta', seed: 6210, name: 'Jakarta Bay', place: 'Jakarta, Indonesia',
      theme: 'Land subsidence', bbox: [106.68, -6.36, 107.0, -6.04], dispCap: 45,
      primary: 'disp', gen: genJakarta
    }
  };

  function build(def) {
    const r = mulberry32(def.seed), g = gaussFn(r);
    const nx = 64, ny = 64, N = nx * ny, T = NT;
    const [w, s, e, n] = def.bbox, latc = (s + n) / 2;
    const Wkm = (e - w) * 111.32 * Math.cos((latc * Math.PI) / 180), Hkm = (n - s) * 110.57;
    const dyn = () => new Float32Array(T * N);
    const V = { HH: dyn(), HV: dyn(), VV: dyn(), water: dyn(), veg: dyn(), disp: dyn(), rain: dyn(), urban: dyn(), roads: dyn() };
    const S = { pop: new Float32Array(N), roadDist: new Float32Array(N), landuse: new Uint8Array(N), elev: new Float32Array(N), rate: new Float32Array(N) };
    const rainSeries = new Float32Array(T);
    const ctx = {
      r, g, nx, ny, N, T, Wkm, Hkm, V, S, rainSeries, cellKm: Math.sqrt((Wkm / nx) * (Hkm / ny)),
      n1: makeNoise(r, 4), n2: makeNoise(r, 3), n3: makeNoise(r, 2),
      /** distance (km) from cell (u,v) to a polyline given in unit coordinates */
      dkm(u, v, pts) {
        let d = 1e9; const px = u * Wkm, py = v * Hkm;
        for (let k = 0; k < pts.length - 1; k++) d = Math.min(d, distSeg(px, py, pts[k][0] * Wkm, pts[k][1] * Hkm, pts[k + 1][0] * Wkm, pts[k + 1][1] * Hkm));
        return d;
      },
      forCells(fn) { for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) fn(j * nx + i, (i + 0.5) / nx, (j + 0.5) / ny); }
    };
    def.gen(ctx);
    // multilook speckle residual (~0.6 dB) on every polarization
    for (const p of ['HH', 'HV', 'VV']) { const a = V[p]; for (let k = 0; k < a.length; k++) a[k] += g() * 0.6; }
    // per-cell rainfall: region series with a gentle spatial gradient
    const rg = makeNoise(r, 2);
    ctx.forCells((k, u, v) => { const f = 1 + 0.12 * rg(u, v); for (let t = 0; t < T; t++) V.rain[t * N + k] = rainSeries[t] * f; });
    return finalize({
      schema: 'sar-atlas/1', simulated: true, source: 'Seeded synthetic generator (SAR Atlas data.js), seed ' + def.seed,
      id: def.id, name: def.name, place: def.place, theme: def.theme, bbox: def.bbox, nx, ny, N, T,
      times: monthList(T), Wkm, Hkm, cellKm2: (Wkm / nx) * (Hkm / ny), dispCap: def.dispCap, primary: def.primary,
      v: V, s: S, series: { rain: rainSeries }
    });
  }

  function finalize(ds) {
    ds.landuse = LANDUSE;
    ds.cellCenter = (k) => {
      const i = k % ds.nx, j = Math.floor(k / ds.nx), [w, s, e, n] = ds.bbox;
      return { lon: w + ((i + 0.5) * (e - w)) / ds.nx, lat: n - ((j + 0.5) * (n - s)) / ds.ny };
    };
    ds.cellAt = (lon, lat) => {
      const [w, s, e, n] = ds.bbox;
      if (lon < w || lon > e || lat < s || lat > n) return -1;
      const i = Math.min(ds.nx - 1, Math.floor(((lon - w) / (e - w)) * ds.nx));
      const j = Math.min(ds.ny - 1, Math.floor(((n - lat) / (n - s)) * ds.ny));
      return j * ds.nx + i;
    };
    return ds;
  }

  /* ---------------- JSON (de)serialisation for real data ---------------- */
  function b64ToF32(b64) {
    const bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Float32Array(buf.buffer);
  }
  function arr(x, len) {
    if (x == null) { const a = new Float32Array(len); a.fill(NaN); return a; }
    if (typeof x === 'string') return b64ToF32(x);
    if (x.b64) return b64ToF32(x.b64);
    return Float32Array.from(x);
  }
  /** Normalise a JSON document written by preprocess/nisar_to_atlas.py into the in-memory schema. */
  function fromJSON(j) {
    const nx = j.region.nx, ny = j.region.ny, N = nx * ny, T = j.times.length, [w, s, e, n] = j.region.bbox;
    const latc = (s + n) / 2, Wkm = (e - w) * 111.32 * Math.cos((latc * Math.PI) / 180), Hkm = (n - s) * 110.57;
    const v = {}; for (const key of ['HH', 'HV', 'VV', 'water', 'veg', 'disp', 'rain', 'urban', 'roads']) v[key] = arr(j.variables && j.variables[key], T * N);
    const st = {}; for (const key of ['pop', 'roadDist', 'elev', 'rate']) st[key] = arr(j.static && j.static[key], N);
    st.landuse = Uint8Array.from(arr(j.static && j.static.landuse, N), (x) => (Number.isFinite(x) ? x : 2));
    const rain = j.series && j.series.rain ? arr(j.series.rain, T) : Float32Array.from({ length: T }, (_, t) => { let a = 0, c = 0; for (let k = 0; k < N; k++) { const q = v.rain[t * N + k]; if (Number.isFinite(q)) { a += q; c++; } } return c ? a / c : NaN; });
    return finalize({
      schema: j.schema || 'sar-atlas/1', simulated: j.simulated !== false ? !!j.simulated : false, source: j.source || 'external file',
      id: j.region.id, name: j.region.name, place: j.region.place || '', theme: j.region.theme || 'Surface change', bbox: j.region.bbox,
      nx, ny, N, T, times: j.times, Wkm, Hkm, cellKm2: (Wkm / nx) * (Hkm / ny), dispCap: j.region.dispCap || 10, primary: j.region.primary || 'water',
      v, s: st, series: { rain }
    });
  }

  /* ---------------- the adapter: one loader function ---------------- */
  const cache = {};
  SAR.config = Object.assign({ realDataBase: null }, SAR.config || {});
  /**
   * loadRegion(id) -> Promise<dataset>
   * Order: window.SAR_REAL_DATA[id] (inline JSON) -> SAR.config.realDataBase + id + '.json' (served) -> synthetic generator.
   */
  async function loadRegion(id) {
    if (cache[id]) return cache[id];
    let raw = window.SAR_REAL_DATA && window.SAR_REAL_DATA[id];
    if (!raw && SAR.config.realDataBase) {
      try { const res = await fetch(SAR.config.realDataBase + id + '.json'); if (res.ok) raw = await res.json(); } catch (e) { /* fall back to synthetic */ }
    }
    const ds = raw ? fromJSON(raw) : build(DEFS[id]);
    cache[id] = ds;
    return ds;
  }

  SAR.data = {
    loadRegion, fromJSON, LANDUSE,
    regions: Object.values(DEFS).map((d) => ({ id: d.id, name: d.name, place: d.place, theme: d.theme, bbox: d.bbox })),
    _build: (id) => build(DEFS[id])
  };
})();
