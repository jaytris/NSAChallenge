# Earth Waltz

This prototype detects **new open water** from pairs of NASA–ISRO NISAR L-band arrays. A balanced logistic regression uses HH and HV backscatter before and after an event, and the two changes in dB. The browser explorer displays the radar pair, model score, and estimated area for a chosen threshold.

The included model was trained on six simulated scenes, its threshold was selected on two other simulations, and it was evaluated on two held-out simulations. The displayed metrics measure agreement with the simulator's flood masks. Field performance is unknown. The prediction command requires a model trained from a labeled scene manifest.

## Run the demonstration

Open `Earth-Waltz.html` in a browser. It is standalone and works offline.

Use Python 3.11–3.13 with NumPy, SciPy, and scikit-learn to regenerate it. Install Rasterio for the NISAR GeoTIFF path.

```sh
python -m pip install -r requirements.txt
python flood.py demo demo-output
```

## Prepare real training data

Install the geospatial dependency with `python -m pip install rasterio`.

1. Choose flood events from different regions. Reserve entire independent events for validation and testing. A first run needs at least three labeled events, one per split, with both classes represented in each split. More events are needed to assess whether the model transfers across regions.
2. Find NISAR L-band Level 2 GCOV before- and after-event scenes in [ASF Vertex](https://search.asf.alaska.edu/) or [Earthdata Search](https://search.earthdata.nasa.gov/). Match relative orbit, viewing geometry, frequency and polarizations. For each date, export the frequency A HHHH and HVHV layers as single-band GeoTIFFs in linear gamma-0 power. [Harmony](https://nisar-docs.asf.alaska.edu/harmony/) supports extraction and geographic subsetting. Downloads require an Earthdata login. Keep acquisition dates and the original granule identifiers with the data.
3. Align the four raster chips to a shared grid in a meter-based projected CRS, preferably an equal-area projection if precise area estimates matter. Keep the original posting where practical. Crop to the common footprint, mark invalid radar pixels as NoData, and optionally supply a separate valid-mask raster where 1 means usable. Keep chips at or below roughly 4 million pixels for memory. The reported area is planar pixel area times the flagged pixel count.
4. Use independent, date-matched reference flood extents or hand-digitized reference imagery for labels. Rasterize on the same grid. Use 1 for new open water, 0 for confidently unchanged or otherwise non-flooded land and persistent water, and 255 or NoData for unverified areas. Include dry land, persistent water, and other possible look-alikes among the negatives. Group all related chips into a single event and assign them to one split together.
5. Copy `manifest.example.json` and fill in the entries. Paths can be relative to the manifest. Increase the event count before making claims about generalization.

```sh
python flood.py train scenes.json trained
python flood.py predict inference.json trained/model.json results/index.html --geotiff-dir results/rasters
```

Open `results/index.html` for the rendered predictions. Each scene has its center coordinates when geographic input is available. The optional GeoTIFF output stores the model score on the source grid with NoData marked. The inference manifest follows the same format with optional `label` and `split` fields.

Radar shadow, changing agriculture, wind-roughened water, and flooded vegetation can produce confusing signatures. The first classifier targets newly inundated open areas. Inspect per-event IoU, precision, and recall in the model JSON. Scores from the class-weighted model are uncalibrated.
