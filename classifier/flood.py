"""Train and run an open-water change classifier for paired radar scenes."""
import argparse
import base64
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np
from scipy.special import expit
from sklearn.linear_model import LogisticRegression

FEATURES = ("pre_hh_db", "pre_hv_db", "post_hh_db", "post_hv_db",
            "delta_hh_db", "delta_hv_db")
MAX_CHIP_PIXELS = 2048 ** 2


@dataclass
class Scene:
    id: str
    event: str
    title: str
    split: str
    before_date: str
    after_date: str
    radar: np.ndarray
    label: np.ndarray | None
    pixel_km2: float
    center: list | None = None
    profile: dict | None = None


def db(power):
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(power > 0, 10 * np.log10(power), np.nan)


def features(radar):
    pre_hh, pre_hv, post_hh, post_hv = radar
    return np.stack((pre_hh, pre_hv, post_hh, post_hv,
                     post_hh - pre_hh, post_hv - pre_hv), axis=-1)


def synthetic_scenes():
    """Simulated backscatter with persistent water, look-alikes, and missing coverage."""
    rng = np.random.default_rng(26)
    y, x = np.mgrid[-1:1:160j, -1:1:230j]
    scenes = []
    for i in range(10):
        centerline = .40 * np.sin(3 * x + i) + .12 * np.sin(7 * x - i)
        distance = np.abs(y - centerline)
        river = distance < .066 + .012 * np.cos(6 * x)
        lake = ((x + .66) / .17) ** 2 + ((y - .68) / .13) ** 2 < 1
        water = river | lake
        extent = .09 + .20 * np.exp(-((x - .10 * np.sin(i)) / .50) ** 2)
        flood = (distance < extent * (1 + .23 * np.sin(12 * x + 4 * y))) & ~water
        crop = (np.sin(15 * x + 2 * y) > .59) & (y < centerline - .26)
        shadow = ((x - .62) / .25) ** 2 + ((y + .54) / .15) ** 2 < 1
        relief = 2.6 * np.sin(10 * x + 3 * y) * np.cos(7 * y) + rng.normal(0, 1, x.shape)
        hh = -10 + relief - 5 * crop - 9 * shadow + rng.uniform(-1.5, 1.5)
        hv = hh - 6 + .8 * np.sin(4 * y + 2 * x)
        pre_hh = np.where(water, -23 + relief * .25, hh)
        pre_hv = np.where(water, -31 + relief * .2, hv)
        post_hh = np.where(flood, -22 + relief * .35 + rng.uniform(-2, 2), pre_hh - 4 * crop)
        post_hv = np.where(flood, -30 + relief * .35 + rng.uniform(-2, 2), pre_hv - 2 * crop)
        radar = (np.stack((pre_hh, pre_hv, post_hh, post_hv))
                 + rng.normal(0, 1.9, size=(4, *x.shape))).astype("float32")
        radar[:, (x + .45 * y < -.98) | ((x > .86) & (y > .91))] = np.nan
        split = "train" if i < 6 else "validation" if i < 8 else "test"
        titles = {8: "Meandering river", 9: "Lowland floodplain"}
        scenes.append(Scene(f"simulation-{i + 1:02d}", f"simulation-{i + 1:02d}",
                            titles.get(i, f"Simulation {i + 1:02d}"), split,
                            "2026-10-23", "2026-11-04", radar, flood, .0004))
    return scenes


def load_manifest(path, labels_required):
    import rasterio
    from rasterio.warp import transform

    entries = json.loads(path.read_text())
    if not isinstance(entries, list) or not entries:
        raise ValueError("Manifest must be a nonempty list of scenes.")
    scenes, ids = [], set()
    for row in entries:
        scene_id = row["id"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", scene_id) or scene_id in ids:
            raise ValueError(f"Invalid or duplicate scene ID: {scene_id}")
        ids.add(scene_id)
        if date.fromisoformat(row["before_date"]) >= date.fromisoformat(row["after_date"]):
            raise ValueError(f"{scene_id}: acquisition dates must be chronological.")
        # Require pre-aligned rasters to make subpixel alignment an explicit input choice.
        def read(key, grid=None):
            with rasterio.open(path.parent / row[key]) as src:
                if src.count != 1 or src.width * src.height > MAX_CHIP_PIXELS:
                    raise ValueError(f"{scene_id}/{key}: expected a single-band chip of at most 4,194,304 pixels.")
                if (not src.crs or not src.crs.is_projected
                        or src.crs.linear_units_factor[1] != 1.0):
                    raise ValueError(f"{scene_id}/{key}: use a projected CRS in meters.")
                current_grid = (src.crs, src.transform, src.width, src.height)
                if grid is not None and grid != current_grid:
                    raise ValueError(f"{scene_id}/{key}: all rasters must share the same grid.")
                values = src.read(1, masked=True).astype("float32").filled(np.nan)
                return values, current_grid, src.profile.copy()

        pre_hh, grid, profile = read("before_hh")
        arrays = [pre_hh] + [read(key, grid)[0] for key in ("before_hv", "after_hh", "after_hv")]
        radar = db(np.stack(arrays))
        if "valid_mask" in row:
            valid = read("valid_mask", grid)[0]
            radar[:, valid != 1] = np.nan
        if not np.isfinite(radar).all(axis=0).any():
            raise ValueError(f"{scene_id}: no overlapping valid radar pixels.")
        label = None
        if "label" in row:
            label = read("label", grid)[0]
            if not np.isin(label[np.isfinite(label)], [0, 1, 255]).all():
                raise ValueError(f"{scene_id}: labels must be 0, 1 or 255 (ignore).")
        elif labels_required:
            raise ValueError(f"{scene_id}: training requires a reference label.")
        crs, affine, width, height = grid
        cx, cy = affine * (width / 2, height / 2)
        lon, lat = transform(crs, "EPSG:4326", [cx], [cy])
        scenes.append(Scene(scene_id, row["event"], row.get("title", scene_id),
                            row.get("split", "inference"), row["before_date"], row["after_date"],
                            radar, label, abs(affine.determinant) / 1e6, [lat[0], lon[0]], profile))
    return scenes


def sample(scene, limit=None, rng=None):
    x = features(scene.radar).reshape(-1, len(FEATURES))
    y = scene.label.ravel()
    ids = np.flatnonzero(np.isfinite(x).all(axis=1) & np.isin(y, [0, 1]))
    if limit and len(ids) > limit:
        ids = rng.choice(ids, size=limit, replace=False)
    return x[ids], y[ids].astype("uint8")


def coefficients(model, x):
    return expit(x @ model["weights"] + model["intercept"])


def metrics(y, positive):
    y = y.astype(bool)
    tp = np.count_nonzero(y & positive)
    fp = np.count_nonzero(~y & positive)
    fn = np.count_nonzero(y & ~positive)
    return {"precision": tp / (tp + fp) if tp + fp else 0,
            "recall": tp / (tp + fn) if tp + fn else 0,
            "iou": tp / (tp + fp + fn) if tp + fp + fn else 0,
            "tp": int(tp), "fp": int(fp), "fn": int(fn), "pixels": len(y)}


def train(scenes, synthetic):
    splits = {k: [] for k in ("train", "validation", "test")}
    event_splits = {}
    for scene in scenes:
        if scene.split not in splits or not scene.event:
            raise ValueError(f"{scene.id}: provide an event and a train, validation or test split.")
        if event_splits.setdefault(scene.event, scene.split) != scene.split:
            raise ValueError(f"Event {scene.event} appears in multiple splits.")
        splits[scene.split].append(scene)
    rng = np.random.default_rng(42)
    examples = {}
    for name, group in splits.items():
        if not group:
            raise ValueError(f"Missing {name} events.")
        x, y = zip(*(sample(scene, 25000 if name == "train" else None, rng)
                     for scene in group))
        x, y = np.concatenate(x), np.concatenate(y)
        if len(np.unique(y)) != 2:
            raise ValueError(f"The {name} split needs labeled flooded and non-flooded pixels.")
        examples[name] = x, y
    x, y = examples["train"]
    mean, scale = x.mean(axis=0), np.maximum(x.std(axis=0), 1e-6)
    classifier = LogisticRegression(max_iter=300, class_weight="balanced")
    classifier.fit((x - mean) / scale, y)
    weights = classifier.coef_[0] / scale
    model = {"format": 1, "synthetic": synthetic, "features": list(FEATURES),
             "weights": weights.tolist(), "intercept": float(classifier.intercept_[0] - mean @ weights)}
    x, y = examples["validation"]
    scores = coefficients(model, x)
    threshold = max(np.arange(.05, 1, .05),
                    key=lambda t: metrics(y, scores >= t)["iou"])
    model["threshold"] = float(round(threshold, 2))
    x, y = examples["test"]
    test = metrics(y, coefficients(model, x) >= model["threshold"])
    by_event = {}
    for event in sorted({scene.event for scene in splits["test"]}):
        event_samples = [sample(scene) for scene in splits["test"] if scene.event == event]
        event_x, event_y = map(np.concatenate, zip(*event_samples))
        by_event[event] = metrics(event_y, coefficients(model, event_x) >= model["threshold"])
    model["evaluation"] = {"events": dict(Counter(event_splits.values())),
                           "test": test, "test_by_event": by_event}
    return model


def render(scenes, model, destination, geotiff_dir=None):
    template = Path(__file__).with_name("explorer.template.html").read_text()
    entries = []
    if geotiff_dir:
        import rasterio

        geotiff_dir.mkdir(parents=True, exist_ok=True)
    for scene in scenes:
        x = features(scene.radar)
        valid = np.isfinite(x).all(axis=-1)
        score = np.full(valid.shape, np.nan, dtype="float32")
        score[valid] = coefficients(model, x[valid])
        if geotiff_dir:
            profile = dict(scene.profile, driver="GTiff", count=1, dtype="float32",
                           nodata=-9999, compress="deflate")
            with rasterio.open(geotiff_dir / f"{scene.id}-score.tif", "w", **profile) as f:
                f.write(np.where(valid, score, -9999), 1)
                f.update_tags(model_threshold=model["threshold"], quantity="flood model score")
        # Reserve 255 for missing data. 0–254 encodes values in 0–1.
        def pack(values):
            encoded = np.where(valid, np.rint(np.nan_to_num(values, nan=0) * 254), 255)
            return base64.b64encode(encoded.astype("uint8").tobytes()).decode("ascii")

        pre, post = [pack(np.clip((scene.radar[i] + 32) / 30, 0, 1)) for i in (0, 2)]
        score_bytes = pack(score)
        # Preserve exact decisions at the selected model threshold despite score quantization.
        decision = pack((score >= model["threshold"]).astype("float32"))
        height, width = valid.shape
        entries.append(dict(id=scene.id, title=scene.title, event=scene.event,
                            before_date=scene.before_date, after_date=scene.after_date,
                            center=scene.center, width=width, height=height, pixel_km2=scene.pixel_km2,
                            before=pre, after=post, score=score_bytes, decision=decision))
    payload = json.dumps({"scenes": entries, "model": model}, allow_nan=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(template.replace("/* DATA */", payload.replace("<", "\\u003c")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    demo = commands.add_parser("demo")
    demo.add_argument("output", type=Path)
    fit = commands.add_parser("train")
    fit.add_argument("manifest", type=Path)
    fit.add_argument("output", type=Path)
    run = commands.add_parser("predict")
    run.add_argument("manifest", type=Path)
    run.add_argument("model", type=Path)
    run.add_argument("output", type=Path)
    run.add_argument("--geotiff-dir", type=Path)
    args = parser.parse_args()
    if args.command == "predict":
        model = json.loads(args.model.read_text())
        if model["format"] != 1 or model["features"] != list(FEATURES):
            parser.error("Unsupported model format.")
        if model["synthetic"]:
            parser.error("Train with labeled NISAR data before running on real scenes.")
        render(load_manifest(args.manifest, False), model, args.output, args.geotiff_dir)
        return
    is_demo = args.command == "demo"
    scenes = synthetic_scenes() if is_demo else load_manifest(args.manifest, True)
    model = train(scenes, is_demo)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "model.json").write_text(json.dumps(model, indent=2) + "\n")
    if is_demo:
        render([scene for scene in scenes if scene.split == "test"], model,
               args.output / "Earth-Waltz.html")
    print(json.dumps(model["evaluation"], indent=2))


if __name__ == "__main__":
    main()
