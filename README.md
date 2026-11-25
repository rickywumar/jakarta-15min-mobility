# Jakarta 15-Minute Mobility Pulse

An interactive urban mobility dashboard and **street-network 15-minute walking Service Area checker** for DKI Jakarta covering **MRT Jakarta, LRT Jakarta, LRT Jabodebek, KRL Commuter Line, KAI Intercity / Whoosh, TransJakarta BRT, TransJakarta Non-BRT, and Mikrotrans (JakLingko)**.

## Why Street-Network Service Area (Instead of a Simple Radius)?
In Jakarta, rivers and canals (*Ciliwung*, *Banjir Kanal*), elevated toll roads, rail tracks, and gated superblocks break straight-line paths. This dashboard queries the **Valhalla pedestrian routing engine** (`costing: "pedestrian"`) over OpenStreetMap's footpath/street graph to draw real **5-, 10-, and 15-minute walking polygons**, and lets you toggle a naive 1,200 m circle comparison to measure the **Street Connectivity Ratio**.

## Project Structure
- `scripts/build_data.py` — Downloads official TransJakarta GTFS, OSM rail stations, and DKI Jakarta Kecamatan boundaries, then computes a 250 m citywide coverage grid.
- `data/kecamatan.geojson` — 42 mainland Kecamatan polygons with computed coverage & density attributes (**QGIS-ready**).
- `data/stops.geojson` — Classified transit stops across DKI Jakarta + 1.2 km border buffer (**QGIS-ready**).
- `data/stops.min.json` & `data/summary.json` — Compact web assets for instant browser loading.
- `index.html`, `styles.css`, `app.js` — Static Leaflet + Turf.js dashboard (works directly on GitHub Pages).

## Local Preview
```bash
python -m http.server 8765
```
Then open `http://localhost:8765` in your browser.

## Refreshing the Transit Data
```bash
python scripts/build_data.py
```

## Opening in QGIS
Drag `data/kecamatan.geojson` and `data/stops.geojson` directly into QGIS. All Kecamatan polygons include `rapid_cov_pct`, `all_cov_pct`, `feeder_boost_pct`, `cnt_rail`, `cnt_tj_brt`, `cnt_mikrotrans`, and `stops_per_km2`.

## Publishing to GitHub Pages & Daily Auto-Updates
This repository includes `.github/workflows/deploy-and-daily-update.yml`, which handles both **live hosting** and **automated daily data refreshes**:
- **Auto-deploy on push:** Every time you retouch the design locally and push to `main`, GitHub Pages updates your live site automatically in ~30–60 seconds.
- **Daily auto-update (`03:00 WIB` / `20:00 UTC`):** GitHub Actions runs `scripts/build_data.py` to refresh TransJakarta GTFS stops/routes and re-deploys the site if anything changed (you can also trigger it manually from the **Actions** tab).

### First-Time GitHub Setup
1. Create a new empty repository on GitHub (e.g. `jakarta-15min-mobility`).
2. Push this local folder to the `main` branch.
3. On GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. In **Settings → Actions → General**, ensure **Workflow permissions** allow **Read and write permissions** (so the daily job can commit refreshed `data/` files).
