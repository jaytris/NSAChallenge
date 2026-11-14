# SAR Atlas

A 3D globe for exploring surface change measured by radar: floods and wetland loss, deforestation, and land subsidence. Built for the NASA Space Apps Challenge 2026, "Dancing with the SARs" (NISAR, NASA-ISRO SAR).

Anyone can pick a place, scrub through 30 months, compare two dates, overlay human activity, read plain-English explanations and watch a guided story. Researchers get change thresholds, band math, ROI statistics, scenario forecasts, exports and an operation log that reproduces every analysis.

> **All data in this demo is simulated.** A seeded generator in `js/data.js` produces radar-like data that follows real scattering physics. The UI labels it everywhere. The path to real NISAR data is in `preprocess/` and described below.

## Run it

| Option | How |
|---|---|
| Single file | Open `dist/sar-atlas.html` in Chrome, Edge, Firefox or Safari. |
| Source files | Open `index.html` (same app, unbundled). |
| With real data | `python -m http.server` in this folder, then open `http://localhost:8000` (fetching JSON needs http). |

You need internet access for CesiumJS 1.120 (jsDelivr), the imagery tiles and Google Fonts. Without it, the app switches to a stylized canvas globe and system fonts, and every feature keeps working.

To rebuild the single file after editing: `python tools/build.py`.

## Showcase regions

| Region | Story | What the simulation encodes |
|---|---|---|
| Mississippi River Delta, Louisiana | Wetland loss and flooding | Marsh converts to open water, fastest near canals and at low elevation. Spring floods under vegetation brighten HH (double bounce). A storm surge in Aug 2025. Subsidence of 0.5 to 2.5 cm/yr. |
| Rondonia, Brazil | Deforestation | Fishbone side roads off BR-364, with new roads opening over time. Clearing spreads from the roads, mostly in the dry season (Jun to Oct), and drops HV by 6 to 8 dB. A protected reserve stays intact. |
| Jakarta, Indonesia | Land subsidence | Groundwater-driven subsidence bowls of up to about 25 cm/yr near the port and industrial zones. Monsoon floods cover more ground each year as it sinks. Southern green land converts to suburbs. |

Each region is a 64 x 64 grid with 30 monthly steps (Jan 2024 to Jun 2026). Rates of change are exaggerated so they show up clearly in a short demo.

## Architecture

```
sar-atlas/
  index.html            layout, inline SVG icon sprite, script order
  css/ui.css            theme, layout, responsive, reduced motion
  js/data.js            seeded generator + the single data adapter (loadRegion)
  js/models.js          stats, forecasting, backtest, correlation, band math, flood classifier
  js/render.js          per-cell fields, colour ramps, RGBA compositing, canvases, legends
  js/globe.js           GlobeHost: CesiumJS engine + canvas fallback engine
  js/charts.js          small SVG charts (line+band, scatter, bars, lag plot)
  js/content.js         glossary, explanations, stories, onboarding, about text
  js/app.js             state, UI, panels, compare, story, researcher tools, exports, log
  dist/sar-atlas.html   everything above inlined into one file
  tools/build.py        bundler
  preprocess/           real-data pipeline (rasterio, numpy, xarray, asf_search)
  classifier/           Earth Waltz open-water classifier (flood.py, model.json)
```

**Data flow.** `loadRegion(id)` returns a dataset. `render.field()` turns the dataset and view state into one value per cell. `render.compose()` blends that field with the overlays into per-cell RGBA in typed arrays. `render.toCanvas()` scales it up with nearest-neighbour sampling and draws roads as lines. `GlobeHost.setOverlay()` then hands the canvas to Cesium, as the texture of a rectangle entity, or to the canvas engine, which draws projected quads. One frame takes a few milliseconds, so animation stays smooth.

**Globe engines.** At startup the app checks each imagery source (Esri World Imagery, CARTO Dark, OpenStreetMap) and whether WebGL works. If Cesium, WebGL or every imagery source fails, it uses the stylized orthographic canvas globe. The host keeps the view state and re-applies it to whichever engine is running. No Cesium Ion token is used.

## Data schema (`sar-atlas/1`)

```jsonc
{
  "schema": "sar-atlas/1",
  "simulated": false,
  "source": "NISAR via preprocess/nisar_to_atlas.py",
  "region": { "id": "mississippi", "name": "...", "bbox": [w, s, e, n], "nx": 64, "ny": 64, "dispCap": 6, "primary": "water" },
  "times": ["2025-11-01", "2025-12-01", "..."],          // T monthly steps
  "variables": {                                          // T*N float32, base64 (little-endian) or plain arrays
    "HH": "...", "HV": "...", "VV": "...",               // dB, gamma-0
    "water": "...",                                       // 0..1 inundated fraction (0.6 = flooded vegetation)
    "veg": "...",                                         // 1 = vegetation lost since first date
    "disp": "...",                                        // cumulative LOS displacement, cm
    "rain": "...", "urban": "...", "roads": "..."        // optional
  },
  "static": { "pop": "...", "landuse": "...", "roadDist": "..." },   // N values, optional
  "series": { "rain": "..." }                                         // T values, optional
}
```

Index: `t * N + j * nx + i`, with N = nx * ny and row j = 0 at the north edge (EPSG:4326). Missing variables become NaN, and the matching layers show as empty.

## Mapping real NISAR products to the schema

| Schema field | NISAR product (ASF DAAC) | Processing in `preprocess/` | Sentinel-1 fallback |
|---|---|---|---|
| `HH`, `HV`, `VV` | L2 GCOV, frequency A, HHHH / HVHV / VVVV, linear gamma-0 | Reproject to grid (average in linear power), monthly mean, then 10 log10 | GRD or RTC: VV to `VV` and `HH`, VH to `HV` |
| `water` | Derived from GCOV | Open water where HH < -18 dB and HV < -24 dB. Flooded vegetation where HH is more than 3 dB above the median and HV is stable | Same thresholds on VV and VH (tune for C-band) |
| `veg` | Derived from GCOV HV | HV more than 3 dB below the first date for 2 consecutive months, cumulative | VH drop (weaker at C-band) |
| `disp` | L2 GUNW unwrapped phase, consecutive pairs | LOS cm = -phase * 0.2384 m / (4 pi) * 100, then cumulative sum | Sentinel-1 interferograms (lambda = 5.55 cm), e.g. ASF HyP3 InSAR |
| `rain` | Not NISAR: GPM IMERG monthly | `rain_mm` list in the manifest | Same |
| `pop`, `landuse`, `roadDist` | Not NISAR: WorldPop, ESA WorldCover, OpenStreetMap | Optional rasters in the manifest, resampled to the grid | Same |

### Real-data steps

```sh
cd preprocess
python -m pip install -r requirements.txt
python search_asf.py --region mississippi --start 2025-11-01 --end 2026-06-30 --download ./granules
# export GCOV layers to GeoTIFF (e.g. with ASF Harmony subsetting), fill a manifest like manifest.example.json
python nisar_to_atlas.py manifest.json ../data/mississippi.json --sensor nisar
```

Then set `window.SAR = { config: { realDataBase: 'data/' } }` in `index.html` and serve the folder. To replace a showcase region, keep its `id`. The badge switches from "Simulated demo data" to "External data" automatically. Seasonal models need at least 24 months of data.

Keep one relative orbit and one flight direction per stack, so viewing geometry stays constant. Earthdata login is required for downloads.

## Methods

- **Change detection:** log-ratio (dB difference) against a reference date, with a threshold above speckle (default 3 dB).
- **Compare:** gained and lost area beyond a per-metric threshold, net change, and percent change in total inundated area or mean power.
- **Forecasting:** linear trend (OLS), seasonal decomposition (trend plus monthly indices), and additive Holt-Winters (grid-searched alpha, beta, gamma). Bands are approximate 95% prediction intervals. Each model is backtested on a 6-month holdout (RMSE, MAE, share of holdout points inside the band).
- **Scenarios:** the land-change and pumping sliders scale the fitted trend slope. The rainfall slider uses an OLS sensitivity of the detrended target to rainfall and the monthly rainfall climatology. Each is labelled as an assumption.
- **Correlation:** Pearson and Spearman on region means over time, lagged cross-correlation (-12 to +12 months), a spatial scatter across cells, and a per-cell temporal correlation map.
- **Flood classifier:** the Earth Waltz logistic regression (`classifier/`), applied per cell to reference and current HH and HV.

## Test checklist

- [ ] It opens with no console errors. The onboarding shows 4 steps and does not return after Skip.
- [ ] Clicking each region card, or pressing 1, 2 or 3, flies the camera there and loads that region.
- [ ] Search finds "Jakarta". `29.4, -89.8` flies to the delta. `0, 0` flies there and shows "No demo data".
- [ ] Play, pause, step, loop, 0.5x to 4x speed, and dragging the slider all update the globe, date and sparkline.
- [ ] All four Explorer layers render and their legends and units update. HH, HV and VV change the backscatter layer.
- [ ] Each overlay toggles and its legend appears. The overlay opacity slider works.
- [ ] Compare: the swipe handle drags, with mouse or arrow keys. Side by side shows A, B and the difference. The stats card updates when dates change.
- [ ] Clicking a cell fills the Inspect tab with values and two charts.
- [ ] Forecast: switching models, horizon, variable and scope works. The band is visible and the backtest table highlights the best model.
- [ ] Correlate: changing X and Y updates the charts. Static variables show the explanation. "Show on globe" adds the correlation layer.
- [ ] Impact: numbers change with the timeline. Rondonia shows clearing concentrated near roads.
- [ ] Explain: the Simple/Detailed toggle works and glossary tooltips appear on hover and focus.
- [ ] Story plays through 8 steps in about 75 seconds. Pause, Exit and Esc work. Voice narration plays when enabled.
- [ ] Researcher mode: threshold and reference date, band math (an error appears for `foo`), ROI draw and finish with stats, scenario sliders that change the forecast.
- [ ] Exports: CSV, GeoJSON, PNG (with the "Simulated" label), and a recipe that reloads via "Load recipe". The log records each step.
- [ ] Settings: switching basemaps, Reduce motion (flights become instant), and Replay introduction all work.
- [ ] Offline, or with Cesium blocked, the stylized globe appears and every feature still works.
- [ ] Layout holds at 1024 x 768. Panels collapse. Keyboard focus is visible throughout.

## Known limitations

- The data is simulated and its rates are exaggerated. No result here says anything about the real places.
- Each region is one 64 x 64 grid of monthly composites. Real NISAR posting is much finer, and the 12-day revisit gives more time steps.
- The canvas fallback globe has no basemap imagery and ignores camera tilt.
- Forecasts extrapolate statistically and have no physical model. The Holt-Winters band is an approximation.
- Scenario sliders apply simple proportional assumptions, not process models.
- Speckle, layover, shadow, wind on water and urban flooding need care with real data. The thresholds in `preprocess/` are starting points.
- The PNG export depends on CORS-enabled imagery. If tiles are blocked, it captures the overlay only.

## 3-minute demo script

| Time | On screen | Say |
|---|---|---|
| 0:00 | Globe spins in, delta selected | "SAR Atlas makes NISAR radar readable for everyone. Radar sees through clouds and at night. Everything here is simulated, and we say so on every screen." |
| 0:20 | Story, Mississippi (first 3 steps) | "Water is dark to radar because it reflects the pulse away like a mirror. Flooded marsh does the opposite: double bounce makes it bright." |
| 0:45 | Compare swipe, Jan 2024 vs Jun 2026 | "Thirty months apart, the stats card counts the marsh that became open water." |
| 1:05 | Roads overlay, Impact tab | "Most loss sits near canals. The panel shows the share and the baseline, and calls it an association." |
| 1:20 | Rondonia, play the timeline with the vegetation-loss layer | "Clearing spreads from new side roads in the dry season, and the reserve holds." |
| 1:40 | Correlate tab: rain vs new loss, lag plot | "Clearing peaks when the rain stops. This is correlation, and the panel says what proof of causation would need." |
| 2:00 | Jakarta, displacement layer, Forecast tab | "North Jakarta sinks up to 25 cm a year in this simulation. Three models, a backtest and a visible uncertainty band." |
| 2:20 | Researcher mode: Pumping -50%, ROI, export recipe | "Scientists can draw a region, run a scenario and export a recipe that reproduces the result." |
| 2:40 | About page, preprocess table | "To use real data, point preprocess at NISAR GCOV and GUNW from ASF DAAC, with Sentinel-1 as the fallback. The schema and loader stay the same." |
| 2:55 | Back to globe | "Open source, honest about uncertainty, ready for real NISAR data." |

## Credits

NISAR: NASA and ISRO, distributed by the NASA Alaska Satellite Facility DAAC. Sentinel-1: ESA Copernicus. CesiumJS (Apache 2.0). Imagery: Esri World Imagery, CARTO, OpenStreetMap contributors. Fonts: Chakra Petch, IBM Plex Sans, IBM Plex Mono (OFL). The open-water classifier in `classifier/` is from the original Earth Waltz prototype.

License: MIT for the code in this repository.
