/* SAR Atlas - app.js
 * Application state, UI wiring, panels, compare, forecasting UI, correlation, human impact,
 * explain, story mode, researcher tools, exports and the reproducibility log.
 */
(function () {
  'use strict';
  const SAR = window.SAR, D = SAR.data, M = SAR.models, R = SAR.render, C = SAR.charts, K = SAR.content;
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  const fin = Number.isFinite, f1 = (x) => (fin(x) ? x.toFixed(1) : 'n/a'), f2 = (x) => (fin(x) ? x.toFixed(2) : 'n/a');
  const fmtInt = (x) => (fin(x) ? Math.round(x).toLocaleString('en-US') : 'n/a');
  const ico = (id) => `<svg class="ic"><use href="#${id}"/></svg>`;
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  /* ======================= state ======================= */
  const st = {
    region: 'mississippi', t: 0, refT: 0, playing: false, speed: 1, loop: true,
    layer: 'water', pol: 'HV', opacity: 0.85, threshold: 3,
    overlays: { landuse: false, pop: false, roads: false }, ovOpacity: 0.55,
    compare: { on: false, mode: 'swipe', a: 0, b: 29, split: 0.5 },
    mode: 'explorer', tab: 'inspect', cell: null,
    expr: 'HV - HH', exprFn: null, exprRange: null,
    roi: null, roiCells: null, drawing: false, roiPts: [],
    fc: { target: null, scope: 'region', model: 'holt', horizon: 12 },
    scen: { rain: 0, defor: 0, pump: 0 },
    corr: { x: 'rain', y: 'water' }, corrField: null, corrLabel: '',
    level: 'simple', reducedMotion: window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches,
    narrate: false, basemap: 'satellite'
  };
  let ds = null, globe = null, fieldCache = null;
  const opLog = [];

  /* ======================= helpers ======================= */
  function log(op, params) {
    opLog.push({ time: new Date().toISOString(), op, params: params || {} });
    const ol = $('#opLog'); if (!ol) return;
    const e = opLog[opLog.length - 1];
    const li = document.createElement('li');
    li.innerHTML = `<span class="op-t">${e.time.slice(11, 19)}</span><span><span class="op-n">${e.op}</span> ${escapeHtml(JSON.stringify(e.params)).slice(0, 140)}</span>`;
    ol.prepend(li);
    while (ol.children.length > 200) ol.lastChild.remove();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  let toastTm = null;
  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTm); toastTm = setTimeout(() => (t.hidden = true), ms || 3600); }
  function showLoading(txt) { $('#loadingText').textContent = txt; const l = $('#loading'); l.hidden = false; l.classList.remove('done'); }
  function hideLoading() { const l = $('#loading'); l.classList.add('done'); setTimeout(() => { if (l.classList.contains('done')) l.hidden = true; }, 350); }
  const flyDur = (d) => (st.reducedMotion ? 0 : d);
  const date = (t) => ds.times[t].slice(0, 7);
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const landCells = () => { const out = []; for (let k = 0; k < ds.N; k++) if (ds.s.landuse[k] !== 0) out.push(k); return out; };

  /* ======================= series ======================= */
  const FT = {
    water: { l: 'Water extent', u: 'km2', cu: 'fraction' },
    veg: { l: 'Vegetation lost (cumulative)', u: 'km2', cu: '0 / 1' },
    disp: { l: 'Mean LOS displacement', u: 'cm', cu: 'cm' },
    rain: { l: 'Rainfall', u: 'mm / month', cu: 'mm / month' },
    HV: { l: 'HV backscatter (mean power)', u: 'dB', cu: 'dB' },
    HH: { l: 'HH backscatter (mean power)', u: 'dB', cu: 'dB' }
  };
  /** Aggregate a target over the chosen scope. Areas sum (km2); dB values average in linear power. */
  function targetSeries(key, scope) {
    const N = ds.N, T = ds.T, out = new Float64Array(T);
    let cells = scope === 'cell' && st.cell != null ? [st.cell] : scope === 'roi' && st.roiCells && st.roiCells.length ? st.roiCells : null;
    const single = cells && cells.length === 1;
    if (!cells) cells = key === 'disp' ? landCells() : Array.from({ length: N }, (_, k) => k);
    if (key === 'disp') cells = cells.filter((k) => ds.s.landuse[k] !== 0);
    for (let t = 0; t < T; t++) {
      let s = 0, n = 0;
      for (const k of cells) {
        const i = t * N + k;
        if (key === 'water' || key === 'veg') s += ds.v[key][i];
        else if (key === 'HH' || key === 'HV') s += Math.pow(10, ds.v[key][i] / 10);
        else s += ds.v[key][i];
        n++;
      }
      if (!n) { out[t] = NaN; continue; }
      if (key === 'water' || key === 'veg') out[t] = single ? s : s * ds.cellKm2;
      else if (key === 'HH' || key === 'HV') out[t] = 10 * Math.log10(s / n);
      else out[t] = s / n;
    }
    return { y: Array.from(out), unit: single && (key === 'water' || key === 'veg') ? FT[key].cu : FT[key].u, label: FT[key].l };
  }

  const CV = {
    HH: { l: 'HH backscatter', u: 'dB' }, HV: { l: 'HV backscatter', u: 'dB' }, VV: { l: 'VV backscatter', u: 'dB' },
    ratio: { l: 'HV - HH ratio', u: 'dB' }, water: { l: 'Water fraction', u: '0-1' }, vegNew: { l: 'New vegetation loss', u: 'per month' },
    disp: { l: 'LOS displacement', u: 'cm' }, rain: { l: 'Rainfall', u: 'mm' }, pop: { l: 'Population density', u: 'per km2', stat: true }, roadDist: { l: 'Distance to road', u: 'km', stat: true }
  };
  function cellVal(key, t, k) {
    const N = ds.N, i = t * N + k, v = ds.v;
    switch (key) {
      case 'HH': case 'HV': case 'VV': return v[key][i];
      case 'ratio': return v.HV[i] - v.HH[i];
      case 'water': return v.water[i];
      case 'vegNew': return t ? v.veg[i] - v.veg[i - N] : NaN;
      case 'disp': return v.disp[i];
      case 'rain': return v.rain[i];
      case 'pop': return ds.s.pop[k];
      case 'roadDist': return ds.s.roadDist[k];
    }
    return NaN;
  }
  function meanSeries(key, cells) {
    const out = [];
    for (let t = 0; t < ds.T; t++) { let s = 0, n = 0; for (const k of cells) { const x = cellVal(key, t, k); if (fin(x)) { s += x; n++; } } out.push(n ? s / n : NaN); }
    return out;
  }

  /* ======================= rendering ======================= */
  function refreshFrame() {
    if (!ds) return;
    const fld = R.field(ds, st, st.t); fieldCache = fld;
    const px = R.compose(ds, st, st.t, fld), canvas = R.toCanvas(ds, px, st, st.t, 8);
    globe.setOverlay({ canvas, px, bbox: ds.bbox, nx: ds.nx, ny: ds.ny });
    // legend
    let extra = '';
    if (st.layer === 'backscatter' || st.layer === 'change') extra = st.pol;
    if (['vegloss', 'disp', 'change', 'classifier'].includes(st.layer)) extra = (extra ? extra + ' / ' : '') + 'ref ' + date(st.refT);
    if (st.layer === 'corrmap') extra = st.corrLabel;
    $('#legend').innerHTML = R.legendHTML(st.layer, fld.range, extra);
    // time readouts
    const d = date(st.t);
    $('#topDate').textContent = d; $('#dockDate').textContent = d; $('#dockIdx').textContent = `T${String(st.t + 1).padStart(2, '0')} / ${ds.T}`;
    const sl = $('#timeSlider'); sl.value = st.t; sl.style.setProperty('--p', (st.t / (ds.T - 1)) * 100 + '%'); sl.setAttribute('aria-valuetext', d);
    updateDockMetric();
  }

  function updateDockMetric() {
    const key = ds.primary, s = targetSeries(key, 'region'), v = s.y[st.t];
    $('#dockMetric').innerHTML = `${s.label}: <b>${key === 'disp' ? f2(v) : fmtInt(v)}</b> ${s.unit}`;
    // sparkline
    const y = s.y, lo = Math.min(...y), hi = Math.max(...y), W = 600, H = 26, X = (i) => (i / (y.length - 1)) * W, Y = (q) => H - 3 - ((q - lo) / (hi - lo || 1)) * (H - 6);
    let dpath = ''; y.forEach((q, i) => (dpath += (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(q).toFixed(1)));
    $('#dockSpark').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${dpath} L${W},${H} L0,${H} Z" fill="rgba(242,165,65,.08)"/><path d="${dpath}" fill="none" stroke="#f2a541" stroke-width="1.2" vector-effect="non-scaling-stroke"/><line x1="${X(st.t)}" x2="${X(st.t)}" y1="0" y2="${H}" stroke="#e6ebf1" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function setT(t, opts) {
    st.t = Math.max(0, Math.min(ds.T - 1, t));
    refreshFrame();
    const live = ['inspect', 'explain'].includes(st.tab) || (!st.playing && ['impact', 'correlate'].includes(st.tab));
    if (live) renderTab();
    if (st.cell != null && st.tab !== 'inspect') { /* marker stays */ }
    if (!opts || !opts.silent) { clearTimeout(setT._tm); setT._tm = setTimeout(() => log('time', { date: date(st.t) }), 600); }
  }

  /* ======================= playback ======================= */
  let rafId = null, lastStep = 0;
  function play(on) {
    st.playing = on;
    $('#playIcon').innerHTML = `<use href="#i-${on ? 'pause' : 'play'}"/>`;
    $('#playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) { if (st.t >= ds.T - 1 && !st.loop) setT(0, { silent: true }); lastStep = performance.now(); rafId = requestAnimationFrame(tick); }
    else { cancelAnimationFrame(rafId); renderTab(); }
  }
  function tick(now) {
    if (!st.playing) return;
    const interval = 650 / st.speed;
    if (now - lastStep >= interval) {
      lastStep = now;
      if (st.t >= ds.T - 1) { if (st.loop) setT(0, { silent: true }); else { play(false); return; } }
      else setT(st.t + 1, { silent: true });
    }
    rafId = requestAnimationFrame(tick);
  }

  /* ======================= regions ======================= */
  async function selectRegion(id, opts) {
    opts = opts || {};
    if (st.playing) play(false);
    showLoading('Generating simulated radar stack');
    await new Promise((r) => setTimeout(r, 30));
    ds = await D.loadRegion(id);
    st.region = id; st.cell = null; st.corrField = null; clearRoi(true);
    if (st.layer === 'corrmap') st.layer = 'water';
    st.t = opts.t != null ? opts.t : ds.T - 1;
    st.refT = 0; st.compare.a = 0; st.compare.b = ds.T - 1;
    st.fc.target = ds.primary;
    st.corr = ds.id === 'rondonia' ? { x: 'rain', y: 'vegNew' } : ds.id === 'jakarta' ? { x: 'pop', y: 'disp' } : { x: 'rain', y: 'water' };
    if (!opts.keepLayer) st.layer = ds.primary === 'veg' ? 'vegloss' : ds.primary === 'disp' ? 'disp' : 'water';
    $('#timeSlider').max = ds.T - 1;
    const badge = $('.sim-badge');
    badge.lastChild.textContent = ds.simulated ? 'SIMULATED DEMO DATA' : 'EXTERNAL DATA';
    badge.dataset.tip = ds.simulated ? 'Every value is produced by a seeded synthetic generator that mimics radar physics. Not real observations.' : 'Loaded from file: ' + ds.source;
    fillDateSelects();
    $$('.region-card').forEach((c) => c.setAttribute('aria-current', c.dataset.id === id ? 'true' : 'false'));
    globe.setRegions(D.regions, id); globe.setMarker(null);
    renderLayerList(); syncPol();
    if (opts.fly !== false) globe.flyToRect(ds.bbox, flyDur(opts.dur != null ? opts.dur : 2.6));
    refreshFrame(); updateCompare(); renderTab(); renderTicks();
    hideLoading();
    log('region', { id, simulated: ds.simulated });
  }

  function fillDateSelects() {
    const opts = ds.times.map((d, i) => `<option value="${i}">${d.slice(0, 7)}</option>`).join('');
    for (const id of ['#cmpA', '#cmpB', '#refDate']) $(id).innerHTML = opts;
    $('#cmpA').value = st.compare.a; $('#cmpB').value = st.compare.b; $('#refDate').value = st.refT;
    $('#dockStart').textContent = date(0); $('#dockEnd').textContent = date(ds.T - 1);
  }
  function renderTicks() {
    let h = '';
    for (let t = 0; t < ds.T; t += 3) {
      const m = +ds.times[t].slice(5, 7), yr = m === 1;
      h += `<span class="${yr ? 'yr' : ''}" style="left:${(t / (ds.T - 1)) * 100}%">${yr ? ds.times[t].slice(0, 4) : C.monthLbl(ds.times[t]).slice(0, 3)}</span>`;
    }
    $('#dockTicks').innerHTML = h;
  }

  /* ======================= layer & overlays ======================= */
  function renderLayerList() {
    const keys = Object.keys(R.LAYERS).filter((k) => !R.LAYERS[k].hidden || (k === 'corrmap' && st.corrField)).filter((k) => !R.LAYERS[k].researcher || st.mode === 'researcher');
    $('#layerList').innerHTML = keys.map((k) => {
      const L = R.LAYERS[k];
      return `<button class="layer-opt" role="radio" aria-checked="${k === st.layer}" data-layer="${k}" data-tip="${escapeHtml(L.desc)}"><span class="sw-ramp" style="background:${R.rampCss(L.ramp)}"></span><span class="lo-name">${L.label}</span>${L.researcher ? '<span class="lo-badge">RES</span>' : ''}</button>`;
    }).join('');
  }
  function setLayer(k, quiet) {
    if (k === 'bandmath' && !st.exprFn) applyExpr(true);
    st.layer = k; renderLayerList(); refreshFrame(); updateCompare();
    if (['inspect', 'explain'].includes(st.tab)) renderTab();
    if (!quiet) log('layer', { layer: k });
  }
  function syncPol() { $$('#polSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.pol === st.pol)); }
  function renderOvLegend() {
    let h = '';
    if (st.overlays.landuse) { const used = new Set(ds.s.landuse); h += ds.landuse.filter((c) => used.has(c.id) && c.id !== 0).map((c) => `<span><i style="background:rgb(${c.color})"></i>${c.name}</span>`).join(''); }
    if (st.overlays.pop) h += `<span><i style="background:${R.rampCss('magma')};width:28px"></i>people / km2 (log)</span>`;
    if (st.overlays.roads) h += `<span><i style="background:#f2f5f8;height:2px;vertical-align:3px"></i>roads, canals</span><span><i style="background:rgba(236,240,245,.4)"></i>built-up</span>`;
    $('#ovLegend').innerHTML = h;
  }

  /* ======================= compare ======================= */
  function updateCompare() {
    const on = st.compare.on && ds;
    $('#compareSection').classList.toggle('cmp-on', !!on);
    if (!on) { globe.setCompare(null); $('#swipe').hidden = true; $('#compareSheet').hidden = true; return; }
    const a = st.compare.a, b = st.compare.b;
    const fA = R.field(ds, st, a), fB = R.field(ds, st, b);
    const pxA = R.compose(ds, st, a, fA), pxB = R.compose(ds, st, b, fB);
    const cA = R.toCanvas(ds, pxA, st, a, 8), cB = R.toCanvas(ds, pxB, st, b, 8);
    const diff = R.difference(ds, st, a, b), m = diff.metric;
    const u = m.unit ? ' ' + m.unit : '';
    $('#cmpStats').innerHTML = `<dl class="kv">
      <dt>Metric</dt><dd>${m.label}</dd>
      <dt>Change threshold</dt><dd>+/- ${m.thr}${u}</dd>
      <dt>Gained area</dt><dd class="gain">${f1(diff.gainKm2)} km2</dd>
      <dt>Lost area</dt><dd class="loss">${f1(diff.lossKm2)} km2</dd>
      <dt>Net</dt><dd>${f1(diff.gainKm2 - diff.lossKm2)} km2</dd>
      ${diff.extentA != null ? `<dt>Extent A / B</dt><dd>${fmtInt(diff.extentA)} / ${fmtInt(diff.extentB)} km2</dd>` : `<dt>Mean A / B</dt><dd>${f2(diff.meanA)} / ${f2(diff.meanB)}${u}</dd>`}
      <dt>% change</dt><dd>${fin(diff.pct) ? (diff.pct >= 0 ? '+' : '') + diff.pct.toFixed(1) + '%' : 'n/a'}</dd></dl>
      <div class="hint small">${m.key === 'disp' ? 'Gained = uplift, lost = subsidence.' : m.unit === 'dB' ? 'Percent change is in mean backscattered power.' : 'Percent change is in total inundated area.'}</div>`;
    $('#swipeTagA').textContent = 'A  ' + date(a); $('#swipeTagB').textContent = 'B  ' + date(b);
    if (st.compare.mode === 'swipe') {
      $('#compareSheet').hidden = true; $('#swipe').hidden = false;
      globe.setCompare({ a: cA, b: cB, pxA, pxB, bbox: ds.bbox, nx: ds.nx, ny: ds.ny }); setSplit(st.compare.split);
    } else {
      globe.setCompare(null); $('#swipe').hidden = true; $('#compareSheet').hidden = false;
      $('#csTitle').textContent = `${ds.name} - ${R.LAYERS[st.layer].label}`;
      $('#csA').textContent = 'A  ' + date(a); $('#csB').textContent = 'B  ' + date(b);
      const put = (id, c) => { const el = $(id); el.innerHTML = ''; el.appendChild(c); };
      const bg = (px) => { const c = R.toCanvas(ds, px, st, a, 6); const ctx = c.getContext('2d'); ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#0b1622'; ctx.fillRect(0, 0, c.width, c.height); return c; };
      put('#csCanA', bg(pxA)); put('#csCanB', bg(pxB));
      const dc = R.fieldCanvas(ds, diff.vals, diff.range, 'puor', 6).canvas;
      const ctx = dc.getContext('2d'); ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#0b1622'; ctx.fillRect(0, 0, dc.width, dc.height);
      put('#csCanD', dc); $('#csDiffBar').style.background = R.rampCss('puor');
    }
  }
  function setSplit(f) {
    st.compare.split = Math.max(0.02, Math.min(0.98, f));
    $('#swipe').style.setProperty('--sx', st.compare.split * 100 + '%');
    $('#swipeKnob').setAttribute('aria-valuenow', Math.round(st.compare.split * 100));
    globe.setSplit(st.compare.split);
  }
  function setCompareOn(on) {
    st.compare.on = on; $('#cmpOn').checked = on; updateCompare(); log('compare', { on, mode: st.compare.mode, a: date(st.compare.a), b: date(st.compare.b) });
  }

  /* ======================= tabs ======================= */
  function setTab(tab) {
    st.tab = tab;
    $$('.tabs [role=tab]').forEach((b) => { b.setAttribute('aria-selected', b.dataset.tab === tab); b.tabIndex = b.dataset.tab === tab ? 0 : -1; });
    $('#tabBody').setAttribute('aria-labelledby', 'tab-' + tab);
    renderTab();
  }
  function renderTab() {
    if (!ds) return;
    const body = $('#tabBody');
    const fn = { inspect: renderInspect, forecast: renderForecast, correlate: renderCorrelate, impact: renderImpact, explain: renderExplain }[st.tab];
    body.innerHTML = fn();
    if (st.tab === 'correlate') afterCorrelate();
  }

  /* ---------- Inspect ---------- */
  function renderInspect() {
    const k = st.cell;
    if (k == null) return `<div class="pane-h"><h3>Inspect a cell</h3></div><div class="empty">${ico('i-target')}Click any cell inside the highlighted region on the globe to see its radar values and history.<br><span class="dim small">Each cell is about ${Math.sqrt(ds.cellKm2).toFixed(1)} km across.</span></div>${regionSummary()}`;
    const c = ds.cellCenter(k), t = st.t, i = t * ds.N + k, v = ds.v, lu = ds.landuse[ds.s.landuse[k]];
    const metric = (l, val, unit, hl) => `<div class="metric${hl ? ' hl' : ''}"><div class="m-l">${l}</div><div class="m-v">${val}<small>${unit || ''}</small></div></div>`;
    const pols = ['HH', 'HV', 'VV'].map((p) => ({ y: Array.from({ length: ds.T }, (_, q) => v[p][q * ds.N + k]), color: p === 'HH' ? '#f2a541' : p === 'HV' ? '#5cc8e0' : '#9b8ff0', label: p }));
    let sec, secLabel, secUnit;
    if (st.layer === 'disp' || ds.primary === 'disp') { sec = Array.from({ length: ds.T }, (_, q) => v.disp[q * ds.N + k]); secLabel = 'LOS displacement'; secUnit = 'cm'; }
    else if (st.layer === 'vegloss' || ds.primary === 'veg') { sec = Array.from({ length: ds.T }, (_, q) => v.HV[q * ds.N + k] - v.HV[st.refT * ds.N + k]); secLabel = 'HV change vs reference'; secUnit = 'dB'; }
    else { sec = Array.from({ length: ds.T }, (_, q) => v.water[q * ds.N + k]); secLabel = 'Inundated fraction'; secUnit = '0-1'; }
    const lv = fieldCache && fieldCache.vals[k];
    return `<div class="pane-h"><h3>Cell ${k % ds.nx}, ${Math.floor(k / ds.nx)}</h3><span class="mono dim small">${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}</span></div>
      <div class="pane-sub">${lu.name} - ${date(t)}${fin(lv) ? ` - layer value <span class="mono">${f2(lv)}</span>` : ''}</div>
      <div class="metric-grid">
        ${metric('HH', f1(v.HH[i]), ' dB', st.pol === 'HH')}${metric('HV', f1(v.HV[i]), ' dB', st.pol === 'HV')}${metric('VV', f1(v.VV[i]), ' dB', st.pol === 'VV')}
        ${metric('HV - HH', f1(v.HV[i] - v.HH[i]), ' dB')}${metric('Water', f2(v.water[i]))}${metric('LOS disp.', f1(v.disp[i]), ' cm')}
        ${metric('Rain', fmtInt(v.rain[i]), ' mm')}${metric('Population', fmtInt(ds.s.pop[k]), '/km2')}${metric('To road', f1(ds.s.roadDist[k]), ' km')}
      </div>
      <div class="block"><div class="block-h">Backscatter history</div>${C.line({ labels: ds.times, series: pols, marker: t, yUnit: 'dB', h: 140, aria: 'Backscatter history for this cell' })}</div>
      <div class="block"><div class="block-h">${secLabel}</div>${C.line({ labels: ds.times, series: [{ y: sec, color: '#e6ebf1' }], marker: t, yUnit: secUnit, h: 120, legend: false, aria: secLabel + ' history' })}</div>
      <div class="hint small">Simulated values. Use the Forecast tab with scope "Inspected cell" to project this cell.</div>`;
  }
  function regionSummary() {
    const w = targetSeries('water', 'region').y[st.t], g = targetSeries('veg', 'region').y[st.t], d = targetSeries('disp', 'region').y[st.t];
    return `<div class="block"><div class="block-h">Region at ${date(st.t)}</div><div class="metric-grid">
      <div class="metric"><div class="m-l">Water</div><div class="m-v">${fmtInt(w)}<small> km2</small></div></div>
      <div class="metric"><div class="m-l">Veg. lost</div><div class="m-v">${fmtInt(g)}<small> km2</small></div></div>
      <div class="metric"><div class="m-l">Mean LOS</div><div class="m-v">${f2(d)}<small> cm</small></div></div></div>
      <div class="hint small">${ds.name}, ${ds.place}. ${ds.nx} x ${ds.ny} cells, ${ds.T} monthly steps. ${ds.simulated ? 'Simulated demo data.' : 'Source: ' + escapeHtml(ds.source)}</div></div>`;
  }

  /* ---------- Forecast ---------- */
  function scenarioAdjust(key, hist, pred) {
    const s = st.scen, notes = [];
    const mean = pred.mean.slice(), lo = pred.lo.slice(), hi = pred.hi.slice(), h = mean.length, n = hist.length;
    const shift = (k, dlt) => { mean[k] += dlt; lo[k] += dlt; hi[k] += dlt; };
    const slope = M.ols(hist.map((_, i) => i), hist).b;
    if (s.defor && (key === 'veg' || key === 'water')) {
      const f = s.defor / 100; for (let k = 0; k < h; k++) shift(k, slope * (k + 1) * f);
      notes.push(`Land change rate ${s.defor > 0 ? '+' : ''}${s.defor}%: trend slope ${f2(slope)} per month scaled.`);
    }
    if (s.pump && key === 'disp') {
      const f = s.pump / 100; for (let k = 0; k < h; k++) shift(k, slope * (k + 1) * f);
      notes.push(`Pumping ${s.pump > 0 ? '+' : ''}${s.pump}%: subsidence trend scaled, assuming rate is proportional to extraction.`);
    }
    if (s.rain && key !== 'rain') {
      const rain = Array.from(ds.series.rain), det = hist.map((y, i) => y - (hist[0] + slope * i));
      const fit = M.ols(rain, det), clim = new Array(12).fill(0), cnt = new Array(12).fill(0);
      rain.forEach((r, i) => { clim[i % 12] += r; cnt[i % 12]++; });
      for (let k = 0; k < h; k++) { const mth = (n + k) % 12; shift(k, fit.b * (clim[mth] / cnt[mth]) * (s.rain / 100)); }
      notes.push(`Rainfall ${s.rain > 0 ? '+' : ''}${s.rain}%: sensitivity ${f2(fit.b)} per mm (R2 ${f2(fit.r2)}${fit.r2 < 0.1 ? ', weak link, small effect' : ''}).`);
    }
    if (notes.length) { const widen = 1 + 0.25 * (Math.abs(s.rain) + Math.abs(s.defor) + Math.abs(s.pump)) / 100; for (let k = 0; k < h; k++) { const c = mean[k]; lo[k] = c - (c - lo[k]) * widen; hi[k] = c + (hi[k] - c) * widen; } }
    return { pred: { mean, lo, hi }, notes };
  }
  function renderForecast() {
    const fc = st.fc, key = fc.target || ds.primary;
    if (fc.scope === 'cell' && st.cell == null) fc.scope = 'region';
    if (fc.scope === 'roi' && !(st.roiCells && st.roiCells.length)) fc.scope = 'region';
    const ser = targetSeries(key, fc.scope), y = ser.y, T = y.length;
    if (y.some((v) => !fin(v))) return `<div class="pane-h"><h3>Forecast</h3></div><div class="empty">${ico('i-chart')}No ${ser.label.toLowerCase()} values for this scope (for example, displacement over open water). Choose another variable or scope.</div><div class="ctrl-grid" style="margin-top:12px"><label><span class="lbl">Variable</span><select id="fcTarget">${Object.entries(FT).map(([k, v]) => `<option value="${k}" ${k === key ? 'selected' : ''}>${v.l}</option>`).join('')}</select></label><label><span class="lbl">Scope</span><select id="fcScope"><option value="region">Whole region</option><option value="cell" ${fc.scope === 'cell' ? 'selected' : ''}>Inspected cell</option><option value="roi" ${fc.scope === 'roi' ? 'selected' : ''}>ROI polygon</option></select></label></div>`;
    const model = M.MODELS[fc.model], fit = model.fit(y), raw = fit.predict(fc.horizon);
    const adj = scenarioAdjust(key, y, raw), p = adj.pred;
    const bt = M.backtest(y, 6), bestKey = Object.keys(bt).reduce((a, b) => (bt[a].rmse <= bt[b].rmse ? a : b));
    const labels = ds.times.slice();
    for (let k = 1; k <= fc.horizon; k++) { const [yy, mm] = ds.times[T - 1].split('-').map(Number); const m0 = mm - 1 + k; labels.push(`${yy + Math.floor(m0 / 12)}-${String((m0 % 12) + 1).padStart(2, '0')}-01`); }
    const chart = C.line({
      labels, h: 170, yUnit: ser.unit, split: T - 1, aria: `Forecast of ${ser.label}`,
      bands: [{ lo: [y[T - 1], ...p.lo], hi: [y[T - 1], ...p.hi], start: T - 1, color: '#f2a541' }],
      series: [
        { y, color: '#e6ebf1', label: 'Observed (simulated)' },
        { y: fit.fitted, color: '#5cc8e0', dash: '3 3', width: 1.2, label: 'Model fit' },
        { y: [y[T - 1], ...p.mean], start: T - 1, color: '#f2a541', width: 2, label: model.short + ' forecast' }
      ]
    });
    const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
    const end = p.mean[p.mean.length - 1], lo = p.lo[p.lo.length - 1], hi = p.hi[p.hi.length - 1];
    return `<div class="pane-h"><h3>Forecast</h3><span class="tag">statistical</span></div>
      <div class="ctrl-grid">
        <label><span class="lbl">Variable</span><select id="fcTarget">${opt(Object.fromEntries(Object.entries(FT).map(([k, v]) => [k, v.l])), key)}</select></label>
        <label><span class="lbl">Scope</span><select id="fcScope">${opt({ region: 'Whole region', cell: 'Inspected cell' + (st.cell == null ? ' (none)' : ''), roi: 'ROI polygon' + (st.roiCells ? '' : ' (none)') }, fc.scope)}</select></label>
      </div>
      <div class="row"><div class="seg small full" role="group" aria-label="Forecast model" id="fcModels">${Object.entries(M.MODELS).map(([k, m]) => `<button data-model="${k}" aria-pressed="${k === fc.model}">${m.short}</button>`).join('')}</div></div>
      <label class="row slider-row"><span class="lbl">Horizon</span><input type="range" id="fcH" min="6" max="24" step="1" value="${fc.horizon}"><output class="mono">${fc.horizon} mo</output></label>
      <div class="block">${chart}</div>
      <div class="metric-grid">
        <div class="metric hl"><div class="m-l">${labels[labels.length - 1].slice(0, 7)}</div><div class="m-v">${C.fmt(end)}<small> ${ser.unit}</small></div></div>
        <div class="metric"><div class="m-l">95% band</div><div class="m-v" style="font-size:13px">${C.fmt(lo)} to ${C.fmt(hi)}</div></div>
        <div class="metric"><div class="m-l">Residual sd</div><div class="m-v">${C.fmt(fit.sigma)}</div></div>
      </div>
      ${adj.notes.length ? `<div class="notice cyan">${ico('i-flask')}<div><b>Scenario applied.</b> ${adj.notes.join(' ')} Band widened for scenario uncertainty.</div></div>` : ''}
      <div class="block"><div class="block-h">Model comparison <span class="tag">holdout: last 6 months</span></div>
        <table class="tbl"><thead><tr><th>Model</th><th>RMSE</th><th>MAE</th><th>Band hit</th></tr></thead><tbody>
        ${Object.entries(bt).map(([k, r]) => `<tr class="${k === bestKey ? 'best' : ''} ${k === fc.model ? 'sel' : ''}"><td>${M.MODELS[k].short}${k === bestKey ? ' (best)' : ''}</td><td>${C.fmt(r.rmse)}</td><td>${C.fmt(r.mae)}</td><td>${Math.round(r.coverage * 100)}%</td></tr>`).join('')}
        </tbody></table></div>
      <div class="notice">${ico('i-alert')}<div>Extrapolation of 30 simulated months. The band is an approximate 95% prediction interval assuming the past pattern continues; it does not cover policy changes, extreme events or model error.</div></div>`;
  }

  /* ---------- Correlate ---------- */
  let corrCache = null;
  function renderCorrelate() {
    const xk = st.corr.x, yk = st.corr.y, X = CV[xk], Y = CV[yk];
    const cells = ['water', 'HH', 'HV', 'VV', 'ratio'].includes(xk) || ['water', 'HH', 'HV', 'VV', 'ratio'].includes(yk) ? Array.from({ length: ds.N }, (_, k) => k) : landCells();
    const xs = meanSeries(xk, cells), ys = meanSeries(yk, cells);
    const anyStatic = X.stat || Y.stat;
    const pr = anyStatic ? NaN : M.pearson(xs, ys), sp = anyStatic ? NaN : M.spearman(xs, ys);
    const xc = anyStatic ? [] : M.xcorr(xs, ys, 12);
    let best = null; for (const d of xc) if (fin(d.r) && d.n >= 12 && (!best || Math.abs(d.r) > Math.abs(best.r))) best = d;
    const sx = [], sy = [];
    for (const k of cells) { sx.push(cellVal(xk, st.t, k)); sy.push(cellVal(yk, st.t, k)); }
    const spr = M.pearson(sx, sy), sps = M.spearman(sx, sy);
    corrCache = { xs, ys };
    const z = (a) => { const m = M.mean(a), s = M.std(a) || 1; return a.map((v) => (v - m) / s); };
    const opt = (v) => Object.entries(CV).map(([k, d]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${d.l}${d.stat ? ' (static)' : ''}</option>`).join('');
    const rr = (r) => (fin(r) ? (r >= 0 ? '+' : '') + r.toFixed(2) : 'n/a');
    const strength = (r) => (!fin(r) ? '' : Math.abs(r) > 0.7 ? 'strong' : Math.abs(r) > 0.4 ? 'moderate' : Math.abs(r) > 0.2 ? 'weak' : 'negligible');
    const lagTxt = !best ? 'Lag analysis needs two time-varying variables.' : best.lag === 0 ? `Strongest at lag 0 (r = ${rr(best.r)}): they move in the same month.` : best.lag > 0 ? `${Y.l} follows ${X.l} by <b>${best.lag} month${best.lag > 1 ? 's' : ''}</b> (r = ${rr(best.r)}).` : `${X.l} follows ${Y.l} by <b>${-best.lag} month${best.lag < -1 ? 's' : ''}</b> (r = ${rr(best.r)}).`;
    return `<div class="pane-h"><h3>Correlate</h3><span class="tag">not causation</span></div>
      <div class="ctrl-grid"><label><span class="lbl">Variable X</span><select id="corrX">${opt(xk)}</select></label><label><span class="lbl">Variable Y</span><select id="corrY">${opt(yk)}</select></label></div>
      <div class="block"><div class="block-h">Region means over time (z-scores)</div>
        ${anyStatic ? `<div class="empty small">${X.stat ? X.l : Y.l} does not change over time in this dataset, so only the spatial comparison below applies.</div>` : C.line({ labels: ds.times, h: 130, marker: st.t, yUnit: 'z', series: [{ y: z(xs), color: '#5cc8e0', label: 'X ' + X.l }, { y: z(ys), color: '#f2a541', label: 'Y ' + Y.l }], aria: 'Both variables over time' })}</div>
      <div class="metric-grid">
        <div class="metric hl"><div class="m-l">Pearson (time)</div><div class="m-v">${rr(pr)}</div></div>
        <div class="metric"><div class="m-l">Spearman (time)</div><div class="m-v">${rr(sp)}</div></div>
        <div class="metric"><div class="m-l">Best lag</div><div class="m-v">${best ? best.lag + '<small> mo</small>' : 'n/a'}</div></div>
      </div>
      ${!anyStatic ? `<div class="block"><div class="block-h">Lagged cross-correlation <span class="tag">-12 to +12 months</span></div>${C.lags(xc, best && best.lag)}<div class="hint small">${lagTxt}</div></div>` : ''}
      <div class="block"><div class="block-h">Across cells at ${date(st.t)}</div>
        ${C.scatter({ x: sx, y: sy, xLabel: X.l + ' (' + X.u + ')', yLabel: Y.l + ' (' + Y.u + ')', aria: 'Scatter of cells' })}
        <div class="hint small">Spatial Pearson ${rr(spr)}, Spearman ${rr(sps)} over ${cells.length} cells (${strength(spr) || 'undefined'}).</div></div>
      <div class="block"><div class="block-h">Spatial correlation map</div>
        ${anyStatic ? `<div class="empty small">Needs two time-varying variables.</div>` : `<canvas id="corrMini" class="mini-map" width="64" height="64" aria-label="Per-cell correlation map"></canvas>
        <div class="row"><span class="hint small" style="margin:0">Per-cell Pearson r over 30 months. PuOr scale, -1 orange to +1 purple.</span><button class="btn small" id="corrShow">${ico('i-layers')}Show on globe</button></div>`}</div>
      <div class="notice">${ico('i-alert')}<div><b>Correlation, not proof of causation.</b> ${K.CAUSATION_NOTE}</div></div>`;
  }
  function corrMapField() {
    const xk = st.corr.x, yk = st.corr.y, out = new Float32Array(ds.N), a = new Float64Array(ds.T), b = new Float64Array(ds.T);
    for (let k = 0; k < ds.N; k++) { for (let t = 0; t < ds.T; t++) { a[t] = cellVal(xk, t, k); b[t] = cellVal(yk, t, k); } out[k] = M.pearson(a, b); }
    return out;
  }
  function afterCorrelate() {
    const cv = $('#corrMini');
    if (cv) {
      const fld = corrMapField(), px = R.fieldCanvas(ds, fld, [-1, 1], 'puor', 1).px, ctx = cv.getContext('2d');
      ctx.putImageData(new ImageData(px, ds.nx, ds.ny), 0, 0); cv._fld = fld;
    }
  }

  /* ---------- Human impact ---------- */
  function impactMask() {
    const N = ds.N, t = st.t, r = st.refT, v = ds.v, mask = new Uint8Array(N), mag = new Float32Array(N);
    const yrs = Math.max(1 / 12, (t - r) / 12);
    for (let k = 0; k < N; k++) {
      if (ds.id === 'mississippi') { const lost = ds.s.landuse[k] === 1 && v.water[t * N + k] >= 0.99 && v.water[r * N + k] < 0.99; mask[k] = lost; mag[k] = lost ? 1 : 0; }
      else if (ds.id === 'jakarta') { const d = v.disp[t * N + k] - v.disp[r * N + k]; mag[k] = ds.s.landuse[k] ? -d : NaN; mask[k] = ds.s.landuse[k] !== 0 && t > r && d / yrs < -4; }
      else { const c = v.veg[t * N + k] > 0.5 && v.veg[r * N + k] < 0.5; mask[k] = c; mag[k] = c ? 1 : 0; }
    }
    return { mask, mag };
  }
  function renderImpact() {
    const { mask, mag } = impactMask(), N = ds.N, land = landCells();
    const what = ds.id === 'mississippi' ? 'Marsh converted to open water' : ds.id === 'jakarta' ? 'Fast subsidence (over 4 cm/yr LOS)' : 'New deforestation';
    let nC = 0, nNear = 0, nLandNear = 0, popC = 0, popU = 0, nU = 0;
    const byLu = {};
    for (const k of land) {
      const near = ds.s.roadDist[k] <= 5; if (near) nLandNear++;
      if (mask[k]) { nC++; if (near) nNear++; popC += ds.s.pop[k]; const lu = ds.landuse[ds.s.landuse[k]].name; byLu[lu] = (byLu[lu] || 0) + ds.cellKm2; }
      else { popU += ds.s.pop[k]; nU++; }
    }
    const pctNear = nC ? (nNear / nC) * 100 : NaN, pctLandNear = (nLandNear / land.length) * 100;
    const popArr = land.map((k) => ds.s.pop[k]), rdArr = land.map((k) => ds.s.roadDist[k]), magArr = land.map((k) => mag[k]);
    const rPop = M.spearman(popArr, magArr), rRoad = M.spearman(rdArr, magArr);
    const bars = Object.entries(byLu).sort((a, b) => b[1] - a[1]).map(([l, v]) => ({ label: l, value: v, color: 'var(--amber)' }));
    const enrich = fin(pctNear) && pctLandNear > 0 ? pctNear / pctLandNear : NaN;
    let summary;
    if (!nC) summary = `No ${what.toLowerCase()} between ${date(st.refT)} and ${date(st.t)}. Move the timeline forward or change the reference date.`;
    else if (ds.id === 'jakarta') summary = `${fmtInt(nC * ds.cellKm2)} km2 sank faster than 4 cm/yr. The fastest-sinking land is ${(popC / nC / (popU / nU || 1)).toFixed(1)}x as densely populated as the rest (Spearman with population ${f2(rPop)}). This fits the groundwater hypothesis, but distance to the coast and soft sediments also correlate with both.`;
    else summary = `<b>${f1(pctNear)}%</b> of ${what.toLowerCase()} lies within 5 km of a ${ds.id === 'mississippi' ? 'canal or levee road' : 'road'}, while only ${f1(pctLandNear)}% of the land is that close: ${f1(enrich)}x more than expected if change were spread evenly. Spearman between distance to road and change: ${f2(rRoad)}.`;
    return `<div class="pane-h"><h3>Human impact</h3><span class="tag">synthetic overlays</span></div>
      <div class="pane-sub">${what}, ${date(st.refT)} to ${date(st.t)}</div>
      <div class="metric-grid">
        <div class="metric hl"><div class="m-l">Changed area</div><div class="m-v">${fmtInt(nC * ds.cellKm2)}<small> km2</small></div></div>
        <div class="metric"><div class="m-l">Within 5 km road</div><div class="m-v">${fin(pctNear) ? pctNear.toFixed(0) : 'n/a'}<small>%</small></div></div>
        <div class="metric"><div class="m-l">Land within 5 km</div><div class="m-v">${pctLandNear.toFixed(0)}<small>%</small></div></div>
      </div>
      <div class="notice cyan">${ico('i-people')}<div>${summary}</div></div>
      <div class="block"><div class="block-h">Changed area by land use (km2)</div>${bars.length ? C.bars(bars, { fmt: (v) => v.toFixed(0) }) : '<div class="empty small">No change in this window.</div>'}</div>
      <div class="block"><div class="block-h">People and change</div>
        <dl class="kv"><dt>Mean population, changed cells</dt><dd>${nC ? fmtInt(popC / nC) : 'n/a'} /km2</dd><dt>Mean population, other land</dt><dd>${fmtInt(popU / (nU || 1))} /km2</dd>
        <dt>Spearman: population vs change</dt><dd>${f2(rPop)}</dd><dt>Spearman: road distance vs change</dt><dd>${f2(rRoad)}</dd></dl></div>
      <div class="hint small">Overlays are synthetic stand-ins for datasets such as WorldPop, OpenStreetMap roads and ESA WorldCover. Associations here are not evidence of cause.</div>`;
  }

  /* ---------- Explain ---------- */
  function explainNumbers() {
    const N = ds.N, t = st.t, r = st.refT, v = ds.v, n = {};
    let land = 0, dsum = 0;
    for (let k = 0; k < N; k++) if (ds.s.landuse[k]) { land++; dsum += v.disp[t * N + k] - v.disp[r * N + k]; }
    n.meanDisp = dsum / land;
    if (ds.id === 'mississippi') {
      let lost = 0, marsh = 0; for (let k = 0; k < N; k++) if (ds.s.landuse[k] === 1) { marsh++; if (v.water[t * N + k] >= 0.99 && v.water[r * N + k] < 0.99) lost++; }
      n.marshLost = lost * ds.cellKm2; n.marshLostPct = (lost / marsh) * 100; n.maxFlood = Math.max(...targetSeries('water', 'region').y) - targetSeries('water', 'region').y[0];
    } else if (ds.id === 'rondonia') {
      let c = 0, forest = 0, drop = 0, dry = 0;
      for (let k = 0; k < N; k++) { if (v.veg[r * N + k] < 0.5 && ds.s.landuse[k] === 2) forest++; if (v.veg[t * N + k] > 0.5 && v.veg[r * N + k] < 0.5) { c++; drop += v.HV[t * N + k] - v.HV[r * N + k]; } }
      for (let q = Math.max(1, r + 1); q <= t; q++) { let inc = 0; for (let k = 0; k < N; k++) inc += v.veg[q * N + k] - v.veg[(q - 1) * N + k]; const m = q % 12; if (m >= 5 && m <= 9) dry += inc; }
      n.cleared = c * ds.cellKm2; n.clearedPct = forest ? (c / forest) * 100 : 0; n.hvDrop = c ? -drop / c : 0; n.dryShare = c ? (dry / c) * 100 : 0;
    } else {
      let mx = 0, fast = 0; const yrs = Math.max(1 / 12, (t - r) / 12);
      for (let k = 0; k < N; k++) if (ds.s.landuse[k]) { const d = v.disp[t * N + k] - v.disp[r * N + k]; if (d < mx) mx = d; if (t > r && -d / 0.8 / yrs > 5) fast++; }
      n.maxSink = mx; n.fastKm2 = fast * ds.cellKm2;
    }
    return n;
  }
  function renderExplain() {
    return `<div class="pane-h"><h3>Explain this</h3><div class="seg small" role="group" aria-label="Explanation depth" id="exLevel"><button data-level="simple" aria-pressed="${st.level === 'simple'}">Simple</button><button data-level="detailed" aria-pressed="${st.level === 'detailed'}">Detailed</button></div></div>
      ${K.explain({ ds, st, numbers: explainNumbers(), level: st.level })}
      <div class="ex-block"><div class="ex-h">Limitations</div><ul class="ex-list">${K.LIMITATIONS.slice(0, st.level === 'simple' ? 3 : 7).map(([h, t]) => `<li><b>${h}.</b> ${t}</li>`).join('')}</ul>
      <button class="btn small ghost" id="exMoreLimits">${ico('i-book')}All limitations and methods</button></div>
      <div class="hint small">Underlined terms have definitions: hover or focus them.</div>`;
  }

  /* ======================= researcher tools ======================= */
  function applyExpr(quiet) {
    const msg = $('#exprMsg');
    try {
      const fn = M.compileExpr($('#expr').value);
      st.expr = $('#expr').value; st.exprFn = fn;
      // range from 2nd-98th percentile across all time steps
      const vals = [], N = ds.N, v = ds.v, o = {};
      for (let t = 0; t < ds.T; t += 3) for (let k = 0; k < N; k += 2) { const i = t * N + k; o.HH = v.HH[i]; o.HV = v.HV[i]; o.VV = v.VV[i]; o.water = v.water[i]; o.disp = v.disp[i]; o.rain = v.rain[i]; o.pop = ds.s.pop[k]; const q = fn(o); if (fin(q)) vals.push(q); }
      st.exprRange = [M.quantile(vals, 0.02), M.quantile(vals, 0.98)];
      if (st.exprRange[0] === st.exprRange[1]) st.exprRange[1] += 1;
      msg.classList.remove('err'); msg.textContent = `OK. Display range ${C.fmt(st.exprRange[0])} to ${C.fmt(st.exprRange[1])}.`;
      if (!quiet) { st.layer = 'bandmath'; renderLayerList(); refreshFrame(); updateCompare(); log('bandmath', { expr: st.expr, range: st.exprRange.map((x) => +x.toFixed(3)) }); }
      return true;
    } catch (e) { msg.classList.add('err'); msg.textContent = e.message; return false; }
  }

  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; }
    return inside;
  }
  function startRoi() { st.drawing = true; st.roiPts = []; st.roiCells = null; globe.setRoi(null); $('#roiDraw').setAttribute('aria-pressed', 'true'); $('#roiFinish').disabled = false; $('#roiClear').disabled = false; toast('Click points on the globe. Double-click or press Finish to close.'); }
  function finishRoi() {
    const pts = st.roiPts.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-4);
    st.drawing = false; $('#roiDraw').setAttribute('aria-pressed', 'false'); $('#roiFinish').disabled = true;
    if (pts.length < 3) { toast('A polygon needs at least 3 points.'); clearRoi(); return; }
    st.roiPts = pts; st.roi = { pts, closed: true }; globe.setRoi(st.roi);
    st.roiCells = []; for (let k = 0; k < ds.N; k++) { const c = ds.cellCenter(k); if (pointInPoly(c.lon, c.lat, pts)) st.roiCells.push(k); }
    renderRoiStats(); log('roi', { vertices: pts.length, cells: st.roiCells.length, polygon: pts.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]) });
  }
  function clearRoi(quiet) { st.drawing = false; st.roiPts = []; st.roi = null; st.roiCells = null; if (globe) globe.setRoi(null); const b = $('#roiDraw'); if (b) { b.setAttribute('aria-pressed', 'false'); $('#roiFinish').disabled = true; $('#roiClear').disabled = true; $('#roiStats').innerHTML = '<div class="empty small">Click Draw, then click points on the globe. Double-click or Finish to close the polygon.</div>'; } if (!quiet) log('roi_clear'); }
  function renderRoiStats() {
    const el = $('#roiStats'); if (!st.roiCells) return;
    if (!st.roiCells.length) { el.innerHTML = '<div class="empty small">The polygon contains no cell centres of this region.</div>'; return; }
    const vals = st.roiCells.map((k) => fieldCache.vals[k]).filter(fin);
    const [lo, hi] = M.minmax(vals);
    const diff = R.difference(ds, st, st.refT, st.t), dIn = st.roiCells.filter((k) => fin(diff.vals[k]));
    el.innerHTML = `<dl class="kv"><dt>Cells / area</dt><dd>${st.roiCells.length} / ${f1(st.roiCells.length * ds.cellKm2)} km2</dd>
      <dt>Layer cells with value</dt><dd>${vals.length}</dd><dt>Mean</dt><dd>${f2(M.mean(vals))}</dd><dt>Std dev</dt><dd>${f2(M.std(vals))}</dd><dt>Min / max</dt><dd>${f2(lo)} / ${f2(hi)}</dd>
      <dt>Changed since ref (${diff.metric.label})</dt><dd>${f1(dIn.length * ds.cellKm2)} km2</dd></dl><div class="hint small">${R.LAYERS[st.layer].label}, ${date(st.t)}. ROI is available as a forecast scope.</div>`;
  }

  /* ======================= exports ======================= */
  function exportCsv() {
    const keys = ['water', 'veg', 'disp', 'rain', 'HH', 'HV'];
    const reg = keys.map((k) => targetSeries(k, 'region'));
    const cell = st.cell != null ? keys.map((k) => targetSeries(k, 'cell')) : null;
    const roi = st.roiCells && st.roiCells.length ? keys.map((k) => targetSeries(k, 'roi')) : null;
    let head = ['date', ...keys.map((k, i) => `region_${k}_${reg[i].unit.replace(/[^a-z0-9]/gi, '')}`)];
    if (cell) head = head.concat(keys.map((k) => `cell_${k}`)); if (roi) head = head.concat(keys.map((k) => `roi_${k}`));
    const lines = [`# SAR Atlas export - ${ds.simulated ? 'SIMULATED DEMO DATA, not real observations' : 'source: ' + ds.source}`, `# region=${ds.id} bbox=${ds.bbox.join(',')} created=${new Date().toISOString()}`, cell ? `# cell=${st.cell} center=${JSON.stringify(ds.cellCenter(st.cell))}` : '', head.join(',')].filter(Boolean);
    for (let t = 0; t < ds.T; t++) { let row = [ds.times[t], ...reg.map((s) => s.y[t].toFixed(4))]; if (cell) row = row.concat(cell.map((s) => s.y[t].toFixed(4))); if (roi) row = row.concat(roi.map((s) => s.y[t].toFixed(4))); lines.push(row.join(',')); }
    download(`sar-atlas_${ds.id}_timeseries.csv`, lines.join('\n'), 'text/csv'); log('export_csv', { rows: ds.T, cell: st.cell, roi: !!roi });
  }
  function exportGeoJSON() {
    const [w, s, e, n] = ds.bbox, dx = (e - w) / ds.nx, dy = (n - s) / ds.ny, t = st.t, N = ds.N, feats = [];
    for (let k = 0; k < N; k++) {
      const val = fieldCache.vals[k]; if (!fin(val) && st.layer !== 'backscatter') continue;
      const i = k % ds.nx, j = Math.floor(k / ds.nx), x0 = w + i * dx, y0 = n - j * dy, x1 = x0 + dx, y1 = y0 - dy, q = t * N + k;
      feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)])] },
        properties: { cell: k, layer: st.layer, value: fin(val) ? +val.toFixed(4) : null, HH_dB: +ds.v.HH[q].toFixed(2), HV_dB: +ds.v.HV[q].toFixed(2), VV_dB: +ds.v.VV[q].toFixed(2), water: +ds.v.water[q].toFixed(2), disp_cm: +ds.v.disp[q].toFixed(2), landuse: ds.landuse[ds.s.landuse[k]].name } });
    }
    if (st.roi) feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...st.roi.pts, st.roi.pts[0]]] }, properties: { kind: 'roi', cells: st.roiCells.length } });
    const gj = { type: 'FeatureCollection', metadata: { generator: 'SAR Atlas', simulated: ds.simulated, region: ds.id, date: ds.times[t], layer: st.layer, units: R.LAYERS[st.layer].units, reference: ds.times[st.refT] }, features: feats };
    download(`sar-atlas_${ds.id}_${st.layer}_${date(t)}.geojson`, JSON.stringify(gj), 'application/geo+json'); log('export_geojson', { features: feats.length });
  }
  function exportPng() {
    let src; try { src = globe.screenshot(); } catch (e) { src = null; }
    const W = src ? src.width : 1200, H = src ? src.height : 800, c = document.createElement('canvas'); c.width = W; c.height = H + 64;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#04060a'; ctx.fillRect(0, 0, c.width, c.height);
    try { if (src) ctx.drawImage(src, 0, 0); } catch (e) { toast('Globe image could not be captured (cross-origin tiles). Exported the overlay only.'); }
    if (!src) ctx.drawImage(R.toCanvas(ds, R.compose(ds, st, st.t, fieldCache), st, st.t, 10), 0, 0);
    const sc = Math.max(1, W / 1400);
    ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, H, W, 64);
    ctx.fillStyle = '#f2a541'; ctx.font = `600 ${16 * sc}px "Chakra Petch", sans-serif`; ctx.fillText('SAR ATLAS', 18 * sc, H + 26 * sc);
    ctx.fillStyle = '#e6ebf1'; ctx.font = `${13 * sc}px "IBM Plex Mono", monospace`;
    ctx.fillText(`${ds.name} | ${R.LAYERS[st.layer].label}${st.layer === 'backscatter' ? ' ' + st.pol : ''} | ${date(st.t)}`, 130 * sc, H + 26 * sc);
    ctx.fillStyle = '#ffd08a'; ctx.fillText(ds.simulated ? 'SIMULATED DEMO DATA - NOT REAL OBSERVATIONS' : 'Source: ' + ds.source, 18 * sc, H + 48 * sc);
    const g = ctx.createLinearGradient(W - 260 * sc, 0, W - 20 * sc, 0), stops = R.RAMPS[R.LAYERS[st.layer].ramp];
    stops.forEach((col, i) => g.addColorStop(i / (stops.length - 1), col));
    ctx.fillStyle = g; ctx.fillRect(W - 260 * sc, H + 16 * sc, 240 * sc, 10 * sc);
    ctx.fillStyle = '#95a1b2'; ctx.font = `${11 * sc}px "IBM Plex Mono", monospace`;
    ctx.fillText(C.fmt(fieldCache.range[0]), W - 260 * sc, H + 42 * sc); const hiT = C.fmt(fieldCache.range[1]); ctx.fillText(hiT, W - 20 * sc - ctx.measureText(hiT).width, H + 42 * sc);
    try { c.toBlob((b) => download(`sar-atlas_${ds.id}_${date(st.t)}.png`, b, 'image/png')); log('export_png', { w: W, h: H }); }
    catch (e) { toast('PNG export blocked by the browser (tainted canvas). Try the Dark or OSM basemap.'); }
  }
  function recipe() {
    return {
      schema: 'sar-atlas-recipe/1', created: new Date().toISOString(), app: 'SAR Atlas', simulated: ds.simulated,
      region: st.region, date: ds.times[st.t], reference: ds.times[st.refT], layer: st.layer, polarization: st.pol,
      threshold_db: st.threshold, opacity: st.opacity, overlays: st.overlays, overlay_opacity: st.ovOpacity,
      compare: { on: st.compare.on, mode: st.compare.mode, a: ds.times[st.compare.a], b: ds.times[st.compare.b] },
      band_math: st.expr, roi: st.roi ? st.roi.pts : null, inspected_cell: st.cell,
      forecast: st.fc, scenario: st.scen, correlation: st.corr, log: opLog
    };
  }
  async function loadRecipe(obj) {
    if (!obj || obj.schema !== 'sar-atlas-recipe/1') throw new Error('Not a SAR Atlas recipe');
    if (!D.regions.find((r) => r.id === obj.region)) throw new Error('Unknown region ' + obj.region);
    await selectRegion(obj.region, { keepLayer: true });
    const ti = (d) => Math.max(0, ds.times.indexOf(d));
    st.layer = R.LAYERS[obj.layer] ? obj.layer : 'water'; st.pol = obj.polarization || 'HV'; st.threshold = +obj.threshold_db || 3;
    st.opacity = +obj.opacity || 0.85; st.overlays = Object.assign({ landuse: false, pop: false, roads: false }, obj.overlays); st.ovOpacity = +obj.overlay_opacity || 0.55;
    st.refT = ti(obj.reference); st.t = ti(obj.date);
    if (obj.band_math) { $('#expr').value = obj.band_math; applyExpr(true); }
    if (obj.forecast) Object.assign(st.fc, obj.forecast);
    if (obj.scenario) Object.assign(st.scen, obj.scenario);
    if (obj.correlation) st.corr = obj.correlation;
    if (obj.mode !== 'explorer') setMode('researcher');
    if (obj.roi && obj.roi.length > 2) { st.roiPts = obj.roi; finishRoi(); }
    st.cell = obj.inspected_cell != null ? obj.inspected_cell : null;
    if (st.cell != null) globe.setMarker(ds.cellCenter(st.cell));
    if (obj.compare) { st.compare.mode = obj.compare.mode || 'swipe'; st.compare.a = ti(obj.compare.a); st.compare.b = ti(obj.compare.b); st.compare.on = !!obj.compare.on; }
    syncControls(); renderLayerList(); syncPol(); refreshFrame(); updateCompare(); renderTab(); renderOvLegend();
    log('recipe_load', { region: obj.region, date: obj.date });
  }
  function syncControls() {
    $('#thr').value = st.threshold; $('#thrOut').textContent = st.threshold.toFixed(1) + ' dB';
    $('#opacity').value = st.opacity; $('#opacityOut').textContent = Math.round(st.opacity * 100) + '%';
    $('#ovOpacity').value = st.ovOpacity; $('#ovOpacityOut').textContent = Math.round(st.ovOpacity * 100) + '%';
    $('#ovLanduse').checked = st.overlays.landuse; $('#ovPop').checked = st.overlays.pop; $('#ovRoads').checked = st.overlays.roads;
    $('#refDate').value = st.refT; $('#cmpA').value = st.compare.a; $('#cmpB').value = st.compare.b; $('#cmpOn').checked = st.compare.on;
    $$('[data-cmp]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cmp === st.compare.mode));
    for (const [id, k] of [['scRain', 'rain'], ['scDefor', 'defor'], ['scPump', 'pump']]) { $('#' + id).value = st.scen[k]; $('#' + id + 'Out').textContent = (st.scen[k] >= 0 ? '+' : '') + st.scen[k] + '%'; }
  }

  /* ======================= mode ======================= */
  function setMode(m) {
    st.mode = m; document.body.classList.toggle('researcher', m === 'researcher');
    $('#modeExplorer').setAttribute('aria-pressed', m === 'explorer'); $('#modeResearcher').setAttribute('aria-pressed', m === 'researcher');
    if (m === 'explorer' && R.LAYERS[st.layer].researcher) { st.layer = 'water'; refreshFrame(); updateCompare(); }
    if (m === 'explorer' && st.drawing) clearRoi(true);
    renderLayerList(); log('mode', { mode: m });
  }

  /* ======================= globe interaction ======================= */
  function onGlobeClick(ll) {
    if (!ds) return;
    if (st.drawing) { st.roiPts.push([ll.lon, ll.lat]); globe.setRoi({ pts: st.roiPts.slice(), closed: false }); return; }
    const k = ds.cellAt(ll.lon, ll.lat);
    if (k >= 0) {
      st.cell = k; globe.setMarker(ds.cellCenter(k));
      if (st.tab !== 'inspect' && st.tab !== 'forecast') setTab('inspect'); else renderTab();
      if (document.body.classList.contains('right-collapsed')) toggleRight(false);
      log('inspect', { cell: k, lon: +ll.lon.toFixed(4), lat: +ll.lat.toFixed(4) });
      return;
    }
    const other = D.regions.find((r) => ll.lon >= r.bbox[0] && ll.lon <= r.bbox[2] && ll.lat >= r.bbox[1] && ll.lat <= r.bbox[3]);
    if (other) selectRegion(other.id);
  }
  function onGlobeMove(ll) { $('#coordReadout').textContent = ll ? `${ll.lat >= 0 ? 'N' : 'S'} ${Math.abs(ll.lat).toFixed(3)}  ${ll.lon >= 0 ? 'E' : 'W'} ${Math.abs(ll.lon).toFixed(3)}` : '--'; }

  function toggleLeft(force) { const c = force != null ? force : !document.body.classList.contains('left-collapsed'); document.body.classList.toggle('left-collapsed', c); $('#collapseLeft').setAttribute('aria-expanded', !c); }
  function toggleRight(force) { const c = force != null ? force : !document.body.classList.contains('right-collapsed'); document.body.classList.toggle('right-collapsed', c); $('#collapseRight').setAttribute('aria-expanded', !c); }

  /* ======================= story mode ======================= */
  const story = { on: false, i: 0, steps: [], elapsed: 0, last: 0, paused: false, raf: null };
  function startStory() {
    if (story.on) return;
    if (st.playing) play(false);
    if (!K.STORIES[st.region]) { toast('No guided story is written for this region yet.'); return; }
    story.steps = K.STORIES[st.region]; story.on = true; story.i = -1; story.paused = false;
    document.body.classList.add('story-on'); $('#story').hidden = false; $('#storyTitle').textContent = ds.name + ' - guided story';
    log('story_start', { region: st.region });
    nextStep();
    story.last = performance.now(); story.raf = requestAnimationFrame(storyTick);
  }
  function nextStep() {
    story.i++;
    if (story.i >= story.steps.length) { stopStory(); toast('Story complete. The globe is yours.'); return; }
    story.elapsed = 0;
    const s = story.steps[story.i];
    if (st.drawing) clearRoi(true);
    st.overlays = Object.assign({ landuse: false, pop: false, roads: false }, s.ov || {});
    if (s.pol) { st.pol = s.pol; syncPol(); }
    if (s.layer) st.layer = s.layer;
    if (s.corr) st.corr = s.corr;
    if (s.compare) { st.compare.a = s.compare.a; st.compare.b = s.compare.b; st.compare.mode = 'swipe'; st.compare.on = true; st.compare.split = 0.5; }
    else st.compare.on = false;
    syncControls(); renderLayerList(); renderOvLegend();
    if (s.play) st.t = s.play[0]; else if (s.t != null) st.t = s.t;
    refreshFrame(); updateCompare();
    if (s.tab) setTab(s.tab); else renderTab();
    if (s.cam === 'region') globe.flyToRect(ds.bbox, flyDur(2.2)); else if (s.cam) globe.flyToView(s.cam, flyDur(2.6));
    $('#storyStep').textContent = `${String(story.i + 1).padStart(2, '0')} / ${String(story.steps.length).padStart(2, '0')}`;
    $('#storyCap').textContent = s.cap;
    if (st.narrate && window.speechSynthesis) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(s.cap); u.rate = 1.02; speechSynthesis.speak(u); }
  }
  function storyTick(now) {
    if (!story.on) return;
    const dt = now - story.last; story.last = now;
    if (!story.paused) {
      story.elapsed += dt;
      const s = story.steps[story.i], dur = s.d * 1000;
      if (s.play) { const span = s.play[1] - s.play[0], k = Math.min(1, story.elapsed / (dur - 1500)), tt = Math.round(s.play[0] + span * k); if (tt !== st.t) setT(tt, { silent: true }); }
      if (s.compare && !st.reducedMotion) setSplit(0.5 + 0.32 * Math.sin((story.elapsed / dur) * Math.PI * 2));
      const total = story.steps.reduce((a, b) => a + b.d, 0) * 1000, before = story.steps.slice(0, story.i).reduce((a, b) => a + b.d, 0) * 1000;
      $('#storyBar').style.width = ((before + story.elapsed) / total) * 100 + '%';
      if (story.elapsed >= dur) nextStep();
    }
    if (story.on) story.raf = requestAnimationFrame(storyTick);
  }
  function pauseStory() {
    story.paused = !story.paused;
    $('#storyPause').innerHTML = story.paused ? `${ico('i-play')}<span>Resume</span>` : `${ico('i-pause')}<span>Pause</span>`;
    if (window.speechSynthesis) story.paused ? speechSynthesis.pause() : speechSynthesis.resume();
  }
  function stopStory() {
    story.on = false; cancelAnimationFrame(story.raf); document.body.classList.remove('story-on'); $('#story').hidden = true;
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (story.paused) pauseStory();
    log('story_end', { step: story.i });
  }

  /* ======================= onboarding ======================= */
  let obI = 0;
  function startOnboard() { obI = 0; $('#onboard').hidden = false; showOb(); $('#obNext').focus(); }
  function showOb() {
    const s = K.ONBOARD[obI], el = $(s.sel), r = el.getBoundingClientRect(), pad = 6;
    Object.assign($('#obSpot').style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    $('#obStep').textContent = `STEP ${obI + 1} / ${K.ONBOARD.length}`; $('#obTitle').textContent = s.title; $('#obText').textContent = s.text;
    $('#obNext').textContent = obI === K.ONBOARD.length - 1 ? 'Start exploring' : 'Next';
    const card = $('#obCard'), cw = 300, ch = card.offsetHeight || 170, vw = innerWidth, vh = innerHeight;
    let x = r.right + 18, y = r.top;
    if (x + cw > vw - 10) x = r.left - cw - 18;
    if (x < 10) { x = Math.min(vw - cw - 10, Math.max(10, r.left)); y = r.top - ch - 18; if (y < 10) y = r.bottom + 18; }
    y = Math.max(10, Math.min(vh - ch - 10, y));
    Object.assign(card.style, { left: x + 'px', top: y + 'px' });
  }
  function endOnboard() { $('#onboard').hidden = true; store.set('sarAtlasOnboarded', '1'); }

  /* ======================= tooltips ======================= */
  function initTooltips() {
    const tip = $('#tooltip'); let cur = null;
    const show = (el) => {
      const term = el.dataset.term, text = term ? K.GLOSSARY[term] : el.dataset.tip; if (!text) return;
      cur = el; tip.innerHTML = term ? `<b>${escapeHtml(term)}</b>${escapeHtml(text)}` : escapeHtml(text); tip.hidden = false;
      const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2, y = r.bottom + 8;
      if (y + th > innerHeight - 8) y = r.top - th - 8;
      x = Math.max(8, Math.min(innerWidth - tw - 8, x));
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    };
    const hide = () => { cur = null; tip.hidden = true; };
    document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-tip],[data-term]'); if (el && el !== cur) show(el); else if (!el && cur) hide(); });
    document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip],[data-term]'); if (el) show(el); });
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
  }

  /* ======================= static UI + events ======================= */
  function buildStatic() {
    $('#regionList').innerHTML = D.regions.map((r, i) => {
      const [w, s, e, n] = r.bbox, cy = (s + n) / 2, cx = (w + e) / 2;
      return `<button class="region-card" role="listitem" data-id="${r.id}" aria-current="false" data-tip="Fly to ${r.name} (key ${i + 1})">
        <span class="rc-top"><span class="rc-name">${r.name}</span><span class="rc-place">${r.place}</span></span><span class="rc-theme" style="text-align:left">${r.theme}</span>
        <span class="rc-meta"><span>${Math.abs(cy).toFixed(2)}&deg;${cy >= 0 ? 'N' : 'S'} ${Math.abs(cx).toFixed(2)}&deg;${cx >= 0 ? 'E' : 'W'}</span><span>30 MO</span><span>64 x 64</span></span></button>`;
    }).join('');
    $('#regionOptions').innerHTML = D.regions.map((r) => `<option value="${r.name}">${r.place} - ${r.theme}</option>`).join('');
    $('#basemap').innerHTML = Object.entries(globe.basemaps).map(([k, b]) => `<option value="${k}" ${globe.available.includes(k) || globe.kind !== 'cesium' ? '' : 'disabled'}>${b.label}${globe.available.includes(k) ? '' : ' (unavailable)'}</option>`).join('');
    $('#basemap').value = globe.basemap || 'satellite'; $('#basemap').disabled = globe.kind !== 'cesium';
    $('#reducedMotion').checked = st.reducedMotion; document.body.classList.toggle('reduce-motion', st.reducedMotion);
  }

  function bindEvents() {
    $('#regionList').addEventListener('click', (e) => { const c = e.target.closest('.region-card'); if (!c) return; if (c.dataset.id === st.region) globe.flyToRect(ds.bbox, flyDur(1.8)); else selectRegion(c.dataset.id); });
    $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('#regionSearch').value); });
    $('#regionSearch').addEventListener('change', (e) => { const r = D.regions.find((q) => q.name === e.target.value); if (r) doSearch(r.name); });
    $('#layerList').addEventListener('click', (e) => { const b = e.target.closest('.layer-opt'); if (b) setLayer(b.dataset.layer); });
    $('#layerList').addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return; e.preventDefault();
      const opts = $$('.layer-opt'), i = opts.findIndex((o) => o.dataset.layer === st.layer), n = opts[(i + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length];
      setLayer(n.dataset.layer); $(`.layer-opt[data-layer="${n.dataset.layer}"]`).focus();
    });
    $('#polSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; st.pol = b.dataset.pol; syncPol(); refreshFrame(); updateCompare(); if (st.tab === 'inspect') renderTab(); log('polarization', { pol: st.pol }); });
    $('#opacity').addEventListener('input', (e) => { st.opacity = +e.target.value; $('#opacityOut').textContent = Math.round(st.opacity * 100) + '%'; refreshFrame(); });
    $('#opacity').addEventListener('change', () => { updateCompare(); log('opacity', { value: st.opacity }); });
    for (const [id, key] of [['#ovLanduse', 'landuse'], ['#ovPop', 'pop'], ['#ovRoads', 'roads']]) $(id).addEventListener('change', (e) => { st.overlays[key] = e.target.checked; refreshFrame(); updateCompare(); renderOvLegend(); log('overlay', { [key]: e.target.checked }); });
    $('#ovOpacity').addEventListener('input', (e) => { st.ovOpacity = +e.target.value; $('#ovOpacityOut').textContent = Math.round(st.ovOpacity * 100) + '%'; refreshFrame(); });
    $('#ovOpacity').addEventListener('change', () => updateCompare());

    // compare
    $('#cmpOn').addEventListener('change', (e) => setCompareOn(e.target.checked));
    $$('[data-cmp]').forEach((b) => b.addEventListener('click', () => { st.compare.mode = b.dataset.cmp; $$('[data-cmp]').forEach((x) => x.setAttribute('aria-pressed', x === b)); updateCompare(); log('compare_mode', { mode: st.compare.mode }); }));
    $('#cmpA').addEventListener('change', (e) => { st.compare.a = +e.target.value; updateCompare(); log('compare_dates', { a: date(st.compare.a), b: date(st.compare.b) }); });
    $('#cmpB').addEventListener('change', (e) => { st.compare.b = +e.target.value; updateCompare(); log('compare_dates', { a: date(st.compare.a), b: date(st.compare.b) }); });
    $('#csClose').addEventListener('click', () => { st.compare.mode = 'swipe'; $$('[data-cmp]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.cmp === 'swipe')); updateCompare(); });
    const knob = $('#swipeKnob'); let dragging = false;
    knob.addEventListener('pointerdown', (e) => { dragging = true; knob.setPointerCapture(e.pointerId); });
    knob.addEventListener('pointermove', (e) => { if (!dragging) return; const r = $('#globe').getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); });
    knob.addEventListener('pointerup', () => { dragging = false; });
    knob.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { setSplit(st.compare.split - 0.03); e.preventDefault(); e.stopPropagation(); } if (e.key === 'ArrowRight') { setSplit(st.compare.split + 0.03); e.preventDefault(); e.stopPropagation(); } });

    // dock
    $('#playBtn').addEventListener('click', () => play(!st.playing));
    $('#stepBack').addEventListener('click', () => { play(false); setT(st.t - 1); });
    $('#stepFwd').addEventListener('click', () => { play(false); setT(st.t + 1); });
    $('#loopBtn').addEventListener('click', (e) => { st.loop = !st.loop; e.currentTarget.setAttribute('aria-pressed', st.loop); });
    $('#speed').addEventListener('change', (e) => { st.speed = +e.target.value; log('speed', { speed: st.speed }); });
    $('#timeSlider').addEventListener('input', (e) => { if (st.playing) play(false); setT(+e.target.value); });

    // map tools
    $('#zoomIn').addEventListener('click', () => globe.zoom(1.6));
    $('#zoomOut').addEventListener('click', () => globe.zoom(1 / 1.6));
    $('#zoomRegion').addEventListener('click', () => globe.flyToRect(ds.bbox, flyDur(1.8)));
    $('#zoomWorld').addEventListener('click', () => globe.flyToView({ lon: (ds.bbox[0] + ds.bbox[2]) / 2, lat: (ds.bbox[1] + ds.bbox[3]) / 2, height: 18000000, pitch: -90 }, flyDur(2)));

    // panels and tabs
    $('#collapseLeft').addEventListener('click', () => toggleLeft());
    $('#collapseRight').addEventListener('click', () => toggleRight());
    $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) setTab(b.dataset.tab); });
    $('.tabs').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.stopPropagation(); e.preventDefault();
      const tabs = $$('.tabs [role=tab]'), i = tabs.findIndex((t) => t.dataset.tab === st.tab), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      setTab(n.dataset.tab); n.focus();
    });
    // delegated events for re-rendered tab content
    const body = $('#tabBody');
    body.addEventListener('change', (e) => {
      const id = e.target.id;
      if (id === 'fcTarget') { st.fc.target = e.target.value; renderTab(); log('forecast_target', { target: st.fc.target }); }
      if (id === 'fcScope') { st.fc.scope = e.target.value; renderTab(); log('forecast_scope', { scope: st.fc.scope }); }
      if (id === 'fcH') { renderTab(); const el = $('#fcH'); if (el) el.focus(); log('forecast_horizon', { months: st.fc.horizon }); }
      if (id === 'corrX' || id === 'corrY') { st.corr[id === 'corrX' ? 'x' : 'y'] = e.target.value; renderTab(); log('correlate', st.corr); }
    });
    body.addEventListener('input', (e) => { if (e.target.id === 'fcH') { st.fc.horizon = +e.target.value; const o = e.target.parentElement.querySelector('output'); if (o) o.textContent = st.fc.horizon + ' mo'; } });
    body.addEventListener('click', (e) => {
      const m = e.target.closest('[data-model]'); if (m) { st.fc.model = m.dataset.model; renderTab(); log('forecast_model', { model: st.fc.model }); return; }
      const l = e.target.closest('[data-level]'); if (l) { st.level = l.dataset.level; renderTab(); return; }
      if (e.target.closest('#corrShow')) {
        const cv = $('#corrMini'); st.corrField = cv && cv._fld ? cv._fld : corrMapField(); st.corrLabel = `${CV[st.corr.x].l} x ${CV[st.corr.y].l}`;
        setLayer('corrmap'); log('correlation_map', st.corr); toast('Correlation map is on the globe. Pick another layer to return.'); return;
      }
      if (e.target.closest('#exMoreLimits')) openAbout('limits');
    });

    // researcher
    $('#modeExplorer').addEventListener('click', () => setMode('explorer'));
    $('#modeResearcher').addEventListener('click', () => setMode('researcher'));
    $('#thr').addEventListener('input', (e) => { st.threshold = +e.target.value; $('#thrOut').textContent = st.threshold.toFixed(1) + ' dB'; refreshFrame(); });
    $('#thr').addEventListener('change', () => { updateCompare(); renderTab(); if (st.roiCells) renderRoiStats(); log('threshold', { db: st.threshold }); });
    $('#refDate').addEventListener('change', (e) => { st.refT = +e.target.value; refreshFrame(); updateCompare(); renderTab(); log('reference', { date: date(st.refT) }); });
    $('#exprApply').addEventListener('click', () => applyExpr());
    $('#expr').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyExpr(); } e.stopPropagation(); });
    $('#exprChips').addEventListener('click', (e) => { const c = e.target.closest('[data-expr]'); if (c) { $('#expr').value = c.dataset.expr; applyExpr(); } });
    $('#roiDraw').addEventListener('click', startRoi);
    $('#roiFinish').addEventListener('click', finishRoi);
    $('#roiClear').addEventListener('click', () => clearRoi());
    for (const [id, k] of [['scRain', 'rain'], ['scDefor', 'defor'], ['scPump', 'pump']]) {
      $('#' + id).addEventListener('input', (e) => { st.scen[k] = +e.target.value; $('#' + id + 'Out').textContent = (st.scen[k] >= 0 ? '+' : '') + st.scen[k] + '%'; if (st.tab === 'forecast') renderTab(); });
      $('#' + id).addEventListener('change', () => { if (st.tab !== 'forecast') setTab('forecast'); log('scenario', Object.assign({}, st.scen)); });
    }
    $('#exCsv').addEventListener('click', exportCsv);
    $('#exGeo').addEventListener('click', exportGeoJSON);
    $('#exPng').addEventListener('click', exportPng);
    $('#exRecipe').addEventListener('click', () => { log('export_recipe'); download(`sar-atlas_${ds.id}_recipe.json`, JSON.stringify(Object.assign(recipe(), { mode: st.mode }), null, 2), 'application/json'); });
    $('#recipeFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { await loadRecipe(JSON.parse(await f.text())); toast('Recipe loaded: settings reproduced.'); } catch (err) { toast('Could not load recipe: ' + err.message); }
      e.target.value = '';
    });
    $('#copyLog').addEventListener('click', async () => { const txt = JSON.stringify(opLog, null, 2); try { await navigator.clipboard.writeText(txt); toast('Operation log copied.'); } catch (e) { download('sar-atlas_log.json', txt, 'application/json'); } });

    // top bar
    $('#btnStory').addEventListener('click', () => (story.on ? stopStory() : startStory()));
    $('#storyPause').addEventListener('click', pauseStory);
    $('#storyExit').addEventListener('click', stopStory);
    $('#btnAbout').addEventListener('click', () => openAbout('about'));
    $('#aboutClose').addEventListener('click', closeAbout);
    $('#aboutModal').addEventListener('click', (e) => { if (e.target.id === 'aboutModal') closeAbout(); });
    $$('[data-about]').forEach((b) => b.addEventListener('click', () => openAbout(b.dataset.about)));
    $('#btnSettings').addEventListener('click', (e) => { const p = $('#settingsPop'); p.hidden = !p.hidden; e.currentTarget.setAttribute('aria-expanded', !p.hidden); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#settingsPop') && !e.target.closest('#btnSettings')) { $('#settingsPop').hidden = true; $('#btnSettings').setAttribute('aria-expanded', 'false'); } });
    $('#basemap').addEventListener('change', (e) => { globe.setBasemap(e.target.value); log('basemap', { key: e.target.value }); });
    $('#reducedMotion').addEventListener('change', (e) => { st.reducedMotion = e.target.checked; document.body.classList.toggle('reduce-motion', st.reducedMotion); });
    $('#narrate').addEventListener('change', (e) => { st.narrate = e.target.checked; if (!window.speechSynthesis && st.narrate) toast('Speech synthesis is not available in this browser.'); });
    $('#replayOnboard').addEventListener('click', () => { $('#settingsPop').hidden = true; startOnboard(); });
    $('#obNext').addEventListener('click', () => { obI++; if (obI >= K.ONBOARD.length) endOnboard(); else showOb(); });
    $('#obSkip').addEventListener('click', endOnboard);
    window.addEventListener('resize', () => { if (!$('#onboard').hidden) showOb(); });

    // keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.key === 'Escape') { if (!$('#onboard').hidden) endOnboard(); else if (!$('#aboutModal').hidden) closeAbout(); else if (story.on) stopStory(); else if (st.drawing) clearRoi(); $('#settingsPop').hidden = true; return; }
      if (['input', 'select', 'textarea'].includes(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
      if (!$('#aboutModal').hidden || !$('#onboard').hidden) return;
      if (e.key === ' ' && tag !== 'button') { e.preventDefault(); play(!st.playing); }
      else if (e.key === 'ArrowRight' && tag !== 'input') { play(false); setT(st.t + 1); }
      else if (e.key === 'ArrowLeft' && tag !== 'input') { play(false); setT(st.t - 1); }
      else if (['1', '2', '3'].includes(e.key)) { const r = D.regions[+e.key - 1]; if (r) selectRegion(r.id); }
      else if (e.key.toLowerCase() === 'c') setCompareOn(!st.compare.on);
      else if (e.key.toLowerCase() === 'e') setTab('explain');
      else if (e.key.toLowerCase() === 'r') setMode(st.mode === 'researcher' ? 'explorer' : 'researcher');
      else if (e.key === 'Enter' && st.drawing) finishRoi();
    });
  }

  function doSearch(q) {
    q = (q || '').trim(); if (!q) return;
    const r = D.regions.find((x) => (x.name + ' ' + x.place).toLowerCase().includes(q.toLowerCase()));
    if (r) { selectRegion(r.id); log('search', { q }); return; }
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = +m[1], lon = +m[2];
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('Coordinates out of range. Use latitude, longitude.'); return; }
      globe.flyToView({ lon, lat, height: 450000, pitch: -90 }, flyDur(2.4));
      const inR = D.regions.find((x) => lon >= x.bbox[0] && lon <= x.bbox[2] && lat >= x.bbox[1] && lat <= x.bbox[3]);
      if (inR && inR.id !== st.region) selectRegion(inR.id, { fly: false });
      else if (!inR) toast(`No demo data at ${lat.toFixed(2)}, ${lon.toFixed(2)}. Real NISAR scenes for any place can be added with preprocess/ (see About).`, 5200);
      log('search', { lat, lon }); return;
    }
    toast('No match. Try "Jakarta" or coordinates like 29.4, -89.8.');
  }

  function openAbout(which) {
    $('#aboutModal').hidden = false;
    $$('[data-about]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.about === which));
    $('#aboutBody').innerHTML = which === 'limits'
      ? `<h3>Limitations</h3>${K.LIMITATIONS.map(([h, t]) => `<div class="limit-item"><b>${h}</b>${t}</div>`).join('')}<h3>Honesty rules this app follows</h3><ul><li>Every view carries the "Simulated demo data" label.</li><li>Every forecast shows an uncertainty band and its backtest error.</li><li>Every correlation is labelled as correlation, not causation.</li><li>Drivers are presented as hypotheses.</li></ul>`
      : K.ABOUT;
    $('#aboutClose').focus();
  }
  function closeAbout() { $('#aboutModal').hidden = true; $('#btnAbout').focus(); }

  /* ======================= boot ======================= */
  async function boot() {
    showLoading('Starting globe');
    globe = new SAR.GlobeHost($('#globe'));
    globe.on('click', onGlobeClick);
    globe.on('move', onGlobeMove);
    globe.on('dblclick', () => { if (st.drawing) finishRoi(); });
    const kind = await globe.init(st.basemap);
    if (kind !== 'cesium') toast(window.Cesium ? 'Map imagery could not load. Showing the stylized globe instead.' : 'CesiumJS could not load (offline?). Showing the stylized globe instead.', 5200);
    buildStatic(); bindEvents(); initTooltips(); setMode('explorer');
    setTab('inspect');
    await selectRegion(st.region, { dur: 3.2 });
    renderOvLegend();
    log('boot', { engine: kind, basemap: globe.basemap || null, simulated: true });
    if (!store.get('sarAtlasOnboarded')) setTimeout(startOnboard, st.reducedMotion ? 100 : 1600);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  // expose for debugging and tests
  SAR.app = { st, get ds() { return ds; }, setT, selectRegion, setLayer, startStory, stopStory, exportCsv, recipe, targetSeries };
})();
