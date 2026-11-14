"""Convert NISAR (or Sentinel-1) GeoTIFFs into the SAR Atlas JSON schema ("sar-atlas/1").

Input is a small manifest that lists the rasters per date, so no filename parsing is needed:

    python nisar_to_atlas.py manifest.json ../data/mississippi.json

Then, in index.html:  window.SAR = { config: { realDataBase: 'data/' } }  and serve the folder
over http (python -m http.server). SAR.data.loadRegion() will load the file instead of the
synthetic generator.

What the script does
  1. Builds the region grid (bbox + nx x ny, EPSG:4326, row 0 = north).
  2. Reprojects each backscatter GeoTIFF onto that grid with rasterio, averaging in LINEAR power.
  3. Composites all scenes of a calendar month (mean of linear power), then converts to dB.
  4. Derives water extent, vegetation loss and (optionally) cumulative LOS displacement.
  5. Adds optional static layers (population, land use, roads) and rainfall.
  6. Writes JSON with base64 float32 arrays.

Inputs expected (see manifest.example.json)
  - NISAR L2 GCOV: export HHHH, HVHV (and VVVV if present) as single-band GeoTIFFs in linear gamma-0.
  - NISAR L2 GUNW (optional): unwrapped phase GeoTIFF per consecutive pair (radians).
  - Sentinel-1 fallback: GRD/RTC VV and VH in linear gamma-0 (put VH under "HV", VV under "VV").
"""
from __future__ import annotations

import argparse
import base64
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

try:
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Install rasterio first: python -m pip install -r requirements.txt") from exc

NISAR_L_WAVELENGTH_M = 0.2384  # L-band, ~1.257 GHz
S1_C_WAVELENGTH_M = 0.05547    # Sentinel-1 C-band


def grid(region: dict):
    w, s, e, n = region["bbox"]
    nx, ny = region.get("nx", 64), region.get("ny", 64)
    return from_bounds(w, s, e, n, nx, ny), nx, ny


def to_grid(path: Path, transform, nx: int, ny: int, resampling=Resampling.average) -> np.ndarray:
    """Reproject one single-band raster onto the region grid. NoData -> NaN."""
    out = np.full((ny, nx), np.nan, dtype="float32")
    with rasterio.open(path) as src:
        band = src.read(1, masked=True).astype("float32").filled(np.nan)
        reproject(
            source=band, destination=out,
            src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
            dst_transform=transform, dst_crs="EPSG:4326", dst_nodata=np.nan,
            resampling=resampling,
        )
    return out


def db(linear: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(linear > 0, 10 * np.log10(linear), np.nan).astype("float32")


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")


def monthly_backscatter(scenes, transform, nx, ny):
    """Group scenes by YYYY-MM and average linear power per polarization."""
    by_month = defaultdict(lambda: defaultdict(list))
    for sc in scenes:
        month = sc["date"][:7]
        for pol in ("HH", "HV", "VV"):
            if sc.get(pol):
                by_month[month][pol].append(to_grid(Path(sc[pol]), transform, nx, ny))
    months = sorted(by_month)
    stack = {}
    for pol in ("HH", "HV", "VV"):
        layers = []
        for m in months:
            arrs = by_month[m].get(pol)
            layers.append(db(np.nanmean(np.stack(arrs), axis=0)) if arrs else np.full((ny, nx), np.nan, "float32"))
        stack[pol] = np.stack(layers)  # (T, ny, nx) in dB
    return months, stack


def derive_water(hh_db, hv_db, open_hh=-18.0, open_hv=-24.0, flooded_veg_db=3.0):
    """Open water: both channels dark (specular). Flooded vegetation: HH brightens >3 dB vs the dry-season median."""
    water = np.zeros_like(hh_db, dtype="float32")
    open_water = (hh_db < open_hh) & (hv_db < open_hv)
    water[open_water] = 1.0
    hh_ref = np.nanmedian(hh_db, axis=0, keepdims=True)
    flooded_veg = (hh_db - hh_ref > flooded_veg_db) & ~open_water & (np.abs(hv_db - np.nanmedian(hv_db, axis=0, keepdims=True)) < 2)
    water[flooded_veg] = 0.6
    water[np.isnan(hh_db)] = np.nan
    return water


def derive_veg_loss(hv_db, threshold_db=3.0, persist=2):
    """Cumulative loss flag: HV below the first-date value by > threshold for `persist` consecutive steps."""
    drop = (hv_db[0:1] - hv_db) > threshold_db
    T = hv_db.shape[0]
    loss = np.zeros_like(hv_db, dtype="float32")
    run = np.zeros(hv_db.shape[1:], dtype=int)
    lost = np.zeros(hv_db.shape[1:], dtype=bool)
    for t in range(T):
        run = np.where(drop[t], run + 1, 0)
        lost |= run >= persist
        loss[t] = lost
    return loss


def derive_displacement(pairs, months, transform, nx, ny, wavelength):
    """Stack consecutive unwrapped interferograms into cumulative LOS displacement (cm), referenced to the first month.

    LOS displacement d = -phase * wavelength / (4 pi). Sign convention: negative = away from the satellite (e.g. subsidence).
    Each pair: {"ref": "YYYY-MM-DD", "sec": "YYYY-MM-DD", "unw": "path.tif"}. Pairs should chain through time.
    """
    T = len(months)
    inc = np.zeros((T, ny, nx), dtype="float32")
    for p in sorted(pairs, key=lambda q: q["sec"]):
        t = months.index(p["sec"][:7]) if p["sec"][:7] in months else None
        if t is None:
            continue
        phase = to_grid(Path(p["unw"]), transform, nx, ny, Resampling.bilinear)
        inc[t] += -phase * wavelength / (4 * math.pi) * 100.0
    return np.nancumsum(inc, axis=0).astype("float32")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--sensor", choices=["nisar", "sentinel1"], default="nisar")
    ap.add_argument("--veg-threshold", type=float, default=3.0)
    args = ap.parse_args()

    man = json.loads(args.manifest.read_text())
    base = args.manifest.parent
    for sc in man["scenes"]:
        for k in ("HH", "HV", "VV"):
            if sc.get(k):
                sc[k] = str((base / sc[k]).resolve())
    region = man["region"]
    transform, nx, ny = grid(region)

    months, bs = monthly_backscatter(man["scenes"], transform, nx, ny)
    T = len(months)
    if T < 3:
        raise SystemExit("Need at least 3 months of data for change and forecasting.")
    hh = bs["HH"] if not np.all(np.isnan(bs["HH"])) else bs["VV"]  # Sentinel-1 has no HH: VV stands in
    water = derive_water(hh, bs["HV"])
    veg = derive_veg_loss(bs["HV"], args.veg_threshold)
    wl = NISAR_L_WAVELENGTH_M if args.sensor == "nisar" else S1_C_WAVELENGTH_M
    disp = derive_displacement(man.get("interferograms", []), months, transform, nx, ny, wl) if man.get("interferograms") else np.zeros((T, ny, nx), "float32")

    static = {}
    for key, path in (man.get("static") or {}).items():
        res = Resampling.mode if key == "landuse" else Resampling.average
        static[key] = b64(to_grid((base / path).resolve(), transform, nx, ny, res))

    rain = man.get("rain_mm")  # optional list, one value per month (e.g. from GPM IMERG)
    doc = {
        "schema": "sar-atlas/1",
        "simulated": False,
        "source": f"{args.sensor.upper()} via preprocess/nisar_to_atlas.py; granules: {len(man['scenes'])}",
        "region": {**region, "nx": nx, "ny": ny},
        "times": [m + "-01" for m in months],
        "variables": {
            "HH": b64(bs["HH"]), "HV": b64(bs["HV"]), "VV": b64(bs["VV"]),
            "water": b64(water), "veg": b64(veg), "disp": b64(disp),
        },
        "static": static,
        "series": {"rain": b64(np.asarray(rain, "float32"))} if rain else {},
        "granules": [sc.get("granule") for sc in man["scenes"] if sc.get("granule")],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(doc))
    print(f"wrote {args.output}: {T} months, {nx}x{ny} cells, {args.output.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
