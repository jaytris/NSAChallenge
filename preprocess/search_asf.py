"""Find (and optionally download) NISAR or Sentinel-1 granules for a SAR Atlas region from NASA ASF DAAC.

    python search_asf.py --region mississippi --start 2025-11-01 --end 2026-06-30
    python search_asf.py --region jakarta --dataset SENTINEL-1 --download ./granules

Downloads need an Earthdata login (https://urs.earthdata.nasa.gov) in ~/.netrc or via --user/--password.
Product names and processing levels evolve; check https://nisar-docs.asf.alaska.edu/ and
`asf_search.constants` for the current NISAR identifiers before a large download.
"""
import argparse
import getpass

import asf_search as asf

REGIONS = {
    "mississippi": (-90.4, 28.95, -89.2, 29.85),
    "rondonia": (-63.6, -10.5, -62.4, -9.5),
    "jakarta": (106.68, -6.36, 107.0, -6.04),
}
LEVELS = {"NISAR": ["GCOV", "GUNW"], "SENTINEL-1": ["GRD_HD"]}


def wkt(b):
    w, s, e, n = b
    return f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", choices=REGIONS, required=True)
    ap.add_argument("--dataset", default="NISAR", choices=LEVELS)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--max", type=int, default=200)
    ap.add_argument("--download", metavar="DIR")
    ap.add_argument("--user")
    args = ap.parse_args()

    results = asf.search(
        dataset=args.dataset, processingLevel=LEVELS[args.dataset],
        intersectsWith=wkt(REGIONS[args.region]), start=args.start, end=args.end, maxResults=args.max,
    )
    print(f"{len(results)} granules")
    for r in results:
        p = r.properties
        print(p.get("startTime", "")[:10], p.get("processingLevel"), p.get("pathNumber"), p.get("flightDirection"), p.get("sceneName") or p.get("fileID"))
    if args.download:
        session = asf.ASFSession()
        if args.user:
            session.auth_with_creds(args.user, getpass.getpass("Earthdata password: "))
        results.download(path=args.download, session=session)
        print("downloaded to", args.download)
    print("Keep one relative orbit and flight direction per stack so geometry stays consistent.")


if __name__ == "__main__":
    main()
