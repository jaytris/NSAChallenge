/* SAR Atlas - content.js
 * Words: glossary, plain-English explanations, guided stories, onboarding, about page.
 * Terms wrapped in <span class="term" data-term="..."> get glossary tooltips.
 */
(function () {
  'use strict';
  const SAR = (window.SAR = window.SAR || {});
  const K = (SAR.content = {});
  const term = (key, text) => `<span class="term" data-term="${key}" tabindex="0">${text || key}</span>`;
  K.term = term;

  K.GLOSSARY = {
    'SAR': 'Synthetic Aperture Radar. A satellite sends microwave pulses and records the echoes. It builds a sharp image by combining echoes along its orbit.',
    'NISAR': 'NASA-ISRO SAR mission, launched 2025. It carries an L-band (24 cm) and an S-band (9 cm) radar and images nearly all land and ice about every 12 days.',
    'L-band': 'A radar wavelength of about 24 cm. It passes through leaves and small branches, so it senses trunks, soil and water under the canopy.',
    'backscatter': 'The share of the radar pulse that bounces back to the satellite. Rough or structured surfaces return more. It is shown in decibels (dB).',
    'dB': 'Decibels, a log scale. Every 3 dB is roughly a doubling of returned power. Radar values are usually negative, for example -25 dB for calm water.',
    'polarization': 'The orientation of the radar wave. HH sends and receives horizontally, VV vertically, HV sends horizontal and receives vertical.',
    'HH': 'Horizontal send, horizontal receive. Sensitive to double-bounce from buildings, trunks standing in water and rough ground.',
    'HV': 'Cross-polarized: horizontal send, vertical receive. Mostly produced by volume scattering in leaves and branches, so it tracks vegetation amount.',
    'VV': 'Vertical send, vertical receive. Sensitive to surface roughness and soil moisture. Wind on water also raises it.',
    'roughness': 'Surface texture at the scale of the wavelength. Smooth surfaces mirror the pulse away (dark); rough ones scatter it back (bright).',
    'dielectric constant': 'How strongly a material responds to an electric field. Water has a very high value, so wet soil reflects more strongly than dry soil.',
    'specular reflection': 'Mirror-like reflection. Calm water sends the pulse away from the satellite, which is why water looks dark in radar images.',
    'double-bounce': 'The pulse hits water or ground, bounces off a vertical object (a trunk, a wall) and returns. It makes flooded forest and cities very bright in HH.',
    'volume scattering': 'Many small bounces inside a canopy of leaves and branches. It produces the HV signal that drops when forest is cleared.',
    'InSAR': 'Interferometric SAR. Comparing the phase of two radar images taken from the same orbit measures ground motion to millimetre or centimetre precision.',
    'LOS': 'Line of sight. InSAR measures motion along the slanted path to the satellite, not purely vertical. Here vertical subsidence is scaled by about 0.8.',
    'speckle': 'Grainy noise in every radar image, caused by interference between many scatterers in a pixel. Averaging pixels (multilooking) reduces it.',
    'GCOV': 'NISAR Level-2 Geocoded Polarimetric Covariance product: calibrated backscatter (HH, HV, ...) on a map grid.',
    'GUNW': 'NISAR Level-2 Geocoded Unwrapped Interferogram: ground motion between two dates, used for displacement.',
    'revisit': 'Time between repeat images of the same place from the same orbit. NISAR repeats every 12 days; this demo uses monthly composites.',
    'subsidence': 'Gradual sinking of the ground, often from pumping groundwater, draining peat or the compaction of young sediments.',
    'gamma-0': 'Backscatter normalized for terrain-illuminated area. It is the standard calibrated brightness value in GCOV products.',
    'Pearson': 'Pearson correlation measures how well a straight line relates two variables, from -1 to +1.',
    'Spearman': 'Spearman correlation uses ranks instead of raw values, so it captures any steadily increasing or decreasing relationship and resists outliers.',
    'RMSE': 'Root mean square error: the typical size of forecast misses, in the same units as the data. Lower is better.'
  };

  K.REGION_INFO = {
    mississippi: {
      blurb: 'The delta has lost about 5,000 km2 of land since the 1930s. Levees starve the marsh of sediment, canals cut it open, and the ground sinks.',
      drivers: [
        ['Sediment starvation', 'Levees keep the river from spilling and rebuilding marsh. Without new sediment, sinking marsh drowns.'],
        ['Subsidence', 'Young delta sediments compact under their own weight. Land that sinks a centimetre a year loses its fight with the sea.'],
        ['Canals and oil and gas access channels', 'Dredged canals let salt water in and change drainage. In this simulation, losses cluster close to them.'],
        ['Storms', 'Hurricane surge rips up weakened marsh in one event. The simulated August 2025 storm shows a step change.']
      ]
    },
    rondonia: {
      blurb: 'Rondonia became one of the most deforested Brazilian states after highway BR-364 opened. Side roads grow out from the highway in a "fishbone" pattern.',
      drivers: [
        ['Road access', 'Clearing spreads outward from roads, because roads make it cheap to reach land and move cattle, timber and crops.'],
        ['Dry-season clearing and fire', 'Forest is cut and burned when it is dry (June to October). The simulation clears faster in those months.'],
        ['Cattle and soy economics', 'Beef and soy prices change how much it pays to clear. Those prices are not modelled here.'],
        ['Protected areas', 'The simulated reserve stays forested even where roads approach it. Real reserve boundaries often show the same pattern.']
      ]
    },
    jakarta: {
      blurb: 'Parts of North Jakarta have sunk several metres in recent decades, at up to about 25 cm per year in places. Indonesia is moving its capital partly because of this.',
      drivers: [
        ['Groundwater extraction', 'Homes and industry pump aquifers faster than they refill. The clay layers compact and the surface sinks.'],
        ['Building load', 'Heavy development on soft coastal sediment adds compaction, especially near the port and industrial zones.'],
        ['Monsoon rain and tides', 'The land does not sink because of rain, but as it sinks, the same rainfall and tides flood more of it.'],
        ['Urban growth', 'New suburbs in the south replace green land. That raises demand for water, which feeds back into pumping.']
      ]
    }
  };

  K.LIMITATIONS = [
    ['Simulated demo data', 'Every number in this demo comes from a seeded generator built to mimic real radar physics. Rates of change are exaggerated so they are easy to see.'],
    ['Viewing geometry', 'Radar looks sideways. Steep slopes facing away from the satellite fall into shadow; slopes facing it are squeezed (layover and foreshortening).'],
    ['Speckle', 'Every radar image is grainy. Single pixels can change by 1 to 2 dB with no real change on the ground. Thresholds must sit above that noise.'],
    ['Coverage gaps and revisit', 'NISAR repeats every 12 days, and acquisition plans and data gaps vary. Fast events between passes (a flood that drains in two days) can be missed.'],
    ['Look-alikes', 'Wind-roughened water looks like land; smooth tarmac and dry sand look like water; flooded vegetation looks brighter, not darker.'],
    ['Line-of-sight motion', 'InSAR measures motion toward or away from the satellite. Separating vertical from horizontal motion needs both ascending and descending passes.'],
    ['Models', 'Forecasts are statistical extrapolations of the past 30 months. They know nothing about future policy, prices or extreme weather.']
  ];

  const pol = (p) => term(p);
  /** What radar physically sees for each layer. */
  function radarPhysics(layer, simple) {
    const s = {
      backscatter: simple
        ? `Bright pixels sent a lot of the radar pulse back; dark pixels sent little. Calm water acts like a mirror and looks black. Cities and flooded forest look very bright because the pulse bounces twice.`
        : `${term('backscatter', 'Backscatter')} (${term('gamma-0')}, ${term('dB')}) depends on ${term('roughness')}, geometry and the ${term('dielectric constant')}. Calm water causes ${term('specular reflection')} (about -20 to -25 dB). ${term('HV')} rises with ${term('volume scattering')} in canopies; ${term('HH')} rises with ${term('double-bounce')} off trunks and walls standing in water.`,
      water: simple
        ? `Open water is dark in radar because it reflects the pulse away like a mirror. Water under trees or reeds does the opposite: the pulse bounces off the water and then the stems, so it looks brighter.`
        : `Open water is mapped where HH and HV fall below about -18 and -24 dB (${term('specular reflection')}). Inundated vegetation is flagged from an HH increase of several dB (${term('double-bounce')}) with stable HV. Each cell shows the inundated fraction.`,
      vegloss: simple
        ? `Leaves and branches scramble the radar wave and send part of it back with a twisted orientation (the HV channel). When forest is cut, that twisted echo drops sharply. Orange shows where it dropped.`
        : `${term('HV')} is dominated by ${term('volume scattering')} in the canopy. Clearing removes that volume, so HV drops by about 5 to 8 dB at ${term('L-band')}. Cells are flagged where HV(t) - HV(ref) falls below the threshold; colour shows the size of the drop.`,
      disp: simple
        ? `Radar can measure the ground moving by comparing the timing of its waves between visits, down to a few millimetres. Orange areas are sinking, purple ones rising, compared with the reference date.`
        : `${term('InSAR')} converts the phase difference between acquisitions into ${term('LOS')} displacement (NISAR L-band: 2 pi of phase is about 12 cm). The layer shows cumulative LOS change since the reference date; values are stacked from ${term('GUNW')}-like pairs.`,
      change: `Log-ratio change detection: the selected polarization at the current date minus the reference date, in dB. Only cells beyond +/- the threshold are shown, to stay above ${term('speckle')}.`,
      classifier: `The Earth Waltz logistic regression scores each cell from reference and current HH and HV and their dB differences. It was trained on simulated scenes (test IoU 0.95 against simulator masks); real-world accuracy is unknown.`,
      bandmath: `Your own expression, evaluated per cell. Ratios such as HV - HH (in dB) separate volume scattering (vegetation) from surface and double-bounce scattering.`,
      corrmap: `Each cell shows the Pearson correlation between two variables over the 30 monthly steps at that location. It reveals where variables move together, not why.`
    };
    return s[layer] || s.backscatter;
  }

  /** Main "Explain this" builder. c = {ds, st, numbers:{...}, level} */
  K.explain = function (c) {
    const simple = c.level === 'simple', ds = c.ds, st = c.st, info = K.REGION_INFO[ds.id] || { blurb: '', drivers: [] }, n = c.numbers;
    const date = ds.times[st.t].slice(0, 7), ref = ds.times[st.refT].slice(0, 7);
    let changed = '';
    if (ds.id === 'mississippi') changed = simple
      ? `Between ${ref} and ${date}, about <b>${n.marshLost.toFixed(0)} km2</b> of marsh turned into open water in this simulation, and seasonal flooding covered up to <b>${n.maxFlood.toFixed(0)} km2</b>.`
      : `Marsh-to-open-water conversion since ${ref}: <b>${n.marshLost.toFixed(0)} km2</b> (${n.marshLostPct.toFixed(1)}% of marsh). Peak inundated area in record: <b>${n.maxFlood.toFixed(0)} km2</b>. Mean LOS displacement of land: <b>${n.meanDisp.toFixed(2)} cm</b>.`;
    else if (ds.id === 'rondonia') changed = simple
      ? `Between ${ref} and ${date}, about <b>${n.cleared.toFixed(0)} km2</b> of forest was cleared in this simulation, mostly in dry months.`
      : `New clearing since ${ref}: <b>${n.cleared.toFixed(0)} km2</b> (${n.clearedPct.toFixed(1)}% of remaining forest). ${n.dryShare.toFixed(0)}% of clearing happened in June to October. Mean HV drop where cleared: <b>${n.hvDrop.toFixed(1)} dB</b>.`;
    else if (ds.id !== 'jakarta') changed = `Between ${ref} and ${date}: mean LOS displacement of land <b>${(n.meanDisp || 0).toFixed(2)} cm</b>. Use the Compare and Impact panels for area statistics.`;
    else changed = simple
      ? `Between ${ref} and ${date}, parts of North Jakarta sank by up to <b>${Math.abs(n.maxSink).toFixed(0)} cm</b> along the radar line of sight in this simulation.`
      : `Maximum LOS subsidence since ${ref}: <b>${Math.abs(n.maxSink).toFixed(1)} cm</b>; land area sinking faster than 5 cm/yr (vertical): <b>${n.fastKm2.toFixed(0)} km2</b>. Mean LOS change of land: <b>${n.meanDisp.toFixed(2)} cm</b>.`;

    const drivers = info.drivers.map(([h, t]) => `<li><b>${h}.</b> ${t}</li>`).join('');
    const why = simple
      ? `Radar brings its own light (microwaves), so it works at night. Its 24 cm waves pass through clouds, smoke and rain. In the tropics and during storms that is the only way to see the ground on schedule.`
      : `${term('SAR')} is an active sensor: it supplies its own illumination, so it is independent of daylight. Microwaves at ${term('L-band')} pass through cloud and most rain with little attenuation, giving a dependable ${term('revisit')} where optical sensors are blocked for months.`;
    return `
      <div class="ex-block"><div class="ex-h">On screen</div>
        <p><b>${ds.name}</b> - ${(SAR.render.LAYERS[st.layer] || {}).label}${st.layer === 'backscatter' ? ' (' + pol(st.pol) + ')' : ''}, ${date}. ${info.blurb}</p></div>
      <div class="ex-block"><div class="ex-h">What radar sees</div><p>${radarPhysics(st.layer, simple)}</p></div>
      <div class="ex-block"><div class="ex-h">What changed</div><p>${changed}</p></div>
      <div class="ex-block"><div class="ex-h">Possible physical drivers <span class="tag">hypotheses</span></div><ul class="ex-list">${drivers}</ul>
        <p class="dim small">These are explanations that could produce the pattern. They need field data, other datasets and models to test them.</p></div>
      <div class="ex-block"><div class="ex-h">Why radar</div><p>${why}</p></div>`;
  };

  K.CAUSATION_NOTE = `To argue causation you would need: <b>temporal order</b> (the cause changes first; the lag plot helps), a <b>physical mechanism</b> (for example groundwater pumping compacting clay), <b>control of confounders</b> (a third factor such as distance to coast driving both variables), and ideally a <b>natural experiment</b> or independent evidence (wells, field surveys, permits).`;

  /* Guided stories (~75 s each). cam: 'region' or {lon, lat, height(m), heading, pitch}. play: [from, to] animates time. */
  K.STORIES = {
    mississippi: [
      { d: 9, cam: { lon: -89.8, lat: 27.2, height: 1400000, pitch: -62 }, t: 0, layer: 'water', cap: 'The Mississippi River Delta, Louisiana. Every year the Gulf of Mexico takes more of it. Radar lets us watch, day and night, through cloud.' },
      { d: 10, cam: 'region', t: 0, layer: 'backscatter', pol: 'HH', cap: 'This is L-band radar brightness. Open water mirrors the pulse away and looks black. Marsh scatters some energy back. Towns on the levees glow.' },
      { d: 10, cam: 'region', layer: 'water', play: [0, 6], cap: 'Spring flood. Water spreads under the marsh grass. Here radar gets brighter, not darker: the pulse bounces off water, then off stems. That is double-bounce.' },
      { d: 9, cam: { lon: -89.8, lat: 28.9, height: 210000, pitch: -55 }, t: 19, layer: 'water', cap: 'August 2025, a simulated hurricane. The surge floods the delta under thick storm cloud. Optical satellites see only cloud tops; radar sees the water.' },
      { d: 10, cam: 'region', layer: 'water', compare: { a: 0, b: 29 }, cap: 'Before and after, 30 months apart. Drag the line. Marsh that turned into permanent open water does not come back when the flood drains.' },
      { d: 10, cam: 'region', t: 29, layer: 'vegloss', ov: { roads: true }, tab: 'impact', cap: 'Overlay the canals and levee roads. In this simulation, most marsh loss sits within a few kilometres of dredged canals. That is a pattern, not proof.' },
      { d: 9, cam: 'region', t: 29, layer: 'water', tab: 'forecast', cap: 'A Holt-Winters model extends the record 12 months, with an uncertainty band. It is a statistical extrapolation, not a physical prediction.' },
      { d: 9, cam: { lon: -89.8, lat: 27.4, height: 900000, pitch: -70 }, t: 29, layer: 'water', tab: 'explain', cap: 'Radar shows what changed. Subsidence, sediment starvation, canals and storms are hypotheses to test with field data. All data here is simulated.' }
    ],
    rondonia: [
      { d: 9, cam: { lon: -63.0, lat: -12.8, height: 1500000, pitch: -60 }, t: 0, layer: 'backscatter', pol: 'HV', cap: 'Rondonia, Brazil. Highway BR-364 cuts through the Amazon. For half the year this forest sits under cloud. Radar does not care.' },
      { d: 10, cam: 'region', t: 0, layer: 'backscatter', pol: 'HV', cap: 'Cross-polarized HV radar. Bright means leaves and branches scattering the wave. Dark strips are pasture, already cleared along the roads.' },
      { d: 10, cam: 'region', layer: 'vegloss', play: [0, 29], ov: { roads: true }, cap: 'Watch 30 months. New side roads open and clearing spreads out from them, fastest in the dry season, June to October. This is the fishbone pattern.' },
      { d: 9, cam: { lon: -62.65, lat: -9.9, height: 120000, pitch: -50 }, t: 29, layer: 'vegloss', ov: { roads: true, landuse: true }, cap: 'The protected reserve in the north-east stays intact even where roads reach its edge. Land use rules leave a visible line in the radar data.' },
      { d: 10, cam: 'region', layer: 'backscatter', pol: 'HV', compare: { a: 0, b: 29 }, cap: 'Before and after. A drop of 6 to 8 dB in HV means the canopy is gone. Through clouds, at night, every 12 days with NISAR.' },
      { d: 9, cam: 'region', t: 29, layer: 'vegloss', ov: { roads: true }, tab: 'impact', cap: 'In this simulation, nearly all new clearing lies within 5 km of a road, against a much smaller share of the landscape. Roads open the forest.' },
      { d: 9, cam: 'region', t: 29, layer: 'vegloss', tab: 'correlate', corr: { x: 'rain', y: 'vegNew' }, cap: 'New clearing peaks in the driest months, so it is negatively correlated with rainfall. Correlation shows timing, not cause.' },
      { d: 9, cam: 'region', t: 29, layer: 'vegloss', tab: 'forecast', cap: 'The forecast extends the clearing trend with an uncertainty band. In Researcher mode you can change the clearing rate and re-run it.' }
    ],
    jakarta: [
      { d: 9, cam: { lon: 106.84, lat: -7.6, height: 900000, pitch: -55 }, t: 0, layer: 'backscatter', pol: 'HH', cap: 'Jakarta, Indonesia. Ten million people on soft coastal ground, and parts of the city are sinking faster than almost anywhere on Earth.' },
      { d: 10, cam: 'region', t: 0, layer: 'backscatter', pol: 'HH', cap: 'Buildings act as corner reflectors, so the city shines in HH radar. The bay is dark. The rice fields and parks to the south sit in between.' },
      { d: 11, cam: { lon: 106.82, lat: -6.32, height: 60000, pitch: -45 }, layer: 'disp', play: [0, 29], cap: 'Interferometry measures how far the ground moved between passes. Over 30 months, orange bowls deepen in the north, near the port and industry.' },
      { d: 9, cam: 'region', t: 29, layer: 'disp', ov: { landuse: true }, tab: 'impact', cap: 'Overlay land use. The fastest sinking matches industrial and dense areas near the coast, where groundwater pumping is heaviest.' },
      { d: 10, cam: 'region', layer: 'water', compare: { a: 0, b: 24 }, cap: 'Compare two January monsoons. As the ground drops, the same rain and tides flood more streets. Subsidence turns weather into floods.' },
      { d: 9, cam: 'region', t: 29, layer: 'disp', tab: 'correlate', corr: { x: 'pop', y: 'disp' }, cap: 'Population density and sinking are correlated across the city. But distance to the coast drives both. That is a confounder.' },
      { d: 9, cam: 'region', t: 29, layer: 'disp', tab: 'forecast', cap: 'The forecast extends the sinking. In Researcher mode, cutting groundwater pumping slows it in the scenario. That is an assumption, not a law of physics.' },
      { d: 9, cam: { lon: 106.84, lat: -7.4, height: 700000, pitch: -65 }, t: 29, layer: 'disp', tab: 'explain', cap: 'NISAR will measure this every 12 days, for the whole planet. This demo is simulated; the pipeline to real data is in the README.' }
    ]
  };

  K.ONBOARD = [
    { sel: '#regionList', title: 'Pick a place', text: 'Start with one of three showcase regions, or search any coordinate. The globe flies there and loads 30 months of radar data.' },
    { sel: '#dock', title: 'Scrub through time', text: 'Play, pause and drag the timeline. The change layer animates monthly. Keyboard: Space plays, arrow keys step.' },
    { sel: '#layerSection', title: 'Choose what radar measures', text: 'Switch between water, vegetation loss and ground motion, pick a polarization, add human-activity overlays, or compare two dates.' },
    { sel: '#rightPanel', title: 'Understand it', text: 'Click any cell to inspect it. Forecast, correlate and read a plain-English explanation. Researchers can switch modes at the top right.' }
  ];

  K.ABOUT = `
  <h3>What this is</h3>
  <p>SAR Atlas is an open-source explorer for surface change seen by radar. It is built for the NASA Space Apps Challenge 2026, "Dancing with the SARs". The goal is that anyone can see what NISAR measures and that scientists can check how each number was made.</p>
  <div class="callout"><b>All data shown is simulated.</b> A seeded generator (js/data.js) produces monthly HH, HV and VV backscatter, water extent, vegetation loss and InSAR-style displacement that follow real scattering physics. No value in this demo is a real observation.</div>
  <h3>The real-data path</h3>
  <ol>
    <li>Search and download NISAR Level-2 products from the <a href="https://search.asf.alaska.edu/" target="_blank" rel="noopener">NASA ASF DAAC</a> (Vertex or <code>asf_search</code>): GCOV for backscatter, GUNW for displacement. Earthdata login required.</li>
    <li>Run <code>preprocess/nisar_to_atlas.py</code>. It reprojects each GeoTIFF to the region grid with rasterio, converts linear gamma-0 to dB, derives water, vegetation loss and cumulative LOS displacement with numpy/xarray, and writes <code>data/&lt;region&gt;.json</code> in the same schema the app uses.</li>
    <li>Set <code>SAR.config.realDataBase = 'data/'</code> in index.html (or inline the JSON as <code>window.SAR_REAL_DATA</code>). The single loader, <code>SAR.data.loadRegion()</code>, picks it up; nothing else changes.</li>
    <li>Until NISAR coverage of an area is available, Sentinel-1 GRD (C-band, VV and VH) and Sentinel-1 interferograms from ASF fill the same schema. C-band penetrates canopies less than L-band.</li>
  </ol>
  <h3>Methods</h3>
  <ul>
    <li><b>Water:</b> low HH and HV backscatter (specular reflection); flooded vegetation from HH double-bounce increase.</li>
    <li><b>Vegetation loss:</b> HV drop beyond a dB threshold between a reference and the current date.</li>
    <li><b>Displacement:</b> cumulative line-of-sight change (cm) relative to the reference date.</li>
    <li><b>Flood classifier:</b> the Earth Waltz logistic regression (classifier/flood.py) on pre/post HH and HV.</li>
    <li><b>Forecasts:</b> linear trend, seasonal decomposition and additive Holt-Winters, with 95% prediction bands and a 6-month holdout backtest.</li>
    <li><b>Correlation:</b> Pearson, Spearman, lagged cross-correlation and per-cell temporal correlation maps.</li>
  </ul>
  <h3>Credits and sources</h3>
  <ul>
    <li>NISAR mission: NASA and ISRO. Data distribution: NASA Alaska Satellite Facility DAAC.</li>
    <li>Sentinel-1: European Space Agency, Copernicus programme.</li>
    <li>Globe: CesiumJS (Apache 2.0). Base imagery: Esri World Imagery, CARTO, OpenStreetMap contributors.</li>
    <li>Fonts: Chakra Petch, IBM Plex Sans, IBM Plex Mono (SIL Open Font License).</li>
  </ul>
  <h3>Keyboard</h3>
  <table class="kbd-table"><tr><td><kbd>Space</kbd></td><td>Play / pause</td></tr><tr><td><kbd>Left</kbd> <kbd>Right</kbd></td><td>Step one month</td></tr><tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></td><td>Fly to region</td></tr><tr><td><kbd>C</kbd></td><td>Toggle compare</td></tr><tr><td><kbd>E</kbd></td><td>Explain panel</td></tr><tr><td><kbd>R</kbd></td><td>Toggle Researcher mode</td></tr><tr><td><kbd>Esc</kbd></td><td>Close dialogs, stop story</td></tr></table>`;
})();
