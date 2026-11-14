/* SAR Atlas - globe.js
 * GlobeHost: one interface, two engines.
 *   CesiumImpl  - CesiumJS (no Ion token) with free imagery (Esri, CARTO, OSM).
 *   CanvasImpl  - stylized orthographic globe on a 2D canvas, used when Cesium,
 *                 WebGL or every imagery source fails, so the demo never breaks.
 * The host stores all view state and re-applies it if the engine is swapped.
 */
(function () {
  'use strict';
  const SAR = (window.SAR = window.SAR || {});
  const D2R = Math.PI / 180;

  const BASEMAPS = {
    satellite: { label: 'Satellite (Esri World Imagery)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', credit: 'Imagery: Esri, Maxar, Earthstar Geographics', test: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/1/0/0' },
    dark: { label: 'Dark (CARTO)', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', sub: ['a', 'b', 'c', 'd'], credit: 'Map tiles: CARTO, data: OpenStreetMap contributors', test: 'https://a.basemaps.cartocdn.com/dark_all/1/0/0.png' },
    osm: { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', credit: 'Data and tiles: OpenStreetMap contributors', test: 'https://tile.openstreetmap.org/1/0/0.png' }
  };

  function probe(url, ms) {
    return new Promise((res) => {
      const img = new Image(); let done = false;
      const fin = (ok) => { if (!done) { done = true; res(ok); } };
      const tm = setTimeout(() => fin(false), ms);
      img.crossOrigin = 'anonymous';
      img.onload = () => { clearTimeout(tm); fin(img.naturalWidth > 0); };
      img.onerror = () => { clearTimeout(tm); fin(false); };
      img.src = url;
    });
  }
  function webglOK() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }

  /* ======================= Cesium engine ======================= */
  class CesiumImpl {
    constructor(el, host, basemap) { this.el = el; this.host = host; this.basemap = basemap; this.regionEnts = []; this.cmp = []; }
    makeProvider(key) {
      const C = window.Cesium, b = BASEMAPS[key];
      const opt = { url: b.url, credit: new C.Credit(b.credit), maximumLevel: 18 };
      if (b.sub) opt.subdomains = b.sub;
      return new C.UrlTemplateImageryProvider(opt);
    }
    async init() {
      const C = window.Cesium;
      const wrap = document.createElement('div'); wrap.className = 'cesium-wrap'; this.el.appendChild(wrap); this.wrap = wrap;
      const v = (this.v = new C.Viewer(wrap, {
        baseLayer: new C.ImageryLayer(this.makeProvider(this.basemap)),
        terrainProvider: new C.EllipsoidTerrainProvider(),
        baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
        animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
        contextOptions: { webgl: { preserveDrawingBuffer: true } }
      }));
      v.scene.globe.baseColor = C.Color.fromCssColorString('#0b1622');
      v.scene.backgroundColor = C.Color.fromCssColorString('#04060a');
      v.scene.globe.showGroundAtmosphere = true;
      v.scene.screenSpaceCameraController.minimumZoomDistance = 1500;
      v.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      v.camera.setView({ destination: C.Cartesian3.fromDegrees(-40, 10, 22000000) });

      // the change layer: one rectangle whose texture is swapped by returning a new canvas
      this.img = document.createElement('canvas'); this.img.width = this.img.height = 2;
      this.overlay = v.entities.add({
        show: false,
        rectangle: {
          coordinates: C.Rectangle.fromDegrees(0, 0, 1, 1), height: 0,
          material: new C.ImageMaterialProperty({ image: new C.CallbackProperty(() => this.img, false), transparent: true })
        }
      });
      this.marker = v.entities.add({ show: false, position: C.Cartesian3.fromDegrees(0, 0), point: { pixelSize: 11, color: C.Color.fromCssColorString('#f2a541'), outlineColor: C.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      this.roiPts = [];
      this.roi = v.entities.add({
        show: false,
        polyline: { positions: new C.CallbackProperty(() => this.roiLine(), false), width: 2, material: C.Color.fromCssColorString('#5cc8e0'), clampToGround: false },
        polygon: { hierarchy: new C.CallbackProperty(() => new C.PolygonHierarchy(this.roiPts.map((p) => C.Cartesian3.fromDegrees(p[0], p[1]))), false), material: C.Color.fromCssColorString('#5cc8e0').withAlpha(0.18), height: 0 }
      });
      const h = (this.handler = new C.ScreenSpaceEventHandler(v.scene.canvas));
      h.setInputAction((e) => { const ll = this.pick(e.position); if (ll) this.host._emit('click', ll); }, C.ScreenSpaceEventType.LEFT_CLICK);
      h.setInputAction((e) => { const ll = this.pick(e.endPosition); this.host._emit('move', ll); }, C.ScreenSpaceEventType.MOUSE_MOVE);
      h.setInputAction(() => this.host._emit('dblclick'), C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }
    roiLine() { const C = window.Cesium; const p = this.roiPts.slice(); if (this.roiClosed && p.length > 2) p.push(p[0]); return p.map((q) => C.Cartesian3.fromDegrees(q[0], q[1], 30)); }
    pick(pos) {
      const C = window.Cesium; if (!pos) return null;
      const c = this.v.camera.pickEllipsoid(pos, this.v.scene.globe.ellipsoid); if (!c) return null;
      const g = C.Cartographic.fromCartesian(c);
      return { lon: C.Math.toDegrees(g.longitude), lat: C.Math.toDegrees(g.latitude) };
    }
    setRegions(list, activeId) {
      const C = window.Cesium;
      this.regionEnts.forEach((e) => this.v.entities.remove(e)); this.regionEnts = [];
      for (const r of list) {
        const [w, s, e, n] = r.bbox, act = r.id === activeId;
        const col = C.Color.fromCssColorString(act ? '#f2a541' : '#8b97a7');
        this.regionEnts.push(this.v.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n, w, s]), width: act ? 2 : 1.2, material: act ? new C.PolylineDashMaterialProperty({ color: col, dashLength: 12 }) : col } }));
        this.regionEnts.push(this.v.entities.add({
          position: C.Cartesian3.fromDegrees(w, n),
          label: { text: r.name.toUpperCase(), font: '600 12px "IBM Plex Mono", monospace', fillColor: col, outlineColor: C.Color.fromCssColorString('#05070a'), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -12), horizontalOrigin: C.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY }
        }));
      }
    }
    setOverlay(o) {
      const C = window.Cesium;
      if (!o) { this.overlay.show = false; return; }
      const key = o.bbox.join(',');
      if (key !== this._bboxKey) { this.overlay.rectangle.coordinates = C.Rectangle.fromDegrees(...o.bbox); this._bboxKey = key; }
      this.img = o.canvas; this.overlay.show = !this.cmp.length;
    }
    setCompare(c) {
      const C = window.Cesium, L = this.v.imageryLayers;
      this.cmp.forEach((l) => L.remove(l, true)); this.cmp = [];
      if (!c) { this.overlay.show = !!this.host.state.overlay; return; }
      const rect = C.Rectangle.fromDegrees(...c.bbox);
      const mk = (cv, dir) => {
        const p = new C.SingleTileImageryProvider({ url: cv.toDataURL(), rectangle: rect, tileWidth: cv.width, tileHeight: cv.height });
        const l = L.addImageryProvider(p); l.splitDirection = dir; return l;
      };
      this.cmp.push(mk(c.a, C.SplitDirection.LEFT), mk(c.b, C.SplitDirection.RIGHT));
      this.overlay.show = false;
    }
    setSplit(f) { this.v.scene.splitPosition = f; }
    setMarker(m) { const C = window.Cesium; if (!m) { this.marker.show = false; return; } this.marker.position = C.Cartesian3.fromDegrees(m.lon, m.lat, 40); this.marker.show = true; }
    setRoi(r) { if (!r || !r.pts.length) { this.roi.show = false; this.roiPts = []; return; } this.roiPts = r.pts; this.roiClosed = r.closed; this.roi.show = true; this.roi.polygon.show = r.closed && r.pts.length > 2; }
    flyToRect(bbox, dur) {
      const C = window.Cesium, [w, s, e, n] = bbox, pw = (e - w) * 0.35, ph = (n - s) * 0.35;
      this.v.camera.flyTo({ destination: C.Rectangle.fromDegrees(w - pw, s - ph, e + pw, n + ph), duration: dur });
    }
    flyToView(vw, dur) {
      const C = window.Cesium;
      this.v.camera.flyTo({ destination: C.Cartesian3.fromDegrees(vw.lon, vw.lat, vw.height), orientation: { heading: C.Math.toRadians(vw.heading || 0), pitch: C.Math.toRadians(vw.pitch == null ? -90 : vw.pitch), roll: 0 }, duration: dur });
    }
    zoom(f) { const h = this.v.camera.positionCartographic.height; f > 1 ? this.v.camera.zoomIn(h * (1 - 1 / f)) : this.v.camera.zoomOut(h * (1 / f - 1)); }
    setBasemap(key) { const L = this.v.imageryLayers; const base = L.get(0); L.remove(base, true); L.addImageryProvider(this.makeProvider(key), 0); this.basemap = key; }
    screenshot() { this.v.render(); return this.v.canvas; }
    destroy() { try { this.handler && this.handler.destroy(); this.v && this.v.destroy(); } catch (e) { /* ignore */ } this.wrap && this.wrap.remove(); }
  }

  /* ======================= Canvas fallback engine ======================= */
  class CanvasImpl {
    constructor(el, host) { this.el = el; this.host = host; this.lon0 = -40; this.lat0 = 12; this.R = 240; this.anim = null; this.dirty = true; }
    init() {
      const c = (this.c = document.createElement('canvas')); c.className = 'fallback-globe'; c.setAttribute('aria-label', 'Stylized globe'); this.el.appendChild(c);
      this.ctx = c.getContext('2d');
      const note = (this.note = document.createElement('div')); note.className = 'fallback-note mono'; note.textContent = 'STYLIZED GLOBE - IMAGERY UNAVAILABLE'; this.el.appendChild(note);
      this.resize(); this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.el);
      const r = mulberry(7); this.stars = Array.from({ length: 260 }, () => [r(), r(), r() * 1.2 + 0.2]);
      let drag = null;
      c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }; c.setPointerCapture(e.pointerId); this.anim = null; });
      c.addEventListener('pointermove', (e) => {
        const b = c.getBoundingClientRect();
        this.host._emit('move', this.inv(e.clientX - b.left, e.clientY - b.top));
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        this.lon0 -= (dx / this.R) / D2R / Math.max(Math.cos(this.lat0 * D2R), 0.2);
        this.lat0 = Math.max(-85, Math.min(85, this.lat0 + (dy / this.R) / D2R));
        this.dirty = true;
      });
      c.addEventListener('pointerup', (e) => {
        if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) { const b = c.getBoundingClientRect(); const ll = this.inv(e.clientX - b.left, e.clientY - b.top); if (ll) this.host._emit('click', ll); }
        drag = null;
      });
      c.addEventListener('dblclick', () => this.host._emit('dblclick'));
      c.addEventListener('wheel', (e) => { e.preventDefault(); this.anim = null; this.R = Math.max(120, Math.min(4e6, this.R * Math.exp(-e.deltaY * 0.0015))); this.dirty = true; }, { passive: false });
      const loop = (ts) => { this.raf = requestAnimationFrame(loop); this.step(ts); if (this.dirty) { this.dirty = false; this.draw(); } };
      this.raf = requestAnimationFrame(loop);
    }
    resize() { const b = this.el.getBoundingClientRect(), d = window.devicePixelRatio || 1; this.W = b.width; this.H = b.height; this.c.width = b.width * d; this.c.height = b.height * d; this.c.style.width = b.width + 'px'; this.c.style.height = b.height + 'px'; this.ctx.setTransform(d, 0, 0, d, 0, 0); this.dirty = true; }
    proj(lon, lat) {
      const l = (lon - this.lon0) * D2R, p = lat * D2R, p0 = this.lat0 * D2R;
      const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
      return [this.W / 2 + this.R * Math.cos(p) * Math.sin(l), this.H / 2 - this.R * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l)), cosc > 0];
    }
    inv(x, y) {
      const px = (x - this.W / 2) / this.R, py = (this.H / 2 - y) / this.R, rho = Math.hypot(px, py);
      if (rho > 1) return null;
      const p0 = this.lat0 * D2R; if (rho < 1e-9) return { lon: this.lon0, lat: this.lat0 };
      const c = Math.asin(rho);
      const lat = Math.asin(Math.cos(c) * Math.sin(p0) + (py * Math.sin(c) * Math.cos(p0)) / rho);
      const lon = this.lon0 / 1 + Math.atan2(px * Math.sin(c), rho * Math.cos(p0) * Math.cos(c) - py * Math.sin(p0) * Math.sin(c)) / D2R;
      return { lon: ((lon + 540) % 360) - 180, lat: lat / D2R };
    }
    step(ts) {
      const a = this.anim; if (!a) return;
      if (a.t0 == null) a.t0 = ts;
      const k = a.dur <= 0 ? 1 : Math.min(1, (ts - a.t0) / a.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      let dl = a.lon - a.lon1; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
      this.lon0 = a.lon1 + dl * e; this.lat0 = a.lat1 + (a.lat - a.lat1) * e;
      const zoomOut = Math.min(a.R1, a.R) * (a.R1 > 5000 && a.R > 5000 && Math.abs(dl) > 20 ? 0.02 : 1);
      const mid = Math.log(Math.max(130, zoomOut));
      const lr = k < 0.5 ? Math.log(a.R1) + (mid - Math.log(a.R1)) * (e * 2) : mid + (Math.log(a.R) - mid) * ((e - 0.5) * 2);
      this.R = Math.exp(lr); this.dirty = true;
      if (k >= 1) this.anim = null;
    }
    go(lon, lat, R, dur) { this.anim = { lon, lat, R, dur: dur * 1000, lon1: this.lon0, lat1: this.lat0, R1: this.R }; this.dirty = true; }
    flyToRect(bbox, dur) { const [w, s, e, n] = bbox, lat = (s + n) / 2; const span = Math.max((e - w) * Math.cos(lat * D2R), n - s) * D2R; this.go((w + e) / 2, lat, (0.5 * Math.min(this.W, this.H)) / span, dur); }
    flyToView(v, dur) {
      // tilt is not modelled here: offset the target toward the view direction so framing matches roughly
      const R = (6371 * Math.min(this.W, this.H)) / ((v.height / 1000) * 1.25);
      this.go(v.lon, v.lat + (v.pitch != null && v.pitch > -80 ? (v.height / 111000) * 0.25 : 0), Math.max(130, R), dur);
    }
    zoom(f) { this.R = Math.max(120, Math.min(4e6, this.R * f)); this.dirty = true; }
    setRegions() { this.dirty = true; } setOverlay() { this.dirty = true; } setCompare() { this.dirty = true; } setSplit() { this.dirty = true; }
    setMarker() { this.dirty = true; } setRoi() { this.dirty = true; } setBasemap() { }
    screenshot() { this.draw(); return this.c; }
    destroy() { cancelAnimationFrame(this.raf); this.ro && this.ro.disconnect(); this.c.remove(); this.note.remove(); }
    draw() {
      const ctx = this.ctx, W = this.W, H = this.H, R = this.R, st = this.host.state, cx = W / 2, cy = H / 2;
      ctx.fillStyle = '#04060a'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#c9d3df';
      for (const s of this.stars) { ctx.globalAlpha = 0.15 + 0.35 * (s[2] / 1.4); ctx.fillRect(s[0] * W, s[1] * H, s[2], s[2]); }
      ctx.globalAlpha = 1;
      // atmosphere + shaded sphere
      if (R < Math.max(W, H) * 3) {
        const glow = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.12);
        glow.addColorStop(0, 'rgba(92,200,224,0.28)'); glow.addColorStop(1, 'rgba(92,200,224,0)');
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2); ctx.fill();
      }
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
      g.addColorStop(0, '#1d4a66'); g.addColorStop(0.55, '#0f2c42'); g.addColorStop(1, '#06121d');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // graticule, density depends on zoom
      const step = R < 700 ? 15 : R < 4000 ? 5 : R < 30000 ? 1 : 0.25;
      const win = R < 2000 ? 180 : Math.min(180, (Math.max(W, H) / R) / D2R * 1.2 + step);
      ctx.strokeStyle = 'rgba(140,180,210,0.16)'; ctx.lineWidth = 1;
      const lo0 = Math.floor((this.lon0 - win / Math.max(Math.cos(this.lat0 * D2R), 0.1)) / step) * step;
      const la0 = Math.max(-90, Math.floor((this.lat0 - win) / step) * step), la1 = Math.min(90, this.lat0 + win);
      const lo1 = this.lon0 + win / Math.max(Math.cos(this.lat0 * D2R), 0.1);
      const seg = (fn, a, b, n) => { ctx.beginPath(); let pen = false; for (let i = 0; i <= n; i++) { const p = fn(a + ((b - a) * i) / n); if (p[2]) { pen ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); pen = true; } else pen = false; } ctx.stroke(); };
      for (let lo = lo0; lo <= lo1 && lo - lo0 < 360; lo += step) seg((la) => this.proj(lo, la), la0, la1, 60);
      for (let la = la0; la <= la1; la += step) seg((lo) => this.proj(lo, la), lo0, Math.min(lo1, lo0 + 360), 90);
      // overlay cells (or compare halves)
      const drawCells = (px, bbox, nx, ny) => {
        const [w, s, e, n] = bbox, dx = (e - w) / nx, dy = (n - s) / ny;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const k = j * nx + i, a = px[k * 4 + 3]; if (!a) continue;
          const lo = w + i * dx, la = n - j * dy;
          const p1 = this.proj(lo, la), p2 = this.proj(lo + dx, la), p3 = this.proj(lo + dx, la - dy), p4 = this.proj(lo, la - dy);
          if (!p1[2]) continue;
          ctx.fillStyle = ctx.strokeStyle = `rgba(${px[k * 4]},${px[k * 4 + 1]},${px[k * 4 + 2]},${a / 255})`;
          ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]); ctx.closePath(); ctx.fill();
          if (a > 200) { ctx.lineWidth = 0.7; ctx.stroke(); } // hide anti-aliasing seams between opaque cells
        }
      };
      if (st.compare) {
        const sx = st.split * W;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip(); drawCells(st.compare.pxA, st.compare.bbox, st.compare.nx, st.compare.ny); ctx.restore();
        ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); drawCells(st.compare.pxB, st.compare.bbox, st.compare.nx, st.compare.ny); ctx.restore();
      } else if (st.overlay && st.overlay.px) drawCells(st.overlay.px, st.overlay.bbox, st.overlay.nx, st.overlay.ny);
      // region outlines
      ctx.font = '600 12px "IBM Plex Mono", monospace';
      for (const r of st.regions) {
        const [w, s, e, n] = r.bbox, act = r.id === st.active;
        ctx.strokeStyle = act ? '#f2a541' : 'rgba(170,182,198,0.8)'; ctx.lineWidth = act ? 1.6 : 1; ctx.setLineDash(act ? [7, 5] : []);
        seg((q) => (q < 1 ? this.proj(w + (e - w) * q, n) : q < 2 ? this.proj(e, n - (n - s) * (q - 1)) : q < 3 ? this.proj(e - (e - w) * (q - 2), s) : this.proj(w, s + (n - s) * (q - 3))), 0, 4, 80);
        ctx.setLineDash([]);
        const p = this.proj(w, n); if (p[2]) { ctx.fillStyle = ctx.strokeStyle; ctx.fillText(r.name.toUpperCase(), p[0] + 2, p[1] - 8); }
      }
      // ROI and marker
      if (st.roi && st.roi.pts.length) {
        ctx.strokeStyle = '#5cc8e0'; ctx.fillStyle = 'rgba(92,200,224,0.18)'; ctx.lineWidth = 2; ctx.beginPath();
        st.roi.pts.forEach((q, i) => { const p = this.proj(q[0], q[1]); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
        if (st.roi.closed) { ctx.closePath(); ctx.fill(); } ctx.stroke();
      }
      if (st.marker) { const p = this.proj(st.marker.lon, st.marker.lat); if (p[2]) { ctx.fillStyle = '#f2a541'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p[0], p[1], 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } }
      ctx.restore();
      // terminator-like rim shading
      const rim = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R);
      rim.addColorStop(0, 'rgba(0,0,0,0)'); rim.addColorStop(1, 'rgba(0,0,0,0.35)');
      ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    }
  }
  function mulberry(a) { return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ======================= Host ======================= */
  class GlobeHost {
    constructor(el) {
      this.el = el; this.impl = null; this.kind = null; this.listeners = { click: [], move: [], dblclick: [], engine: [] };
      this.state = { regions: [], active: null, overlay: null, compare: null, split: 0.5, marker: null, roi: null, view: null };
      this.basemaps = BASEMAPS; this.available = [];
    }
    on(evt, fn) { this.listeners[evt].push(fn); }
    _emit(evt, arg) { this.listeners[evt].forEach((f) => f(arg)); }
    async init(pref) {
      let ok = false;
      if (window.Cesium && webglOK()) {
        const keys = Object.keys(BASEMAPS), res = await Promise.all(keys.map((k) => probe(BASEMAPS[k].test, 6000)));
        this.available = keys.filter((k, i) => res[i]);
        const key = this.available.includes(pref) ? pref : this.available[0];
        if (key) {
          try { this.impl = new CesiumImpl(this.el, this, key); await this.impl.init(); this.kind = 'cesium'; this.basemap = key; ok = true; }
          catch (e) { console.warn('[SAR Atlas] Cesium failed, using stylized globe:', e); if (this.impl) this.impl.destroy(); this.impl = null; }
        }
      }
      if (!ok) { this.impl = new CanvasImpl(this.el, this); this.impl.init(); this.kind = 'canvas'; }
      this._reapply(); this._emit('engine', this.kind);
      return this.kind;
    }
    _reapply() {
      const s = this.state, i = this.impl;
      i.setRegions(s.regions, s.active); i.setOverlay(s.overlay); i.setCompare(s.compare); i.setSplit(s.split); i.setMarker(s.marker); i.setRoi(s.roi);
    }
    setRegions(list, active) { this.state.regions = list; this.state.active = active; this.impl.setRegions(list, active); }
    /** o = {canvas, px, bbox, nx, ny} */
    setOverlay(o) { this.state.overlay = o; this.impl.setOverlay(o); }
    /** c = {a, b (canvases), pxA, pxB, bbox, nx, ny} or null */
    setCompare(c) { this.state.compare = c; this.impl.setCompare(c); }
    setSplit(f) { this.state.split = f; this.impl.setSplit(f); }
    setMarker(m) { this.state.marker = m; this.impl.setMarker(m); }
    setRoi(r) { this.state.roi = r; this.impl.setRoi(r); }
    flyToRect(bbox, dur) { this.impl.flyToRect(bbox, dur); }
    flyToView(v, dur) { this.impl.flyToView(v, dur); }
    zoom(f) { this.impl.zoom(f); }
    setBasemap(key) { if (this.kind === 'cesium') { this.impl.setBasemap(key); this.basemap = key; } }
    screenshot() { return this.impl.screenshot(); }
  }
  SAR.GlobeHost = GlobeHost;
})();
