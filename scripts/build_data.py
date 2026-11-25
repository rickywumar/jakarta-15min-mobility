#!/usr/bin/env python3
"""
Build spatial and transit datasets for the Jakarta 15-Minute Mobility Pulse dashboard.

Outputs (written to ../data/):
  - kecamatan.geojson  (42 DKI Jakarta mainland Kecamatan polygons + coverage metrics, QGIS-ready)
  - stops.geojson      (All classified transit stops inside DKI + 1.2 km border buffer, QGIS-ready)
  - stops.min.json     (Compact array format for fast browser loading)
  - summary.json       (Citywide KPIs, mode counts, metadata, and preset test locations)
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import math
import os
import re
import time
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any

import requests

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": "Jakarta15MinMobilityPulse/1.0 (https://github.com/urban-mobility-trial)"
}

JAKARTA_LAT_REF = -6.2088
COS_LAT = math.cos(math.radians(JAKARTA_LAT_REF))
EARTH_R_M = 6371000.0

MODES = [
    {"id": "mrt", "label": "MRT Jakarta", "short": "MRT", "rapid": True, "color": "#FF6B6B"},
    {"id": "lrt", "label": "LRT Jakarta / Jabodebek", "short": "LRT", "rapid": True, "color": "#C084FC"},
    {"id": "krl", "label": "KRL Commuter Line", "short": "KRL", "rapid": True, "color": "#F59E0B"},
    {"id": "train", "label": "KAI Intercity / Whoosh", "short": "Train", "rapid": True, "color": "#EC4899"},
    {"id": "tj_brt", "label": "TransJakarta BRT", "short": "TJ BRT", "rapid": True, "color": "#38BDF8"},
    {"id": "tj_nonbrt", "label": "TransJakarta Non-BRT", "short": "Non-BRT", "rapid": False, "color": "#34D399"},
    {"id": "mikrotrans", "label": "Mikrotrans (JakLingko)", "short": "Mikrotrans", "rapid": False, "color": "#A3E635"},
]
MODE_INDEX = {m["id"]: idx for idx, m in enumerate(MODES)}
MODE_LABEL = {m["id"]: m["label"] for m in MODES}
RAPID_MODES = {m["id"] for m in MODES if m["rapid"]}

PRESET_PLACES = [
    {"name": "Bundaran HI", "desc": "Central CBD · MRT + TJ Hub", "lat": -6.19496, "lon": 106.82307},
    {"name": "Blok M", "desc": "South Transit Hub · MRT + TJ", "lat": -6.24425, "lon": 106.80054},
    {"name": "Kemang", "desc": "South · Canal & Feeder Zone", "lat": -6.26067, "lon": 106.81414},
    {"name": "Tebet Eco Park", "desc": "South · Ciliwung / KRL Corridor", "lat": -6.23819, "lon": 106.85296},
    {"name": "PIK (Pantai Indah Kapuk)", "desc": "North · Coastal Car-Oriented", "lat": -6.10895, "lon": 106.74074},
    {"name": "Kelapa Gading", "desc": "North · LRT Jakarta Corridor", "lat": -6.15897, "lon": 106.90613},
    {"name": "Jagakarsa", "desc": "South Outer · Rail & Mikrotrans", "lat": -6.33381, "lon": 106.82195},
    {"name": "Cakung", "desc": "East Outer · Industrial & Border", "lat": -6.18592, "lon": 106.94386},
]

# Verified active stations fallback in case OSM tagging misses or renames any hub
VERIFIED_RAIL_STATIONS = [
    # MRT Jakarta Phase 1 (13 active stations)
    {"name": "Lebak Bulus Grab", "lat": -6.28940, "lon": 106.77492, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Fatmawati Indomaret", "lat": -6.29250, "lon": 106.79246, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Cipete Raya", "lat": -6.27846, "lon": 106.79729, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Haji Nawi", "lat": -6.26675, "lon": 106.79730, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Blok A", "lat": -6.25573, "lon": 106.79710, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Blok M BCA", "lat": -6.24449, "lon": 106.79814, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "ASEAN", "lat": -6.23874, "lon": 106.79846, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Senayan Mastercard", "lat": -6.22670, "lon": 106.80248, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Istora Mandiri", "lat": -6.22243, "lon": 106.80865, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Bendungan Hilir", "lat": -6.21495, "lon": 106.81796, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Setiabudi Astra", "lat": -6.20899, "lon": 106.82163, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Dukuh Atas BNI", "lat": -6.20084, "lon": 106.82281, "mode": "mrt", "routes": "MRT North-South Line"},
    {"name": "Bundaran HI Bank DKI", "lat": -6.19194, "lon": 106.82301, "mode": "mrt", "routes": "MRT North-South Line"},
    # LRT Jakarta Phase 1 (6 active stations)
    {"name": "Pegangsaan Dua", "lat": -6.15583, "lon": 106.91417, "mode": "lrt", "routes": "LRT Jakarta (Line S)"},
    {"name": "Boulevard Utara", "lat": -6.15748, "lon": 106.90418, "mode": "lrt", "routes": "LRT Jakarta (Line S)"},
    {"name": "Boulevard Selatan", "lat": -6.16565, "lon": 106.90127, "mode": "lrt", "routes": "LRT Jakarta (Line S)"},
    {"name": "Pulomas", "lat": -6.17535, "lon": 106.89390, "mode": "lrt", "routes": "LRT Jakarta (Line S)"},
    {"name": "Equestrian", "lat": -6.18307, "lon": 106.89021, "mode": "lrt", "routes": "LRT Jakarta (Line S)"},
    {"name": "Velodrome", "lat": -6.19199, "lon": 106.89061, "mode": "lrt", "routes": "LRT Jakarta (Line S)"},
    # LRT Jabodebek active stations in/near DKI Jakarta
    {"name": "Dukuh Atas (LRT)", "lat": -6.20438, "lon": 106.82411, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Setiabudi (LRT)", "lat": -6.20969, "lon": 106.83002, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Rasuna Said", "lat": -6.22146, "lon": 106.83214, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Kuningan", "lat": -6.22892, "lon": 106.83315, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Pancoran", "lat": -6.24212, "lon": 106.83907, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Cikoko", "lat": -6.24317, "lon": 106.85769, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Ciliwung", "lat": -6.24383, "lon": 106.86399, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Cawang (LRT)", "lat": -6.24584, "lon": 106.87262, "mode": "lrt", "routes": "LRT Jabodebek (CB & BK)"},
    {"name": "Halim (LRT)", "lat": -6.24646, "lon": 106.88918, "mode": "lrt", "routes": "LRT Jabodebek (BK)"},
    {"name": "TMII", "lat": -6.29238, "lon": 106.88202, "mode": "lrt", "routes": "LRT Jabodebek (CB)"},
    {"name": "Kampung Rambutan", "lat": -6.30956, "lon": 106.88340, "mode": "lrt", "routes": "LRT Jabodebek (CB)"},
    {"name": "Ciracas", "lat": -6.32279, "lon": 106.88660, "mode": "lrt", "routes": "LRT Jabodebek (CB)"},
    {"name": "Harjamukti", "lat": -6.37364, "lon": 106.89460, "mode": "lrt", "routes": "LRT Jabodebek (CB)"},
    # Dedicated Intercity / Whoosh hubs
    {"name": "Gambir", "lat": -6.17665, "lon": 106.83062, "mode": "train", "routes": "KAI Intercity (Eksekutif)"},
    {"name": "Halim (Whoosh)", "lat": -6.24598, "lon": 106.88625, "mode": "train", "routes": "Whoosh High-Speed Rail"},
    # KRL Commuter Line stations in DKI Jakarta + immediate border
    # Bogor Line
    {"name": "Jakarta Kota", "lat": -6.13756, "lon": 106.81465, "mode": "krl", "routes": "KRL · KAI"},
    {"name": "Jayakarta", "lat": -6.14132, "lon": 106.82320, "mode": "krl", "routes": "KRL Bogor / Tanjung Priok"},
    {"name": "Mangga Besar", "lat": -6.14989, "lon": 106.82699, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Sawah Besar", "lat": -6.16067, "lon": 106.82765, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Juanda", "lat": -6.16686, "lon": 106.83044, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Gondangdia", "lat": -6.18599, "lon": 106.83264, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Cikini", "lat": -6.19843, "lon": 106.84145, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Manggarai", "lat": -6.20994, "lon": 106.85023, "mode": "krl", "routes": "KRL · Airport Rail · KAI"},
    {"name": "Tebet", "lat": -6.22611, "lon": 106.85838, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Cawang", "lat": -6.24262, "lon": 106.85872, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Duren Kalibata", "lat": -6.25536, "lon": 106.85513, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Pasar Minggu Baru", "lat": -6.26273, "lon": 106.85185, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Pasar Minggu", "lat": -6.28436, "lon": 106.84440, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Tanjung Barat", "lat": -6.30784, "lon": 106.83909, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Lenteng Agung", "lat": -6.33064, "lon": 106.83503, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Universitas Pancasila", "lat": -6.33899, "lon": 106.83441, "mode": "krl", "routes": "KRL Bogor Line"},
    {"name": "Universitas Indonesia", "lat": -6.36062, "lon": 106.83179, "mode": "krl", "routes": "KRL Bogor Line"},
    # Cikarang Loop Line
    {"name": "Kampung Bandan", "lat": -6.13250, "lon": 106.82867, "mode": "krl", "routes": "KRL Cikarang / Priok"},
    {"name": "Rajawali", "lat": -6.14496, "lon": 106.83696, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Kemayoran", "lat": -6.16167, "lon": 106.84148, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Pasar Senen", "lat": -6.17420, "lon": 106.84449, "mode": "krl", "routes": "KRL · KAI Intercity"},
    {"name": "Gang Sentiong", "lat": -6.18626, "lon": 106.85075, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Kramat", "lat": -6.19393, "lon": 106.85647, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Pondok Jati", "lat": -6.20637, "lon": 106.86173, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Jatinegara", "lat": -6.21520, "lon": 106.87032, "mode": "krl", "routes": "KRL · KAI Intercity"},
    {"name": "Matraman", "lat": -6.21172, "lon": 106.86026, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Sudirman", "lat": -6.20238, "lon": 106.82353, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "BNI City", "lat": -6.20073, "lon": 106.81887, "mode": "krl", "routes": "KRL · Airport Rail (ARS)"},
    {"name": "Karet", "lat": -6.20092, "lon": 106.81611, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Tanah Abang", "lat": -6.18560, "lon": 106.81082, "mode": "krl", "routes": "KRL Cikarang / Rangkasbitung"},
    {"name": "Duri", "lat": -6.15548, "lon": 106.80121, "mode": "krl", "routes": "KRL · Airport Rail (ARS)"},
    {"name": "Angke", "lat": -6.14474, "lon": 106.80071, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Klender", "lat": -6.21319, "lon": 106.89941, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Buaran", "lat": -6.21562, "lon": 106.92341, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Klender Baru", "lat": -6.21763, "lon": 106.94000, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Cakung", "lat": -6.21922, "lon": 106.95224, "mode": "krl", "routes": "KRL Cikarang Loop"},
    {"name": "Kranji", "lat": -6.22443, "lon": 106.97932, "mode": "krl", "routes": "KRL Cikarang Loop"},
    # Rangkasbitung Line
    {"name": "Palmerah", "lat": -6.20731, "lon": 106.79753, "mode": "krl", "routes": "KRL Rangkasbitung Line"},
    {"name": "Kebayoran", "lat": -6.23719, "lon": 106.78246, "mode": "krl", "routes": "KRL Rangkasbitung Line"},
    {"name": "Pondok Ranji", "lat": -6.27700, "lon": 106.74488, "mode": "krl", "routes": "KRL Rangkasbitung Line"},
    # Tangerang Line
    {"name": "Grogol", "lat": -6.16176, "lon": 106.78890, "mode": "krl", "routes": "KRL Tangerang Line"},
    {"name": "Pesing", "lat": -6.16136, "lon": 106.77179, "mode": "krl", "routes": "KRL Tangerang Line"},
    {"name": "Taman Kota", "lat": -6.15836, "lon": 106.75647, "mode": "krl", "routes": "KRL Tangerang Line"},
    {"name": "Bojong Indah", "lat": -6.15971, "lon": 106.73664, "mode": "krl", "routes": "KRL Tangerang Line"},
    {"name": "Rawa Buaya", "lat": -6.16207, "lon": 106.72322, "mode": "krl", "routes": "KRL · Airport Rail (ARS)"},
    {"name": "Kalideres", "lat": -6.16569, "lon": 106.70349, "mode": "krl", "routes": "KRL Tangerang Line"},
    {"name": "Poris", "lat": -6.16950, "lon": 106.68089, "mode": "krl", "routes": "KRL Tangerang Line"},
    # Tanjung Priok Line
    {"name": "Ancol", "lat": -6.12770, "lon": 106.84546, "mode": "krl", "routes": "KRL Tanjung Priok Line"},
    {"name": "Tanjung Priok", "lat": -6.11079, "lon": 106.88142, "mode": "krl", "routes": "KRL Tanjung Priok Line"},
]

KEC_TO_KOTA = {
    # Jakarta Pusat (8)
    "Cempaka Putih": "Jakarta Pusat",
    "Gambir": "Jakarta Pusat",
    "Johar Baru": "Jakarta Pusat",
    "Kemayoran": "Jakarta Pusat",
    "Menteng": "Jakarta Pusat",
    "Sawah Besar": "Jakarta Pusat",
    "Senen": "Jakarta Pusat",
    "Tanah Abang": "Jakarta Pusat",
    # Jakarta Utara (6)
    "Cilincing": "Jakarta Utara",
    "Kelapa Gading": "Jakarta Utara",
    "Koja": "Jakarta Utara",
    "Pademangan": "Jakarta Utara",
    "Penjaringan": "Jakarta Utara",
    "Tanjung Priok": "Jakarta Utara",
    # Jakarta Barat (8)
    "Cengkareng": "Jakarta Barat",
    "Grogol Petamburan": "Jakarta Barat",
    "Kalideres": "Jakarta Barat",
    "Kebon Jeruk": "Jakarta Barat",
    "Kembangan": "Jakarta Barat",
    "Palmerah": "Jakarta Barat",
    "Taman Sari": "Jakarta Barat",
    "Tambora": "Jakarta Barat",
    # Jakarta Selatan (10)
    "Cilandak": "Jakarta Selatan",
    "Jagakarsa": "Jakarta Selatan",
    "Kebayoran Baru": "Jakarta Selatan",
    "Kebayoran Lama": "Jakarta Selatan",
    "Mampang Prapatan": "Jakarta Selatan",
    "Pancoran": "Jakarta Selatan",
    "Pasar Minggu": "Jakarta Selatan",
    "Pesanggrahan": "Jakarta Selatan",
    "Setiabudi": "Jakarta Selatan",
    "Tebet": "Jakarta Selatan",
    # Jakarta Timur (10)
    "Cakung": "Jakarta Timur",
    "Cipayung": "Jakarta Timur",
    "Ciracas": "Jakarta Timur",
    "Duren Sawit": "Jakarta Timur",
    "Jatinegara": "Jakarta Timur",
    "Kramat Jati": "Jakarta Timur",
    "Makasar": "Jakarta Timur",
    "Matraman": "Jakarta Timur",
    "Pasar Rebo": "Jakarta Timur",
    "Pulogadung": "Jakarta Timur",
}

DUAL_INTERCITY_KRL = {
    "manggarai": "KRL · Airport Rail · KAI",
    "pasar senen": "KRL · KAI Intercity",
    "jatinegara": "KRL · KAI Intercity",
    "bni city": "KRL · Airport Rail (ARS)",
    "sudirman baru": "KRL · Airport Rail (ARS)",
    "jakarta kota": "KRL · KAI",
    "duri": "KRL · Airport Rail (ARS)",
    "rawabuaya": "KRL · Airport Rail (ARS)",
    "rawa buaya": "KRL · Airport Rail (ARS)",
    "bekasi": "KRL · KAI Intercity",
}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


def ring_area_km2(ring: list[list[float]]) -> float:
    if len(ring) < 3:
        return 0.0
    deg_to_rad = math.pi / 180.0
    r_km = 6371.0
    pts = [
        (lon * deg_to_rad * r_km * COS_LAT, lat * deg_to_rad * r_km)
        for lon, lat in ring
    ]
    area = 0.0
    for i in range(len(pts) - 1):
        area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
    return abs(area) * 0.5


def geometry_area_km2(geom: dict[str, Any]) -> float:
    gtype = geom["type"]
    coords = geom["coordinates"]
    if gtype == "Polygon":
        total = ring_area_km2(coords[0])
        for hole in coords[1:]:
            total -= ring_area_km2(hole)
        return max(0.0, total)
    elif gtype == "MultiPolygon":
        total = 0.0
        for poly in coords:
            total += ring_area_km2(poly[0])
            for hole in poly[1:]:
                total -= ring_area_km2(hole)
        return max(0.0, total)
    return 0.0


def point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[i + 1][0], ring[i + 1][1]
        if (y1 > y) != (y2 > y):
            x_intersect = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-18) + x1
            if x < x_intersect:
                inside = not inside
    return inside


def point_in_polygon_coords(x: float, y: float, rings: list[list[list[float]]]) -> bool:
    if not rings or not point_in_ring(x, y, rings[0]):
        return False
    for hole in rings[1:]:
        if point_in_ring(x, y, hole):
            return False
    return True


def point_in_geom(lon: float, lat: float, geom: dict[str, Any]) -> bool:
    gtype = geom["type"]
    coords = geom["coordinates"]
    if gtype == "Polygon":
        return point_in_polygon_coords(lon, lat, coords)
    elif gtype == "MultiPolygon":
        return any(point_in_polygon_coords(lon, lat, poly) for poly in coords)
    return False


def geom_bbox(geom: dict[str, Any]) -> tuple[float, float, float, float]:
    minx, miny, maxx, maxy = 180.0, 90.0, -180.0, -90.0
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    for poly in polys:
        for ring in poly:
            for lon, lat in ring:
                if lon < minx:
                    minx = lon
                if lon > maxx:
                    maxx = lon
                if lat < miny:
                    miny = lat
                if lat > maxy:
                    maxy = lat
    return minx, miny, maxx, maxy


def rdp_ring(ring: list[list[float]], tol: float) -> list[list[float]]:
    if len(ring) <= 6:
        return [[round(p[0], 5), round(p[1], 5)] for p in ring]

    def perp_dist(pt, a, b):
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        if dx == 0 and dy == 0:
            return math.hypot(pt[0] - a[0], pt[1] - a[1])
        t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        proj_x = a[0] + t * dx
        proj_y = a[1] + t * dy
        return math.hypot(pt[0] - proj_x, pt[1] - proj_y)

    def simplify_segment(pts: list[list[float]]) -> list[list[float]]:
        if len(pts) < 3:
            return pts
        max_d = 0.0
        idx = 0
        a, b = pts[0], pts[-1]
        for i in range(1, len(pts) - 1):
            d = perp_dist(pts[i], a, b)
            if d > max_d:
                max_d = d
                idx = i
        if max_d > tol:
            left = simplify_segment(pts[: idx + 1])
            right = simplify_segment(pts[idx:])
            return left[:-1] + right
        return [a, b]

    # Split closed ring at midpoint to preserve closed loop cleanly
    mid = len(ring) // 2
    s1 = simplify_segment(ring[: mid + 1])
    s2 = simplify_segment(ring[mid:])
    out = s1[:-1] + s2
    if len(out) < 4:
        out = ring
    rounded = [[round(p[0], 5), round(p[1], 5)] for p in out]
    if rounded[0] != rounded[-1]:
        rounded.append(rounded[0])
    return rounded


def simplify_geom(geom: dict[str, Any], tol: float) -> dict[str, Any]:
    if geom["type"] == "Polygon":
        return {
            "type": "Polygon",
            "coordinates": [rdp_ring(r, tol) for r in geom["coordinates"]],
        }
    elif geom["type"] == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [[rdp_ring(r, tol) for r in poly] for poly in geom["coordinates"]],
        }
    return geom


def normalize_kota(raw: str) -> str:
    s = re.sub(r"\s+", " ", (raw or "").strip())
    s = re.sub(r"^(Kota\s+Administrasi|Kota\s+Adm\.|Kota|Kabupaten\s+Administrasi|Kab\.)\s+", "", s, flags=re.I)
    low = s.lower()
    mapping = {
        "pusat": "Jakarta Pusat",
        "jakarta pusat": "Jakarta Pusat",
        "utara": "Jakarta Utara",
        "jakarta utara": "Jakarta Utara",
        "barat": "Jakarta Barat",
        "jakarta barat": "Jakarta Barat",
        "selatan": "Jakarta Selatan",
        "jakarta selatan": "Jakarta Selatan",
        "timur": "Jakarta Timur",
        "jakarta timur": "Jakarta Timur",
    }
    for k, v in mapping.items():
        if k in low:
            return v
    return s.title()


def normalize_kecamatan(raw: str) -> str:
    s = re.sub(r"\s+", " ", (raw or "").strip())
    s = re.sub(r"^(Kecamatan|Kec\.)\s+", "", s, flags=re.I)
    return s.title()


def fetch_kecamatan_boundaries() -> list[dict[str, Any]]:
    print("[1/4] Fetching DKI Jakarta Kecamatan boundaries...")
    urls = [
        "https://raw.githubusercontent.com/SakifAbdillah/jakartaKecamatanGeoJSON/master/kecamatan.geojson",
        "https://raw.githubusercontent.com/SakifAbdillah/jakartaKecamatanGeoJSON/main/kecamatan.geojson",
    ]
    raw_fc = None
    for url in urls:
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.ok:
                raw_fc = r.json()
                print(f"  Loaded boundaries from {url} ({len(r.content)/1024:.1f} KB)")
                break
        except Exception as e:
            print(f"  Boundary fetch warning ({url}): {e}")

    if not raw_fc or not raw_fc.get("features"):
        raise RuntimeError("Could not download Jakarta Kecamatan GeoJSON from primary sources.")

    sample_props = raw_fc["features"][0].get("properties", {})
    print(f"  Sample boundary properties: {list(sample_props.keys())} -> {sample_props}")

    features = []
    seen_names = set()
    for feat in raw_fc["features"]:
        props = feat.get("properties", {})
        geom = feat.get("geometry")
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue

        kec_raw = (
            props.get("KECAMATAN")
            or props.get("kecamatan")
            or props.get("WADMKC")
            or props.get("name")
            or props.get("NAME_3")
            or ""
        )
        kota_raw = (
            props.get("KOTA")
            or props.get("kota")
            or props.get("KAB_KOTA")
            or props.get("WADMKK")
            or props.get("NAME_2")
            or props.get("city")
            or ""
        )
        joined = f"{kec_raw} {kota_raw}".lower()
        if "seribu" in joined:
            continue

        kec = normalize_kecamatan(kec_raw)
        kota = KEC_TO_KOTA.get(kec) or normalize_kota(kota_raw) or "DKI Jakarta"
        if not kec:
            continue

        # Handle duplicate parts if split across MultiPolygons
        key = (kec, kota)
        if key in seen_names:
            for existing in features:
                if existing["properties"]["kecamatan"] == kec:
                    # Merge into MultiPolygon
                    g_old = existing["geometry"]
                    polys_old = [g_old["coordinates"]] if g_old["type"] == "Polygon" else g_old["coordinates"]
                    polys_new = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
                    existing["geometry"] = {"type": "MultiPolygon", "coordinates": polys_old + polys_new}
                    break
            continue

        seen_names.add(key)
        features.append({
            "type": "Feature",
            "properties": {"kecamatan": kec, "kota": kota},
            "geometry": geom,
        })

    # Simplify if large
    raw_size = len(json.dumps({"type": "FeatureCollection", "features": features}))
    if raw_size > 1_200_000:
        print(f"  Simplifying boundaries (raw size {raw_size/1024:.0f} KB)...")
        for f in features:
            f["geometry"] = simplify_geom(f["geometry"], 0.00015)

    for f in features:
        f["properties"]["area_km2"] = round(geometry_area_km2(f["geometry"]), 2)
        f["_bbox"] = geom_bbox(f["geometry"])

    print(f"  Prepared {len(features)} mainland Kecamatan across {len({f['properties']['kota'] for f in features})} Kota.")
    return features


def classify_tj_route(short_name: str, long_name: str, desc: str) -> str:
    sn = (short_name or "").strip()
    sn_u = sn.upper()
    ln_l = (long_name or "").lower()
    d_l = (desc or "").strip().lower()

    if d_l == "brt":
        return "tj_brt"
    if d_l == "mikrotrans" or sn_u.startswith("JAK") or "mikrotrans" in ln_l or "jaklingko" in ln_l:
        return "mikrotrans"
    if d_l:
        return "tj_nonbrt"
    if re.match(r"^(1[0-4]|[1-9])([A-Z]?)$", sn_u):
        return "tj_brt"
    return "tj_nonbrt"


def fetch_transjakarta_gtfs() -> tuple[list[dict[str, Any]], str]:
    print("[2/4] Downloading TransJakarta official GTFS feed...")
    url = "https://gtfs.transjakarta.co.id/files/file_gtfs.zip"
    try:
        r = requests.get(url, headers=HEADERS, timeout=90)
        r.raise_for_status()
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        names = set(zf.namelist())
        print(f"  GTFS downloaded ({len(r.content)/1024/1024:.2f} MB). Files: {sorted(names)}")
    except Exception as e:
        print(f"  GTFS download failed: {e}. Falling back to Overpass bus stops...")
        return fetch_tj_overpass_fallback(), "Overpass API fallback (GTFS unavailable)"

    def read_csv(filename: str) -> list[dict[str, str]]:
        with zf.open(filename) as fp:
            text = io.TextIOWrapper(fp, encoding="utf-8-sig", errors="replace")
            return list(csv.DictReader(text))

    routes_rows = read_csv("routes.txt")
    print(f"  Sample GTFS routes ({len(routes_rows)} total):")
    for sample in routes_rows[:6]:
        print(f"    short={sample.get('route_short_name')!r} desc={sample.get('route_desc')!r} long={sample.get('route_long_name')!r}")

    route_info: dict[str, tuple[str, str]] = {}
    mode_route_counts = defaultdict(int)
    for row in routes_rows:
        rid = row.get("route_id", "")
        sn = (row.get("route_short_name") or "").strip()
        ln = (row.get("route_long_name") or "").strip()
        desc = (row.get("route_desc") or "").strip()
        mode = classify_tj_route(sn, ln, desc)
        label = sn or ln or rid
        route_info[rid] = (mode, label)
        mode_route_counts[mode] += 1
    print(f"  Classified routes: {dict(mode_route_counts)}")

    trip_to_route: dict[str, str] = {}
    for row in read_csv("trips.txt"):
        tid = row.get("trip_id", "")
        rid = row.get("route_id", "")
        if tid and rid:
            trip_to_route[tid] = rid

    stop_routes: dict[str, set[str]] = defaultdict(set)
    with zf.open("stop_times.txt") as fp:
        text = io.TextIOWrapper(fp, encoding="utf-8-sig", errors="replace")
        for row in csv.DictReader(text):
            sid = row.get("stop_id", "")
            tid = row.get("trip_id", "")
            rid = trip_to_route.get(tid)
            if sid and rid:
                stop_routes[sid].add(rid)

    stops_rows = read_csv("stops.txt")
    raw_stops: dict[str, dict[str, Any]] = {}
    for row in stops_rows:
        sid = row.get("stop_id", "")
        try:
            lat = float(row.get("stop_lat", ""))
            lon = float(row.get("stop_lon", ""))
        except ValueError:
            continue
        if not (-6.55 <= lat <= -5.95 and 106.55 <= lon <= 107.15):
            continue
        raw_stops[sid] = {
            "id": sid,
            "name": (row.get("stop_name") or "TransJakarta Stop").strip(),
            "lat": lat,
            "lon": lon,
            "parent": (row.get("parent_station") or "").strip(),
            "loc_type": (row.get("location_type") or "0").strip(),
        }

    # Roll child stop routes up to parent station if parent exists with coords
    for sid, st in raw_stops.items():
        p = st["parent"]
        if p and p in raw_stops and sid in stop_routes:
            stop_routes[p].update(stop_routes[sid])

    # Build stop entries (skip child stops whose parent already exists with coords)
    candidates: list[dict[str, Any]] = []
    for sid, st in raw_stops.items():
        if st["parent"] and st["parent"] in raw_stops:
            continue
        rids = stop_routes.get(sid, set())
        if not rids:
            continue
        modes_here = set()
        labels_here = set()
        for rid in rids:
            if rid in route_info:
                m, lbl = route_info[rid]
                modes_here.add(m)
                if lbl:
                    labels_here.add(lbl)
        if not modes_here:
            continue

        # Primary mode priority: tj_brt > tj_nonbrt > mikrotrans
        if "tj_brt" in modes_here:
            primary_mode = "tj_brt"
        elif "tj_nonbrt" in modes_here:
            primary_mode = "tj_nonbrt"
        else:
            primary_mode = "mikrotrans"

        sorted_labels = sorted(labels_here, key=lambda x: (len(x), x))
        routes_str = ", ".join(sorted_labels[:10])
        if len(sorted_labels) > 10:
            routes_str += f" (+{len(sorted_labels)-10})"

        candidates.append({
            "id": f"tj:{sid}",
            "name": st["name"],
            "lat": st["lat"],
            "lon": st["lon"],
            "mode": primary_mode,
            "routes_set": set(sorted_labels),
            "routes": routes_str,
        })

    # Merge opposite-side stops sharing same mode and clean name within 85m
    merged = deduplicate_stops(candidates, dist_m=85.0, match_name=True)
    print(f"  GTFS active stops after merge: {len(merged)}")
    return merged, "PT TransJakarta Official GTFS (CC BY 4.0)"


def fetch_tj_overpass_fallback() -> list[dict[str, Any]]:
    query = """
    [out:json][timeout:60];
    (
      node["highway"="bus_stop"](-6.40,106.66,-6.07,107.01);
      node["amenity"="bus_station"](-6.40,106.66,-6.07,107.01);
    );
    out tags;
    """
    data = query_overpass(query)
    out = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name") or "Bus Stop"
        net = f"{tags.get('network', '')} {tags.get('operator', '')} {name}".lower()
        if "jak" in net or "mikro" in net:
            mode = "mikrotrans"
        elif "transjakarta" in net or "koridor" in net or "halte" in name.lower():
            mode = "tj_brt"
        else:
            mode = "tj_nonbrt"
        out.append({
            "id": f"osm:{el['id']}",
            "name": name,
            "lat": el["lat"],
            "lon": el["lon"],
            "mode": mode,
            "routes": tags.get("route_ref") or tags.get("ref") or "",
        })
    return deduplicate_stops(out, dist_m=80.0, match_name=True)


def query_overpass(query: str) -> dict[str, Any]:
    endpoints = [
        "https://overpass-api.de/api/interpreter",
    ]
    last_err = None
    for ep in endpoints:
        try:
            r = requests.post(ep, data={"data": query}, headers=HEADERS, timeout=8)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print(f"  Overpass warning ({ep}): {e}")
            last_err = e
    raise RuntimeError(f"Overpass unavailable: {last_err}")


def fetch_rail_stations() -> list[dict[str, Any]]:
    print("[3/4] Fetching MRT, LRT, KRL & KAI rail stations via Overpass + Verified Registry...")
    query = """
    [out:json][timeout:8];
    (
      node["railway"~"^(station|halt)$"](-6.40,106.66,-6.07,107.01);
    );
    out tags;
    """
    elements = []
    try:
        data = query_overpass(query)
        elements = data.get("elements", [])
        print(f"  Overpass returned {len(elements)} raw railway elements.")
    except Exception as e:
        print(f"  Overpass rail fetch failed ({e}); relying on verified rail stations.")

    candidates: list[dict[str, Any]] = []
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        # Skip construction / disused
        if (
            tags.get("railway") in ("construction", "disused", "abandoned", "proposed")
            or tags.get("construction")
            or tags.get("disused:railway")
            or tags.get("abandoned:railway")
        ):
            continue
        name = (tags.get("name") or "").strip()
        if not name:
            continue
        nl = name.lower()
        if any(w in nl for w in ("construction", "rencana", "proyek", "under construction")):
            continue

        meta = f"{tags.get('network', '')} {tags.get('operator', '')} {tags.get('station', '')} {tags.get('line', '')} {name}".lower()
        if tags.get("station") == "subway" or "mrt" in meta or "mass rapid transit" in meta:
            mode = "mrt"
            routes = tags.get("line") or "MRT North-South Line"
        elif tags.get("station") == "light_rail" or "lrt" in meta:
            mode = "lrt"
            routes = tags.get("line") or ("LRT Jabodebek" if "jabodebek" in meta or "kci" not in meta else "LRT Jakarta")
        elif "whoosh" in meta or "kcic" in meta or nl in ("gambir", "stasiun gambir", "halim", "stasiun halim"):
            mode = "train"
            routes = "Whoosh High-Speed Rail" if ("whoosh" in meta or "halim" in nl) else "KAI Intercity"
        else:
            mode = "krl"
            clean_key = re.sub(r"^stasiun\s+", "", nl).strip()
            routes = DUAL_INTERCITY_KRL.get(clean_key, tags.get("line") or "KRL Commuter Line")

        clean_name = re.sub(r"^Stasiun\s+", "", name, flags=re.I).strip()
        candidates.append({
            "id": f"osm:{el['type'][0]}{el['id']}",
            "name": clean_name,
            "lat": float(lat),
            "lon": float(lon),
            "mode": mode,
            "routes": routes,
        })

    # Merge verified active rail stations if missing within 280m of same mode
    for idx, v in enumerate(VERIFIED_RAIL_STATIONS):
        found = any(
            c["mode"] == v["mode"] and haversine_m(c["lat"], c["lon"], v["lat"], v["lon"]) < 280
            for c in candidates
        )
        if not found:
            candidates.append({
                "id": f"ver:{idx}",
                "name": v["name"],
                "lat": v["lat"],
                "lon": v["lon"],
                "mode": v["mode"],
                "routes": v["routes"],
            })

    deduped = deduplicate_stops(candidates, dist_m=220.0, match_name=False)
    by_mode = defaultdict(int)
    for s in deduped:
        by_mode[s["mode"]] += 1
    print(f"  Rail stations after dedupe: {dict(by_mode)}")
    return deduped


def deduplicate_stops(stops: list[dict[str, Any]], dist_m: float, match_name: bool) -> list[dict[str, Any]]:
    # Simple spatial bucket dedupe per mode
    cell_deg = 0.004
    buckets: dict[tuple[str, int, int], list[dict[str, Any]]] = defaultdict(list)
    result: list[dict[str, Any]] = []

    def norm_name(s: str) -> str:
        return re.sub(r"[^a-z0-9]", "", s.lower())

    for st in stops:
        mode = st["mode"]
        cx = int(st["lon"] / cell_deg)
        cy = int(st["lat"] / cell_deg)
        n_key = norm_name(st["name"])
        merged_into = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for existing in buckets[(mode, cx + dx, cy + dy)]:
                    if match_name and norm_name(existing["name"]) != n_key:
                        continue
                    if haversine_m(st["lat"], st["lon"], existing["lat"], existing["lon"]) <= dist_m:
                        merged_into = existing
                        break
                if merged_into:
                    break
            if merged_into:
                break

        if merged_into is not None:
            if "routes_set" in st and "routes_set" in merged_into:
                merged_into["routes_set"].update(st["routes_set"])
                lbls = sorted(merged_into["routes_set"], key=lambda x: (len(x), x))
                rstr = ", ".join(lbls[:10])
                if len(lbls) > 10:
                    rstr += f" (+{len(lbls)-10})"
                merged_into["routes"] = rstr
        else:
            item = dict(st)
            if "routes_set" in item:
                item["routes_set"] = set(item["routes_set"])
            buckets[(mode, cx, cy)].append(item)
            result.append(item)

    for item in result:
        item.pop("routes_set", None)
    return result


def assign_and_compute_coverage(
    kec_features: list[dict[str, Any]],
    all_stops: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    print("[4/4] Assigning stops to Kecamatan and computing 15-min coverage grid...")

    # Overall mainland bbox + ~1.3 km buffer (~0.012 deg)
    dki_minx = min(f["_bbox"][0] for f in kec_features) - 0.013
    dki_miny = min(f["_bbox"][1] for f in kec_features) - 0.013
    dki_maxx = max(f["_bbox"][2] for f in kec_features) + 0.013
    dki_maxy = max(f["_bbox"][3] for f in kec_features) + 0.013

    kept_stops: list[dict[str, Any]] = []
    kec_mode_counts: dict[str, dict[str, int]] = {
        f["properties"]["kecamatan"]: defaultdict(int) for f in kec_features
    }

    for st in all_stops:
        lon, lat = st["lon"], st["lat"]
        if not (dki_minx <= lon <= dki_maxx and dki_miny <= lat <= dki_maxy):
            continue

        assigned_kec = None
        assigned_kota = None
        for f in kec_features:
            bx0, by0, bx1, by1 = f["_bbox"]
            if bx0 <= lon <= bx1 and by0 <= lat <= by1:
                if point_in_geom(lon, lat, f["geometry"]):
                    assigned_kec = f["properties"]["kecamatan"]
                    assigned_kota = f["properties"]["kota"]
                    break

        in_dki = assigned_kec is not None
        if not in_dki:
            # Check if within ~1.25 km of any Kecamatan bbox (with small padding)
            near = False
            for f in kec_features:
                bx0, by0, bx1, by1 = f["_bbox"]
                if (bx0 - 0.012) <= lon <= (bx1 + 0.012) and (by0 - 0.012) <= lat <= (by1 + 0.012):
                    near = True
                    break
            if not near:
                continue

        st_clean = {
            "id": st["id"],
            "name": st["name"],
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "mode": st["mode"],
            "mode_label": MODE_LABEL[st["mode"]],
            "routes": st.get("routes", ""),
            "kecamatan": assigned_kec or "Outside DKI (Border)",
            "kota": assigned_kota or "Jabodetabek Border",
            "in_dki": in_dki,
        }
        kept_stops.append(st_clean)
        if in_dki:
            kec_mode_counts[assigned_kec][st["mode"]] += 1

    # Spatial hash grid for fast 920m proximity lookup (~0.01 deg cell)
    cell_deg = 0.01
    stop_grid: dict[tuple[int, int], list[tuple[float, float, bool]]] = defaultdict(list)
    for st in kept_stops:
        cx = int(st["lon"] / cell_deg)
        cy = int(st["lat"] / cell_deg)
        stop_grid[(cx, cy)].append((st["lat"], st["lon"], st["mode"] in RAPID_MODES))

    step_lat = 250.0 / 111320.0
    step_lon = 250.0 / (111320.0 * COS_LAT)
    walk_radius_m = 920.0  # ~15 min @ 4.8 km/h (1,200 m) / 1.3 Jakarta street detour factor

    total_pts = 0
    total_rapid_pts = 0
    total_all_pts = 0

    for f in kec_features:
        props = f["properties"]
        kec = props["kecamatan"]
        area = max(0.01, props["area_km2"])
        bx0, by0, bx1, by1 = f["_bbox"]

        pts = 0
        rapid_hits = 0
        all_hits = 0

        lat = by0 + step_lat * 0.5
        while lat <= by1:
            lon = bx0 + step_lon * 0.5
            while lon <= bx1:
                if point_in_geom(lon, lat, f["geometry"]):
                    pts += 1
                    cx = int(lon / cell_deg)
                    cy = int(lat / cell_deg)
                    has_rapid = False
                    has_any = False
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            for slat, slon, is_rapid in stop_grid.get((cx + dx, cy + dy), ()):
                                if haversine_m(lat, lon, slat, slon) <= walk_radius_m:
                                    has_any = True
                                    if is_rapid:
                                        has_rapid = True
                                        break
                            if has_rapid:
                                break
                        if has_rapid:
                            break
                    if has_rapid:
                        rapid_hits += 1
                    if has_any:
                        all_hits += 1
                lon += step_lon
            lat += step_lat

        # Fallback if a tiny polygon missed grid centers
        if pts == 0:
            clat = (by0 + by1) * 0.5
            clon = (bx0 + bx1) * 0.5
            pts = 1
            cx, cy = int(clon / cell_deg), int(clat / cell_deg)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for slat, slon, is_rapid in stop_grid.get((cx + dx, cy + dy), ()):
                        if haversine_m(clat, clon, slat, slon) <= walk_radius_m:
                            all_hits = 1
                            if is_rapid:
                                rapid_hits = 1

        total_pts += pts
        total_rapid_pts += rapid_hits
        total_all_pts += all_hits

        rapid_pct = round(100.0 * rapid_hits / pts, 1)
        all_pct = round(100.0 * all_hits / pts, 1)
        counts = kec_mode_counts[kec]
        cnt_rapid = sum(counts[m] for m in RAPID_MODES)
        cnt_all = sum(counts.values())
        cnt_rail = counts["mrt"] + counts["lrt"] + counts["krl"] + counts["train"]

        props.update({
            "rapid_cov_pct": rapid_pct,
            "all_cov_pct": all_pct,
            "feeder_boost_pct": round(max(0.0, all_pct - rapid_pct), 1),
            "cnt_mrt": counts["mrt"],
            "cnt_lrt": counts["lrt"],
            "cnt_krl": counts["krl"],
            "cnt_train": counts["train"],
            "cnt_rail": cnt_rail,
            "cnt_tj_brt": counts["tj_brt"],
            "cnt_tj_nonbrt": counts["tj_nonbrt"],
            "cnt_mikrotrans": counts["mikrotrans"],
            "cnt_rapid": cnt_rapid,
            "cnt_all": cnt_all,
            "rapid_per_km2": round(cnt_rapid / area, 2),
            "brt_per_km2": round(counts["tj_brt"] / area, 2),
            "stops_per_km2": round(cnt_all / area, 2),
        })

    # Clean internal helper field
    for f in kec_features:
        f.pop("_bbox", None)

    dki_stops = [s for s in kept_stops if s["in_dki"]]
    mode_totals_dki = {m["id"]: 0 for m in MODES}
    mode_totals_all = {m["id"]: 0 for m in MODES}
    for s in kept_stops:
        mode_totals_all[s["mode"]] += 1
        if s["in_dki"]:
            mode_totals_dki[s["mode"]] += 1

    sorted_rapid = sorted(kec_features, key=lambda x: x["properties"]["rapid_cov_pct"], reverse=True)
    sorted_all = sorted(kec_features, key=lambda x: x["properties"]["all_cov_pct"], reverse=True)
    total_area = round(sum(f["properties"]["area_km2"] for f in kec_features), 2)

    summary = {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "kecamatan_count": len(kec_features),
        "kota_count": len({f["properties"]["kota"] for f in kec_features}),
        "total_area_km2": total_area,
        "grid_points_sampled": total_pts,
        "walk_radius_estimate_m": int(walk_radius_m),
        "city_rapid_cov_pct": round(100.0 * total_rapid_pts / max(1, total_pts), 1),
        "city_all_cov_pct": round(100.0 * total_all_pts / max(1, total_pts), 1),
        "stops_in_dki": len(dki_stops),
        "stops_total_with_border": len(kept_stops),
        "rapid_stops_in_dki": sum(mode_totals_dki[m] for m in RAPID_MODES),
        "feeder_stops_in_dki": mode_totals_dki["tj_nonbrt"] + mode_totals_dki["mikrotrans"],
        "mode_totals_dki": mode_totals_dki,
        "mode_totals_all": mode_totals_all,
        "best_rapid_kec": {
            "kecamatan": sorted_rapid[0]["properties"]["kecamatan"],
            "kota": sorted_rapid[0]["properties"]["kota"],
            "pct": sorted_rapid[0]["properties"]["rapid_cov_pct"],
        },
        "worst_rapid_kec": {
            "kecamatan": sorted_rapid[-1]["properties"]["kecamatan"],
            "kota": sorted_rapid[-1]["properties"]["kota"],
            "pct": sorted_rapid[-1]["properties"]["rapid_cov_pct"],
        },
        "best_all_kec": {
            "kecamatan": sorted_all[0]["properties"]["kecamatan"],
            "kota": sorted_all[0]["properties"]["kota"],
            "pct": sorted_all[0]["properties"]["all_cov_pct"],
        },
        "worst_all_kec": {
            "kecamatan": sorted_all[-1]["properties"]["kecamatan"],
            "kota": sorted_all[-1]["properties"]["kota"],
            "pct": sorted_all[-1]["properties"]["all_cov_pct"],
        },
        "modes": MODES,
        "presets": PRESET_PLACES,
    }
    return kept_stops, summary


def main() -> None:
    kec_features = fetch_kecamatan_boundaries()
    tj_stops, tj_source = fetch_transjakarta_gtfs()
    rail_stops = fetch_rail_stations()

    all_stops = rail_stops + tj_stops
    kept_stops, summary = assign_and_compute_coverage(kec_features, all_stops)
    summary["sources"] = {
        "transjakarta": tj_source,
        "rail": "OpenStreetMap Overpass + Verified Active MRT/LRT/KAI Registry",
        "boundaries": "DKI Jakarta Mainland Kecamatan GeoJSON (42 districts)",
        "isochrone": "Valhalla Pedestrian Routing Engine (OpenStreetMap)",
    }

    # Write kecamatan.geojson
    kec_fc = {"type": "FeatureCollection", "features": kec_features}
    (DATA_DIR / "kecamatan.geojson").write_text(json.dumps(kec_fc, ensure_ascii=False), encoding="utf-8")

    # Write stops.geojson (QGIS-ready)
    stop_features = [
        {
            "type": "Feature",
            "properties": {k: v for k, v in s.items() if k not in ("lat", "lon")},
            "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
        }
        for s in kept_stops
    ]
    stops_fc = {"type": "FeatureCollection", "features": stop_features}
    (DATA_DIR / "stops.geojson").write_text(json.dumps(stops_fc, ensure_ascii=False), encoding="utf-8")

    # Write compact stops.min.json for fast browser load
    stops_min = {
        "modes": [m["id"] for m in MODES],
        "stops": [
            [
                s["id"],
                s["name"],
                s["lat"],
                s["lon"],
                MODE_INDEX[s["mode"]],
                s["routes"],
                s["kecamatan"],
                1 if s["in_dki"] else 0,
            ]
            for s in kept_stops
        ],
    }
    (DATA_DIR / "stops.min.json").write_text(
        json.dumps(stops_min, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    # Write summary.json
    (DATA_DIR / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n=== BUILD COMPLETE ===")
    print(f"Kecamatan: {summary['kecamatan_count']} ({summary['total_area_km2']} km2)")
    print(f"DKI Stops: {summary['stops_in_dki']} (with 1.2km border: {summary['stops_total_with_border']})")
    print(f"Mode breakdown (DKI): {summary['mode_totals_dki']}")
    print(f"Citywide 15-min coverage -> Rapid: {summary['city_rapid_cov_pct']}% | All modes: {summary['city_all_cov_pct']}%")
    for fname in ("kecamatan.geojson", "stops.geojson", "stops.min.json", "summary.json"):
        sz = (DATA_DIR / fname).stat().st_size
        print(f"  data/{fname}: {sz/1024:.1f} KB")


if __name__ == "__main__":
    main()
