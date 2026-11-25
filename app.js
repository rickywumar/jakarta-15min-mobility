/* Jakarta 15-Minute Mobility Pulse */

const STATE = {
  summary: null,
  kecGeojson: null,
  stops: [], // { id, name, lat, lon, mode, modeIdx, routes, kec, inDki }
  modesById: {},
  enabledModes: new Set(["mrt", "lrt", "krl", "train", "tj_brt", "tj_nonbrt"]),
  mikroExplicit: false,
  choropleth: "none",
  compareCircle: false,
  theme: "light",
  map: null,
  tileLayer: null,
  tileOverlayLayer: null,
  canvasRenderer: null,
  kecLayer: null,
  stopsLayer: null,
  saLayer: null,
  circleLayer: null,
  pinMarker: null,
  currentPin: null, // { lat, lon, name, sub }
  saPolygons: null, // { 15: feature } for area/connectivity calculation & fallback
  saRoadEdges: null, // array of { minLat, maxLat, minLon, maxLon, coordsLatLon, duration }
  saMatches: [], // { stop, tier, walkMin }
  stopFilter: "all",
  sortCol: "rapid_cov_pct",
  sortDir: "desc",
  kotaFilter: "all",
  districtSearch: "",
  lastZoom: 12,
};

const MODE_ORDER = ["mrt", "lrt", "krl", "train", "tj_brt", "tj_nonbrt", "mikrotrans"];
const RAPID_SET = new Set(["mrt", "lrt", "krl", "train", "tj_brt"]);

const CHOROPLETH_META = {
  rapid_cov_pct: {
    label: "Rapid 15-min coverage %",
    minLabel: "0%",
    maxLabel: "100%",
    colors: ["#18275E", "#1F4E8C", "#1E7FB3", "#2BB5C0", "#34D399"],
    breaks: [20, 40, 60, 80],
    format: (v) => `${v}%`,
  },
  all_cov_pct: {
    label: "All-mode 15-min coverage %",
    minLabel: "0%",
    maxLabel: "100%",
    colors: ["#1B2859", "#24577A", "#2C858D", "#4AB88A", "#A3E635"],
    breaks: [40, 60, 75, 90],
    format: (v) => `${v}%`,
  },
  feeder_boost_pct: {
    label: "Mikrotrans feeder boost (% pts)",
    minLabel: "0 pts",
    maxLabel: "60+ pts",
    colors: ["#182452", "#2D3C7E", "#6B4E9B", "#C26D86", "#FF8C2E"],
    breaks: [10, 20, 35, 50],
    format: (v) => `+${v} pts`,
  },
  rapid_per_km2: {
    label: "Rapid stops per km²",
    minLabel: "0",
    maxLabel: "3.0+",
    colors: ["#16224F", "#243D84", "#2B6CB0", "#38BDF8", "#93E4FF"],
    breaks: [0.4, 0.9, 1.6, 2.4],
    format: (v) => `${v}/km²`,
  },
};

function getChoroplethColor(metric, value) {
  const meta = CHOROPLETH_META[metric];
  if (!meta) return "transparent";
  const v = Number(value) || 0;
  for (let i = 0; i < meta.breaks.length; i++) {
    if (v <= meta.breaks[i]) return meta.colors[i];
  }
  return meta.colors[meta.colors.length - 1];
}

async function init() {
  try {
    const [summaryRes, kecRes, stopsRes] = await Promise.all([
      fetch("data/summary.json"),
      fetch("data/kecamatan.geojson"),
      fetch("data/stops.min.json"),
    ]);

    if (!summaryRes.ok || !kecRes.ok || !stopsRes.ok) {
      throw new Error("Failed to load local data files.");
    }

    STATE.summary = await summaryRes.json();
    STATE.kecGeojson = await kecRes.json();
    const stopsCompact = await stopsRes.json();

    STATE.summary.modes.forEach((m) => {
      STATE.modesById[m.id] = m;
    });

    const modeNames = stopsCompact.modes;
    STATE.stops = stopsCompact.stops.map((row) => {
      const mode = modeNames[row[4]];
      return {
        id: row[0],
        name: row[1],
        lat: row[2],
        lon: row[3],
        modeIdx: row[4],
        mode,
        routes: row[5] || "",
        kec: row[6] || "",
        inDki: row[7] === 1,
      };
    });

    renderOverview();
    initMap();
    initControls();
    renderAtlas();
    renderDistrictsTable();

    // Auto-run first check on Bundaran HI so the user sees a live Service Area right away
    const firstPreset = STATE.summary.presets[0] || {
      name: "Bundaran HI",
      lat: -6.19496,
      lon: 106.82307,
    };
    try {
      await runServiceAreaCheck(firstPreset.lat, firstPreset.lon, firstPreset.name, "Central CBD · MRT + TJ Hub");
    } catch (saErr) {
      console.warn("Initial Service Area check error:", saErr);
    }
  } catch (err) {
    console.error(err);
    document.getElementById("diagnosis-headline").textContent =
      "Could not load transit data. Make sure you are serving this folder over HTTP (not file://).";
  }
}

function renderOverview() {
  const s = STATE.summary;
  document.getElementById("data-timestamp").textContent = `Dataset built · ${s.generated_at}`;
  document.getElementById("footer-meta").textContent = `${s.stops_in_dki.toLocaleString()} DKI stops · ${s.kecamatan_count} Kecamatan · ${s.generated_at}`;

  const bestR = s.best_rapid_kec;
  const worstR = s.worst_rapid_kec;
  const gapPts = (s.city_all_cov_pct - s.city_rapid_cov_pct).toFixed(1);

  document.getElementById("diagnosis-headline").innerHTML =
    `Across mainland DKI Jakarta (${s.total_area_km2.toFixed(0)} km²), <strong>${s.city_rapid_cov_pct}%</strong> of the urban area sits within ~15 minutes' walk of rapid transit (MRT, LRT, KRL, KAI, or TransJakarta BRT) — rising to <strong>${s.city_all_cov_pct}%</strong> (+${gapPts} pts) once Non-BRT and <strong>${s.mode_totals_dki.mikrotrans.toLocaleString()} Mikrotrans</strong> feeder stops are included. Rapid reach peaks in <strong>${bestR.kecamatan}</strong> (${bestR.pct}%) and drops to <strong>${worstR.pct}%</strong> in <strong>${worstR.kecamatan}</strong>.`;

  const m = s.mode_totals_dki;
  document.getElementById("kpi-rapid-stops").textContent = s.rapid_stops_in_dki.toLocaleString();
  document.getElementById("kpi-rapid-sub").textContent =
    `MRT ${m.mrt} · LRT ${m.lrt} · KRL ${m.krl} · Train ${m.train} · BRT ${m.tj_brt}`;
  document.getElementById("kpi-rapid-bar").style.width =
    `${Math.min(100, Math.round((s.rapid_stops_in_dki / Math.max(1, s.stops_in_dki)) * 100 * 3))}%`;

  document.getElementById("kpi-feeder-stops").textContent = s.feeder_stops_in_dki.toLocaleString();
  document.getElementById("kpi-feeder-sub").textContent =
    `Non-BRT ${m.tj_nonbrt.toLocaleString()} · Mikrotrans ${m.mikrotrans.toLocaleString()}`;
  document.getElementById("kpi-feeder-bar").style.width =
    `${Math.min(100, Math.round((s.feeder_stops_in_dki / Math.max(1, s.stops_in_dki)) * 100))}%`;

  document.getElementById("kpi-rapid-cov").textContent = `${s.city_rapid_cov_pct}%`;
  document.getElementById("kpi-rapid-cov-sub").textContent =
    `Highest: ${bestR.kecamatan} (${bestR.pct}%) · Lowest: ${worstR.kecamatan} (${worstR.pct}%)`;
  document.getElementById("kpi-rapid-cov-bar").style.width = `${s.city_rapid_cov_pct}%`;

  document.getElementById("kpi-all-cov").textContent = `${s.city_all_cov_pct}%`;
  document.getElementById("kpi-all-cov-sub").textContent =
    `Highest: ${s.best_all_kec.kecamatan} (${s.best_all_kec.pct}%) · Lowest: ${s.worst_all_kec.kecamatan} (${s.worst_all_kec.pct}%)`;
  document.getElementById("kpi-all-cov-bar").style.width = `${s.city_all_cov_pct}%`;
}

function initMap() {
  STATE.map = L.map("map", {
    center: [-6.2088, 106.8456],
    zoom: 12,
    zoomControl: true,
    preferCanvas: true,
  });

  STATE.canvasRenderer = L.canvas({ padding: 0.4 });
  setMapBasemap(STATE.theme);

  STATE.kecLayer = L.geoJSON(STATE.kecGeojson, {
    style: styleKecamatan,
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      layer.bindTooltip(
        `<strong>${p.kecamatan}</strong> (${p.kota})<br/>Rapid 15m: <b>${p.rapid_cov_pct}%</b> · All-mode: <b>${p.all_cov_pct}%</b><br/>Rail: ${p.cnt_rail} · BRT: ${p.cnt_tj_brt} · Mikrotrans: ${p.cnt_mikrotrans}`,
        { sticky: true }
      );
      layer.on("click", (e) => {
        runServiceAreaCheck(e.latlng.lat, e.latlng.lng, `${p.kecamatan} pin`, p.kota);
      });
    },
  }).addTo(STATE.map);

  STATE.circleLayer = L.featureGroup().addTo(STATE.map);
  STATE.saLayer = L.featureGroup().addTo(STATE.map);
  STATE.stopsLayer = L.layerGroup().addTo(STATE.map);

  STATE.map.on("click", (e) => {
    // Only triggers if click wasn't captured by a marker
    runServiceAreaCheck(e.latlng.lat, e.latlng.lng, "Dropped pin", `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`);
  });

  STATE.map.on("zoomend", () => {
    const z = STATE.map.getZoom();
    const crossedThreshold = (STATE.lastZoom < 13 && z >= 13) || (STATE.lastZoom >= 13 && z < 13);
    STATE.lastZoom = z;
    if (crossedThreshold && !STATE.mikroExplicit) {
      renderStopsOnMap();
    }
  });

  updateChoroplethLegend();
  renderStopsOnMap();
}

function setMapBasemap(theme) {
  if (STATE.tileLayer) {
    STATE.map.removeLayer(STATE.tileLayer);
    STATE.tileLayer = null;
  }
  if (STATE.tileOverlayLayer) {
    STATE.map.removeLayer(STATE.tileOverlayLayer);
    STATE.tileOverlayLayer = null;
  }

  const glStyle =
    theme === "dark"
      ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
      : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

  if (typeof L.maplibreGL === "function") {
    try {
      STATE.tileLayer = L.maplibreGL({
        style: glStyle,
        pane: "tilePane",
        interactive: false,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/about-carto/">CARTO</a>',
      }).addTo(STATE.map);
      return;
    } catch (e) {
      console.warn("MapLibre GL basemap failed, falling back to Esri Light Gray:", e);
    }
  }

  STATE.tileLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Tiles &copy; Esri", maxZoom: 16 }
  ).addTo(STATE.map);
  STATE.tileOverlayLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16 }
  ).addTo(STATE.map);
}

function styleKecamatan(feature) {
  const metric = STATE.choropleth;
  if (metric === "none") {
    return {
      color: STATE.theme === "dark" ? "rgba(148,173,255,0.22)" : "rgba(100,116,139,0.26)",
      weight: 0.9,
      fillOpacity: 0,
      fillColor: "transparent",
    };
  }
  const val = feature.properties[metric];
  return {
    color: STATE.theme === "dark" ? "rgba(210,225,255,0.32)" : "rgba(30,41,59,0.28)",
    weight: 1.0,
    fillColor: getChoroplethColor(metric, val),
    fillOpacity: 0.28,
  };
}

function refreshChoropleth() {
  if (STATE.kecLayer) {
    STATE.kecLayer.setStyle(styleKecamatan);
  }
  updateChoroplethLegend();
}

function updateChoroplethLegend() {
  const box = document.getElementById("choropleth-legend");
  const metric = STATE.choropleth;
  if (metric === "none" || !CHOROPLETH_META[metric]) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const meta = CHOROPLETH_META[metric];
  box.innerHTML = `
    <div><strong>${meta.label}</strong></div>
    <div class="choropleth-ramp">${meta.colors.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
    <div class="choropleth-labels"><span>${meta.minLabel}</span><span>${meta.maxLabel}</span></div>
  `;
}

function renderStopsOnMap() {
  if (!STATE.stopsLayer) return;
  STATE.stopsLayer.clearLayers();

  const zoom = STATE.map ? STATE.map.getZoom() : 12;
  const hasSA = Boolean(STATE.saRoadEdges || STATE.saPolygons);
  const matchMap = new Map();
  if (hasSA) {
    STATE.saMatches.forEach((m) => matchMap.set(m.stop.id, m));
  }

  for (const st of STATE.stops) {
    const matchInfo = matchMap.get(st.id);
    const isMatched = Boolean(matchInfo);

    if (st.mode === "mikrotrans") {
      const showMikro = STATE.mikroExplicit || zoom >= 14 || isMatched;
      if (!showMikro) continue;
    } else if (!STATE.enabledModes.has(st.mode) && !isMatched) {
      continue;
    }

    const modeMeta = STATE.modesById[st.mode];
    const isRail = st.mode === "mrt" || st.mode === "lrt" || st.mode === "krl" || st.mode === "train";

    if (hasSA && !isMatched) {
      // Muted neutral dots outside the 15-min walk so the road network & Positron basemap stay clean
      const mutedMarker = L.circleMarker([st.lat, st.lon], {
        renderer: STATE.canvasRenderer,
        radius: isRail ? 3.5 : 2.0,
        stroke: false,
        fillColor: STATE.theme === "dark" ? "#64748B" : "#94A3B8",
        fillOpacity: isRail ? 0.45 : 0.25,
      });
      mutedMarker.bindPopup(
        `<strong>${escapeHtml(st.name)}</strong><br/>` +
          `<span style="color:${modeMeta.color};font-weight:700">${modeMeta.label}</span> · ${escapeHtml(st.kec)}` +
          (st.routes ? `<br/><strong>Routes:</strong> ${escapeHtml(st.routes)}` : "") +
          `<br/><em>Outside 15-min walkable road network</em>`
      );
      mutedMarker.addTo(STATE.stopsLayer);
      continue;
    }

    const baseRadius = isRail ? 5.6 : st.mode === "tj_brt" ? 4.3 : st.mode === "tj_nonbrt" ? 3.1 : 2.5;
    const radius = isMatched ? baseRadius + 1.4 : baseRadius;

    const marker = L.circleMarker([st.lat, st.lon], {
      renderer: STATE.canvasRenderer,
      radius,
      color: "#FFFFFF",
      weight: isMatched ? 1.8 : 0.9,
      fillColor: modeMeta.color,
      fillOpacity: isMatched ? 0.96 : 0.78,
    });

    const walkInfo = matchInfo
      ? `<br/><strong>Walk time:</strong> ~${matchInfo.walkMin} min (${tierLabel(matchInfo.tier)})`
      : "";
    const routeLine = st.routes ? `<br/><strong>Routes:</strong> ${escapeHtml(st.routes)}` : "";
    marker.bindPopup(
      `<strong>${escapeHtml(st.name)}</strong><br/>` +
        `<span style="color:${modeMeta.color};font-weight:700">${modeMeta.label}</span> · ${escapeHtml(st.kec)}` +
        routeLine +
        walkInfo
    );
    marker.addTo(STATE.stopsLayer);
  }
}

function initControls() {
  // Theme toggle
  const themeBtn = document.getElementById("theme-toggle");
  themeBtn.addEventListener("click", () => {
    STATE.theme = STATE.theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", STATE.theme);
    document.getElementById("theme-icon").textContent = STATE.theme === "dark" ? "☀" : "☾";
    document.getElementById("theme-label").textContent = STATE.theme === "dark" ? "Light mode" : "Dark mode";
    setMapBasemap(STATE.theme);
    refreshChoropleth();
  });

  // Presets
  const presetBox = document.getElementById("preset-chips");
  STATE.summary.presets.forEach((p, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-chip" + (idx === 0 ? " active" : "");
    btn.textContent = p.name;
    btn.title = p.desc;
    btn.addEventListener("click", () => {
      document.querySelectorAll(".preset-chip").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
      runServiceAreaCheck(p.lat, p.lon, p.name, p.desc);
    });
    presetBox.appendChild(btn);
  });

  // Mode toggle pills
  const modeBox = document.getElementById("mode-toggles");
  MODE_ORDER.forEach((mid) => {
    const meta = STATE.modesById[mid];
    const isMikro = mid === "mikrotrans";
    const active = !isMikro;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mode-pill" + (active ? " active" : "");
    btn.innerHTML = `<span class="mode-dot" style="background:${meta.color}"></span>${meta.short}`;
    btn.title = isMikro
      ? "Mikrotrans auto-appears when zoomed in or inside Service Area; click to force citywide"
      : `Toggle ${meta.label}`;
    btn.addEventListener("click", () => {
      if (isMikro) {
        STATE.mikroExplicit = !STATE.mikroExplicit;
        btn.classList.toggle("active", STATE.mikroExplicit);
      } else {
        if (STATE.enabledModes.has(mid)) {
          STATE.enabledModes.delete(mid);
          btn.classList.remove("active");
        } else {
          STATE.enabledModes.add(mid);
          btn.classList.add("active");
        }
      }
      renderStopsOnMap();
    });
    modeBox.appendChild(btn);
  });

  // Choropleth select
  document.getElementById("choropleth-select").addEventListener("change", (e) => {
    STATE.choropleth = e.target.value;
    refreshChoropleth();
  });

  // Kota zoom
  document.getElementById("kota-select").addEventListener("change", (e) => {
    const val = e.target.value;
    if (val === "all") {
      STATE.map.fitBounds(STATE.kecLayer.getBounds(), { padding: [20, 20] });
      return;
    }
    const matching = [];
    STATE.kecLayer.eachLayer((l) => {
      if (l.feature.properties.kota === val) matching.push(l);
    });
    if (matching.length) {
      const grp = L.featureGroup(matching);
      STATE.map.fitBounds(grp.getBounds(), { padding: [24, 24] });
    }
  });

  // Straight-line buffer compare toggle
  document.getElementById("compare-circle-toggle").addEventListener("change", (e) => {
    STATE.compareCircle = e.target.checked;
    document.getElementById("legend-circle-item").classList.toggle("hidden", !STATE.compareCircle);
    renderCircleComparison();
  });

  // Clear SA
  document.getElementById("clear-sa-btn").addEventListener("click", clearServiceArea);

  // Stop list filter pills
  document.querySelectorAll("#stop-filter-pills .filter-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#stop-filter-pills .filter-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.stopFilter = btn.dataset.filter;
      renderReachableStopsList();
    });
  });

  initSearchAutocomplete();
}

const JAKARTA_LANDMARKS = [
  { name: "Grand Indonesia", sub: "Thamrin · Jakarta Pusat", lat: -6.19576, lon: 106.82145 },
  { name: "Plaza Indonesia", sub: "Thamrin · Jakarta Pusat", lat: -6.19324, lon: 106.82199 },
  { name: "Monas (National Monument)", sub: "Gambir · Jakarta Pusat", lat: -6.17539, lon: 106.82715 },
  { name: "SCBD (Sudirman Central Business District)", sub: "Kebayoran Baru · Jakarta Selatan", lat: -6.22563, lon: 106.80964 },
  { name: "Kota Tua Jakarta", sub: "Taman Sari · Jakarta Barat", lat: -6.13520, lon: 106.81330 },
  { name: "Senayan City", sub: "Tanah Abang · Jakarta Pusat", lat: -6.22719, lon: 106.79725 },
  { name: "Pondok Indah Mall", sub: "Kebayoran Lama · Jakarta Selatan", lat: -6.26546, lon: 106.78349 },
  { name: "Ancol Dreamland", sub: "Pademangan · Jakarta Utara", lat: -6.12563, lon: 106.83353 },
  { name: "Sarinah", sub: "Menteng · Jakarta Pusat", lat: -6.18736, lon: 106.82405 },
  { name: "Kuningan City / Mega Kuningan", sub: "Setiabudi · Jakarta Selatan", lat: -6.22866, lon: 106.82864 },
  { name: "Rawamangun Terminal", sub: "Pulogadung · Jakarta Timur", lat: -6.19352, lon: 106.88918 },
  { name: "Mangga Dua Square", sub: "Pademangan · Jakarta Utara", lat: -6.13695, lon: 106.83135 },
];

function findLocalPlaceMatches(q) {
  const ql = q.trim().toLowerCase();
  if (ql.length < 2) return [];
  const hits = [];
  const seen = new Set();

  const pushHit = (name, sub, lat, lon) => {
    const key = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ name, sub, lat, lon });
  };

  for (const lm of JAKARTA_LANDMARKS) {
    if (lm.name.toLowerCase().includes(ql)) pushHit(lm.name, lm.sub, lm.lat, lm.lon);
  }
  for (const p of STATE.summary?.presets || []) {
    if (p.name.toLowerCase().includes(ql)) pushHit(p.name, p.desc || "Jakarta preset", p.lat, p.lon);
  }
  for (const f of STATE.kecGeojson?.features || []) {
    const kec = f.properties.kecamatan;
    if (kec.toLowerCase().includes(ql)) {
      const c = turf.centerOfMass(f).geometry.coordinates;
      pushHit(`Kecamatan ${kec}`, `${f.properties.kota} · District center`, c[1], c[0]);
    }
  }
  for (const st of STATE.stops) {
    if (hits.length >= 6) break;
    if (st.name.toLowerCase().includes(ql)) {
      const meta = STATE.modesById[st.mode];
      pushHit(st.name, `${meta.short} · ${st.kec}`, st.lat, st.lon);
    }
  }
  return hits.slice(0, 6);
}

async function fetchWithTimeout(url, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeJakarta(q) {
  // 1. Nominatim (fast, reliable for Jakarta landmarks & addresses)
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q + ", Jakarta")}&viewbox=106.67,-6.07,107.01,-6.39&bounded=1&limit=6`;
    const res = await fetchWithTimeout(url, 5500);
    if (res.ok) {
      const rows = await res.json();
      if (rows.length) {
        return rows.map((r) => ({
          name: r.name || r.display_name.split(",")[0],
          sub: r.display_name.split(",").slice(1, 4).join(", ").trim(),
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon),
        }));
      }
    }
  } catch {
    // Fall through to Photon / local
  }
  // 2. Photon fallback
  try {
    const pRes = await fetchWithTimeout(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q + " Jakarta")}&lat=-6.2088&lon=106.8456&limit=5`,
      3000
    );
    if (pRes.ok) {
      const pJson = await pRes.json();
      if (pJson.features?.length) {
        return pJson.features.map((f) => {
          const p = f.properties || {};
          const [lon, lat] = f.geometry.coordinates;
          return {
            name: p.name || p.street || q,
            sub: [p.street, p.district, p.city || "Jakarta"].filter(Boolean).join(", "),
            lat,
            lon,
          };
        });
      }
    }
  } catch {
    // Fall through to local
  }
  return [];
}

function initSearchAutocomplete() {
  const input = document.getElementById("search-input");
  const dropdown = document.getElementById("search-results");
  const searchBtn = document.getElementById("search-btn");
  let debounceTimer = null;

  function renderDropdownItems(items) {
    if (!items.length) {
      dropdown.classList.add("hidden");
      return;
    }
    dropdown.innerHTML = items
      .map(
        (item, idx) => `<li data-idx="${idx}" data-lat="${item.lat}" data-lon="${item.lon}" data-name="${escapeHtml(item.name)}" data-sub="${escapeHtml(item.sub)}">
          <span class="sd-name">${escapeHtml(item.name)}</span>
          <span class="sd-sub">${escapeHtml(item.sub || "DKI Jakarta")}</span>
        </li>`
      )
      .join("");
    dropdown.classList.remove("hidden");
  }

  async function queryPlaces(q) {
    const clean = q.trim();
    if (clean.length < 2) {
      dropdown.classList.add("hidden");
      return;
    }
    const local = findLocalPlaceMatches(clean);
    if (local.length) {
      renderDropdownItems(local);
    }
    if (clean.length >= 3) {
      const remote = await geocodeJakarta(clean);
      if (input.value.trim() === clean && remote.length) {
        const merged = [...local];
        for (const r of remote) {
          if (!merged.some((m) => Math.abs(m.lat - r.lat) < 0.002 && Math.abs(m.lon - r.lon) < 0.002)) {
            merged.push(r);
          }
        }
        renderDropdownItems(merged.slice(0, 7));
      }
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => queryPlaces(input.value), 280);
  });

  dropdown.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li || li.dataset.empty) return;
    const lat = parseFloat(li.dataset.lat);
    const lon = parseFloat(li.dataset.lon);
    const name = li.dataset.name;
    const sub = li.dataset.sub;
    input.value = name;
    dropdown.classList.add("hidden");
    document.querySelectorAll(".preset-chip").forEach((el) => el.classList.remove("active"));
    runServiceAreaCheck(lat, lon, name, sub);
  });

  async function triggerSearchSubmit() {
    const q = input.value.trim();
    if (!q) return;
    dropdown.classList.add("hidden");
    setRoutingStatus("Searching address…", "busy");

    const remote = await geocodeJakarta(q);
    if (remote.length) {
      const hit = remote[0];
      runServiceAreaCheck(hit.lat, hit.lon, hit.name || q, hit.sub);
      return;
    }
    const local = findLocalPlaceMatches(q);
    if (local.length) {
      const hit = local[0];
      runServiceAreaCheck(hit.lat, hit.lon, hit.name, hit.sub);
      return;
    }
    setRoutingStatus("Place not found in Jakarta — try clicking the map", "warn");
  }

  searchBtn.addEventListener("click", triggerSearchSubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerSearchSubmit();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) {
      dropdown.classList.add("hidden");
    }
  });
}

function setRoutingStatus(text, tone = "") {
  const pill = document.getElementById("service-status");
  pill.textContent = text;
  pill.className = "routing-pill" + (tone ? ` ${tone}` : "");
}

function clearServiceArea() {
  STATE.saPolygons = null;
  STATE.saRoadEdges = null;
  STATE.saMatches = [];
  STATE.currentPin = null;
  STATE.saLayer.clearLayers();
  STATE.circleLayer.clearLayers();
  if (STATE.pinMarker) {
    STATE.map.removeLayer(STATE.pinMarker);
    STATE.pinMarker = null;
  }
  document.querySelectorAll(".preset-chip").forEach((el) => el.classList.remove("active"));
  document.getElementById("verdict-badge").textContent = "No active pin";
  document.getElementById("verdict-badge").className = "verdict-badge verdict-neutral";
  document.getElementById("place-title").textContent = "Click anywhere on Jakarta";
  document.getElementById("place-meta").textContent = "Or search an address / select a preset above";
  document.getElementById("verdict-desc").textContent =
    "We will compute a real 5, 10, and 15-minute pedestrian walkable road-network Service Area and list every reachable transit stop.";
  document.getElementById("metric-sa-area").textContent = "—";
  document.getElementById("metric-connectivity").textContent = "—";
  document.getElementById("metric-stops-count").textContent = "—";
  document.getElementById("mode-breakdown").innerHTML = "";
  document.getElementById("reachable-stops-list").innerHTML = "";
  setRoutingStatus("Cleared — click map or search");
  renderStopsOnMap();
}

async function runServiceAreaCheck(lat, lon, label, subtitle = "") {
  STATE.currentPin = { lat, lon, name: label, sub: subtitle };
  setRoutingStatus("Tracing walkable road network…", "busy");

  if (STATE.pinMarker) {
    STATE.pinMarker.setLatLng([lat, lon]);
  } else {
    const pinIcon = L.divIcon({
      className: "custom-walk-pin",
      html: `<div style="width:16px;height:16px;border-radius:50%;background:#FF8C2E;border:3px solid #FFFFFF;box-shadow:0 2px 10px rgba(0,0,0,0.45);"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    STATE.pinMarker = L.marker([lat, lon], { icon: pinIcon, draggable: true }).addTo(STATE.map);
    STATE.pinMarker.on("dragend", (e) => {
      const pos = e.target.getLatLng();
      document.querySelectorAll(".preset-chip").forEach((el) => el.classList.remove("active"));
      runServiceAreaCheck(pos.lat, pos.lng, "Dragged pin", `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`);
    });
  }

  let isFallback = false;
  let roadEdges = null;
  let polygons = null;

  const expReq = fetch("https://valhalla1.openstreetmap.de/expansion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [{ lat, lon }],
      costing: "pedestrian",
      action: "isochrone",
      contours: [{ time: 15 }],
      expansion_properties: ["duration"],
      dedupe: true,
      skip_opposites: true,
    }),
  });

  const isoReq = fetch("https://valhalla1.openstreetmap.de/isochrone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [{ lat, lon }],
      costing: "pedestrian",
      contours: [{ time: 15 }],
      polygons: true,
      generalize: 15,
    }),
  });

  const [expRes, isoRes] = await Promise.allSettled([expReq, isoReq]);

  if (isoRes.status === "fulfilled" && isoRes.value.ok) {
    try {
      const isoJson = await isoRes.value.json();
      polygons = extractContours(isoJson);
    } catch {
      polygons = null;
    }
  }

  if (expRes.status === "fulfilled" && expRes.value.ok) {
    try {
      const expJson = await expRes.value.json();
      roadEdges = parseExpansionRoads(expJson);
    } catch {
      roadEdges = null;
    }
  }

  if (roadEdges && roadEdges.length > 0) {
    STATE.saRoadEdges = roadEdges;
    STATE.saPolygons = polygons;
    drawRoadServiceArea(roadEdges);
    setRoutingStatus("Walkable road-network Service Area active", "ok");
  } else if (polygons && polygons[15]) {
    STATE.saRoadEdges = null;
    STATE.saPolygons = polygons;
    drawPolygonOutlineFallback(polygons);
    setRoutingStatus("Valhalla contour active (road graph unavailable)", "ok");
  } else {
    isFallback = true;
    STATE.saRoadEdges = null;
    polygons = buildFallbackContours(lat, lon);
    STATE.saPolygons = polygons;
    drawPolygonOutlineFallback(polygons);
    setRoutingStatus("Routing server busy — showing street-detour estimate", "warn");
  }

  renderCircleComparison();
  evaluateStopsInsideServiceArea(lat, lon, label, subtitle, isFallback);

  const saBounds = STATE.saLayer.getBounds();
  if (saBounds.isValid()) {
    STATE.map.fitBounds(saBounds, { padding: [36, 36], maxZoom: 15 });
  }
}

function parseExpansionRoads(geojson) {
  const edges = [];
  for (const f of geojson.features || []) {
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    const dur = f.properties && typeof f.properties.duration === "number" ? f.properties.duration : null;
    if (dur === null || dur > 900) continue;
    const raw = f.geometry.coordinates;
    if (!raw || raw.length < 2) continue;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    const coordsLatLon = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const lon = raw[i][0];
      const lat = raw[i][1];
      coordsLatLon[i] = [lat, lon];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    edges.push({ minLat, maxLat, minLon, maxLon, coordsLatLon, duration: dur });
  }
  return edges;
}

function drawRoadServiceArea(edges) {
  STATE.saLayer.clearLayers();
  const tier5 = [];
  const tier10 = [];
  const tier15 = [];

  for (const e of edges) {
    if (e.duration <= 300) tier5.push(e.coordsLatLon);
    else if (e.duration <= 600) tier10.push(e.coordsLatLon);
    else tier15.push(e.coordsLatLon);
  }

  if (tier15.length) {
    L.polyline(tier15, {
      renderer: STATE.canvasRenderer,
      color: "#EA580C",
      weight: 2.0,
      opacity: 0.72,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(STATE.saLayer);
  }
  if (tier10.length) {
    L.polyline(tier10, {
      renderer: STATE.canvasRenderer,
      color: "#0284C7",
      weight: 2.6,
      opacity: 0.85,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(STATE.saLayer);
  }
  if (tier5.length) {
    L.polyline(tier5, {
      renderer: STATE.canvasRenderer,
      color: "#059669",
      weight: 3.4,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(STATE.saLayer);
  }
}

function extractContours(geojson) {
  const out = {};
  for (const f of geojson.features || []) {
    const c = f.properties && (f.properties.contour ?? f.properties.time);
    if (c === 5 || c === 10 || c === 15) {
      out[c] = f;
    }
  }
  return out;
}

function buildFallbackContours(lat, lon) {
  const center = [lon, lat];
  return {
    5: turf.circle(center, 0.31, { steps: 48, units: "kilometers" }),
    10: turf.circle(center, 0.615, { steps: 48, units: "kilometers" }),
    15: turf.circle(center, 0.92, { steps: 48, units: "kilometers" }),
  };
}

function drawPolygonOutlineFallback(polygons) {
  STATE.saLayer.clearLayers();
  const styles = {
    15: { color: "#EA580C", weight: 2.0, fill: false },
    10: { color: "#0284C7", weight: 2.0, fill: false },
    5: { color: "#059669", weight: 2.2, fill: false },
  };
  [15, 10, 5].forEach((t) => {
    if (polygons[t]) {
      L.geoJSON(polygons[t], {
        style: styles[t],
        interactive: false,
      }).addTo(STATE.saLayer);
    }
  });
}

function renderCircleComparison() {
  STATE.circleLayer.clearLayers();
  if (!STATE.compareCircle || !STATE.currentPin) return;
  const circle = turf.circle([STATE.currentPin.lon, STATE.currentPin.lat], 1.2, {
    steps: 64,
    units: "kilometers",
  });
  L.geoJSON(circle, {
    style: {
      color: "#DC2626",
      weight: 1.8,
      dashArray: "6 6",
      fill: false,
    },
    interactive: false,
  }).addTo(STATE.circleLayer);
}

function findPinKecamatan(lat, lon) {
  const pt = turf.point([lon, lat]);
  for (const f of STATE.kecGeojson.features) {
    if (turf.booleanPointInPolygon(pt, f)) {
      return `${f.properties.kecamatan}, ${f.properties.kota}`;
    }
  }
  return "DKI Jakarta / Border";
}

function pointToSegmentMeters(plat, plon, coordsLatLon, mPerLat, mPerLon) {
  let minDist = Infinity;
  for (let i = 0; i < coordsLatLon.length - 1; i++) {
    const ax = (coordsLatLon[i][1] - plon) * mPerLon;
    const ay = (coordsLatLon[i][0] - plat) * mPerLat;
    const bx = (coordsLatLon[i + 1][1] - plon) * mPerLon;
    const by = (coordsLatLon[i + 1][0] - plat) * mPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
    const dist = Math.hypot(ax + t * dx, ay + t * dy);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function matchStopsToRoadEdges(pinLat, edges) {
  const mPerLat = 111320.0;
  const mPerLon = 111320.0 * Math.cos((pinLat * Math.PI) / 180);
  const cellDeg = 0.002;
  const grid = new Map();

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.minLat < minLat) minLat = e.minLat;
    if (e.maxLat > maxLat) maxLat = e.maxLat;
    if (e.minLon < minLon) minLon = e.minLon;
    if (e.maxLon > maxLon) maxLon = e.maxLon;

    const x0 = Math.floor(e.minLon / cellDeg);
    const x1 = Math.floor(e.maxLon / cellDeg);
    const y0 = Math.floor(e.minLat / cellDeg);
    const y1 = Math.floor(e.maxLat / cellDeg);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(e);
      }
    }
  }

  const pad = 0.001;
  const matches = [];
  const maxSnapMeters = 85.0;

  for (const st of STATE.stops) {
    if (st.lon < minLon - pad || st.lon > maxLon + pad || st.lat < minLat - pad || st.lat > maxLat + pad) {
      continue;
    }
    const cx = Math.floor(st.lon / cellDeg);
    const cy = Math.floor(st.lat / cellDeg);
    let bestWalkSec = Infinity;
    const seenEdges = new Set();

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const e of bucket) {
          if (seenEdges.has(e)) continue;
          seenEdges.add(e);
          const distM = pointToSegmentMeters(st.lat, st.lon, e.coordsLatLon, mPerLat, mPerLon);
          if (distM <= maxSnapMeters) {
            const totalSec = e.duration + distM / 1.33;
            if (totalSec < bestWalkSec) bestWalkSec = totalSec;
          }
        }
      }
    }

    if (bestWalkSec <= 945) {
      const clampedSec = Math.min(900, bestWalkSec);
      const tier = clampedSec <= 300 ? 5 : clampedSec <= 600 ? 10 : 15;
      const walkMin = Math.max(1, Math.round(clampedSec / 60));
      matches.push({ stop: st, tier, walkMin });
    }
  }
  return matches;
}

function evaluateStopsInsideServiceArea(lat, lon, label, subtitle, isFallback) {
  let matches = [];
  if (STATE.saRoadEdges && STATE.saRoadEdges.length > 0) {
    matches = matchStopsToRoadEdges(lat, STATE.saRoadEdges);
  } else if (STATE.saPolygons && STATE.saPolygons[15]) {
    const poly5 = STATE.saPolygons[5];
    const poly10 = STATE.saPolygons[10];
    const poly15 = STATE.saPolygons[15];
    const [minx, miny, maxx, maxy] = turf.bbox(poly15);
    for (const st of STATE.stops) {
      if (st.lon < minx || st.lon > maxx || st.lat < miny || st.lat > maxy) continue;
      const pt = turf.point([st.lon, st.lat]);
      let tier = null;
      if (poly5 && turf.booleanPointInPolygon(pt, poly5)) tier = 5;
      else if (poly10 && turf.booleanPointInPolygon(pt, poly10)) tier = 10;
      else if (turf.booleanPointInPolygon(pt, poly15)) tier = 15;
      if (tier !== null) {
        matches.push({ stop: st, tier, walkMin: tier });
      }
    }
  }

  matches.sort((a, b) => {
    if (a.walkMin !== b.walkMin) return a.walkMin - b.walkMin;
    const ar = RAPID_SET.has(a.stop.mode) ? 0 : 1;
    const br = RAPID_SET.has(b.stop.mode) ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.stop.modeIdx - b.stop.modeIdx;
  });

  STATE.saMatches = matches;
  renderStopsOnMap();

  const poly15 = STATE.saPolygons && STATE.saPolygons[15];
  const areaKm2 = poly15 ? turf.area(poly15) / 1_000_000 : null;
  const idealCircleArea = Math.PI * 1.2 * 1.2;
  const connectivityPct = areaKm2 !== null ? Math.min(100, Math.round((areaKm2 / idealCircleArea) * 100)) : null;

  const byMode = {};
  MODE_ORDER.forEach((m) => (byMode[m] = { count: 0, minTier: null }));
  matches.forEach(({ stop, tier }) => {
    byMode[stop.mode].count += 1;
    if (byMode[stop.mode].minTier === null || tier < byMode[stop.mode].minTier) {
      byMode[stop.mode].minTier = tier;
    }
  });

  const rapidCount = ["mrt", "lrt", "krl", "train", "tj_brt"].reduce((acc, m) => acc + byMode[m].count, 0);
  const railCount = ["mrt", "lrt", "krl", "train"].reduce((acc, m) => acc + byMode[m].count, 0);
  const feederCount = byMode.tj_nonbrt.count + byMode.mikrotrans.count;
  const activeModes = MODE_ORDER.filter((m) => byMode[m].count > 0).length;

  let verdictText = "";
  let verdictCls = "";
  let verdictDesc = "";

  if (railCount > 0 && byMode.tj_brt.count > 0 && activeModes >= 3) {
    verdictText = "15-Minute Multimodal Hub";
    verdictCls = "verdict-hub";
    verdictDesc = `High transit freedom: ${railCount} rail station${railCount > 1 ? "s" : ""}, ${byMode.tj_brt.count} TransJakarta BRT halte, and ${feederCount} feeder/Mikrotrans stops along walkable streets within 15 minutes.`;
  } else if (rapidCount > 0) {
    verdictText = "15-Minute Rapid Accessible";
    verdictCls = "verdict-rapid";
    verdictDesc = `Rapid transit is walkable here (${rapidCount} rapid stop${rapidCount > 1 ? "s" : ""}), backed by ${feederCount} feeder/Mikrotrans stops.`;
  } else if (feederCount > 0) {
    verdictText = "Feeder-Only Access (First/Last Mile Gap)";
    verdictCls = "verdict-feeder";
    verdictDesc = `No MRT, LRT, KRL, or TransJakarta BRT stop is reachable within 15 minutes on foot — riders rely on ${feederCount} Non-BRT/Mikrotrans stops to reach rapid corridors.`;
  } else {
    verdictText = "Transit Desert (15-Min Walk)";
    verdictCls = "verdict-desert";
    verdictDesc = "No mapped public transit stops fall along walkable streets inside this 15-minute Service Area.";
  }

  if (isFallback) {
    verdictDesc += " (Estimated using street-detour buffer while live Valhalla router was busy.)";
  }

  const kecLabel = findPinKecamatan(lat, lon);
  document.getElementById("verdict-badge").textContent = verdictText;
  document.getElementById("verdict-badge").className = `verdict-badge ${verdictCls}`;
  document.getElementById("place-title").textContent = label;
  document.getElementById("place-meta").textContent = `${kecLabel}${subtitle ? " · " + subtitle : ""}`;
  document.getElementById("verdict-desc").textContent = verdictDesc;

  document.getElementById("metric-sa-area").textContent = areaKm2 !== null ? `${areaKm2.toFixed(2)} km²` : "—";
  document.getElementById("metric-connectivity").textContent = isFallback
    ? "~59% est."
    : connectivityPct !== null
    ? `${connectivityPct}%`
    : "—";
  document.getElementById("metric-stops-count").textContent = matches.length.toLocaleString();

  const mb = document.getElementById("mode-breakdown");
  mb.innerHTML = MODE_ORDER.map((mid) => {
    const meta = STATE.modesById[mid];
    const info = byMode[mid];
    return `
      <div class="mode-card ${info.count === 0 ? "zero" : ""}">
        <span class="mode-card-left">
          <span class="mode-dot" style="background:${meta.color}"></span>
          <span>${meta.short}</span>
        </span>
        <span class="mode-card-right">
          <strong>${info.count}</strong>
          ${info.minTier ? ` · ≤${info.minTier}m` : ""}
        </span>
      </div>
    `;
  }).join("");

  renderReachableStopsList();
}

function renderReachableStopsList() {
  const ul = document.getElementById("reachable-stops-list");
  let list = STATE.saMatches;
  if (STATE.stopFilter === "5") {
    list = list.filter((m) => m.tier === 5);
  } else if (STATE.stopFilter === "rapid") {
    list = list.filter((m) => RAPID_SET.has(m.stop.mode));
  } else if (STATE.stopFilter === "mikrotrans") {
    list = list.filter((m) => m.stop.mode === "mikrotrans");
  }

  if (!list.length) {
    ul.innerHTML = `<li class="stop-item" style="cursor:default"><span class="stop-item-routes">No matching stops in this filter.</span></li>`;
    return;
  }

  ul.innerHTML = list
    .slice(0, 120)
    .map(({ stop, tier, walkMin }) => {
      const meta = STATE.modesById[stop.mode];
      const routesText = stop.routes ? escapeHtml(stop.routes) : meta.label;
      return `
        <li class="stop-item" data-lat="${stop.lat}" data-lon="${stop.lon}" data-name="${escapeHtml(stop.name)}" data-mode="${escapeHtml(meta.label)}" data-routes="${routesText}" data-tier="${tier}" data-walk="${walkMin}">
          <div>
            <div class="stop-item-name">
              <span class="mode-dot" style="background:${meta.color}"></span>
              <span>${escapeHtml(stop.name)}</span>
            </div>
            <div class="stop-item-routes">${meta.short} · ${routesText}</div>
          </div>
          <span class="tier-tag tier-${tier}">~${walkMin} min</span>
        </li>
      `;
    })
    .join("");

  ul.querySelectorAll(".stop-item[data-lat]").forEach((li) => {
    li.addEventListener("click", () => {
      const lat = parseFloat(li.dataset.lat);
      const lon = parseFloat(li.dataset.lon);
      STATE.map.setView([lat, lon], Math.max(STATE.map.getZoom(), 16));
      L.popup()
        .setLatLng([lat, lon])
        .setContent(`<strong>${li.dataset.name}</strong><br/>${li.dataset.mode}<br/>${li.dataset.routes}<br/><b>~${li.dataset.walk} min walk</b>`)
        .openOn(STATE.map);
    });
  });
}

function tierLabel(tier) {
  if (tier === 5) return "≤ 5 min";
  if (tier === 10) return "5–10 min";
  return "10–15 min";
}

/* Atlas (6 SVG Small Multiples) */
function renderAtlas() {
  const feats = STATE.kecGeojson.features;
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const f of feats) {
    const [b0, b1, b2, b3] = turf.bbox(f);
    if (b0 < minX) minX = b0;
    if (b1 < minY) minY = b1;
    if (b2 > maxX) maxX = b2;
    if (b3 > maxY) maxY = b3;
  }

  const W = 320;
  const H = 240;
  const pad = 12;
  const cosLat = Math.cos((-6.2 * Math.PI) / 180);
  const spanX = (maxX - minX) * cosLat;
  const spanY = maxY - minY;
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offsetX = (W - spanX * scale) / 2;
  const offsetY = (H - spanY * scale) / 2;

  function project(lon, lat) {
    const x = offsetX + (lon - minX) * cosLat * scale;
    const y = H - (offsetY + (lat - minY) * scale);
    return [x.toFixed(1), y.toFixed(1)];
  }

  function geomToPath(geom) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    return polys
      .map((poly) =>
        poly
          .map((ring) =>
            ring
              .map((pt, i) => {
                const [x, y] = project(pt[0], pt[1]);
                return `${i === 0 ? "M" : "L"}${x},${y}`;
              })
              .join("") + "Z"
          )
          .join(" ")
      )
      .join(" ");
  }

  const paths = feats.map((f) => ({ props: f.properties, d: geomToPath(f.geometry) }));
  const s = STATE.summary;

  const plates = [
    {
      title: "Rapid 15-Min Coverage",
      stat: `${s.city_rapid_cov_pct}% citywide · peaks in ${s.best_rapid_kec.kecamatan}`,
      metric: "rapid_cov_pct",
      colorFn: (p) => getChoroplethColor("rapid_cov_pct", p.rapid_cov_pct),
    },
    {
      title: "All-Mode 15-Min Coverage",
      stat: `${s.city_all_cov_pct}% citywide including feeders`,
      metric: "all_cov_pct",
      colorFn: (p) => getChoroplethColor("all_cov_pct", p.all_cov_pct),
    },
    {
      title: "Mikrotrans Feeder Boost",
      stat: `Adds +${(s.city_all_cov_pct - s.city_rapid_cov_pct).toFixed(1)} pts across Jakarta`,
      metric: "feeder_boost_pct",
      colorFn: (p) => getChoroplethColor("feeder_boost_pct", p.feeder_boost_pct),
    },
    {
      title: "Rail Stations (MRT · LRT · KRL)",
      stat: `${s.mode_totals_dki.mrt + s.mode_totals_dki.lrt + s.mode_totals_dki.krl + s.mode_totals_dki.train} stations inside DKI`,
      metric: "rapid_per_km2",
      colorFn: (p) => {
        if (p.cnt_rail === 0) return "#141F48";
        if (p.cnt_rail === 1) return "#274C8C";
        if (p.cnt_rail <= 3) return "#38BDF8";
        return "#FF6B6B";
      },
    },
    {
      title: "TransJakarta BRT Density",
      stat: `${s.mode_totals_dki.tj_brt} BRT halte across corridors 1–14`,
      metric: "rapid_per_km2",
      colorFn: (p) => {
        const d = p.brt_per_km2;
        if (d === 0) return "#141F48";
        if (d < 0.4) return "#20437E";
        if (d < 0.9) return "#2672A8";
        if (d < 1.6) return "#38BDF8";
        return "#93E4FF";
      },
    },
    {
      title: "Total Transit Density",
      stat: `${s.stops_in_dki.toLocaleString()} stops across ${s.total_area_km2.toFixed(0)} km²`,
      metric: "all_cov_pct",
      colorFn: (p) => {
        const d = p.stops_per_km2;
        if (d < 4) return "#16224F";
        if (d < 8) return "#255785";
        if (d < 13) return "#2B8A90";
        if (d < 18) return "#34D399";
        return "#A3E635";
      },
    },
  ];

  const grid = document.getElementById("atlas-grid");
  grid.innerHTML = "";
  plates.forEach((plate) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "atlas-card";
    const svgPaths = paths
      .map(
        (item) =>
          `<path d="${item.d}" fill="${plate.colorFn(item.props)}" stroke="rgba(255,255,255,0.22)" stroke-width="0.7"><title>${escapeHtml(item.props.kecamatan)}</title></path>`
      )
      .join("");

    card.innerHTML = `
      <h3>${plate.title}</h3>
      <div class="atlas-stat">${plate.stat}</div>
      <svg class="atlas-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">${svgPaths}</svg>
    `;
    card.addEventListener("click", () => {
      STATE.choropleth = plate.metric;
      document.getElementById("choropleth-select").value = plate.metric;
      refreshChoropleth();
      document.getElementById("checker").scrollIntoView({ behavior: "smooth" });
    });
    grid.appendChild(card);
  });
}

/* Districts Table */
function renderDistrictsTable() {
  const thead = document.querySelector("#districts-table thead");
  thead.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (STATE.sortCol === col) {
        STATE.sortDir = STATE.sortDir === "desc" ? "asc" : "desc";
      } else {
        STATE.sortCol = col;
        STATE.sortDir = col === "kecamatan" || col === "kota" ? "asc" : "desc";
      }
      thead.querySelectorAll("th").forEach((h) => {
        h.classList.remove("active-sort");
        h.textContent = h.textContent.replace(/ [▲▼]$/, "");
      });
      th.classList.add("active-sort");
      th.textContent += STATE.sortDir === "desc" ? " ▼" : " ▲";
      updateDistrictRows();
    });
  });

  document.getElementById("district-search").addEventListener("input", (e) => {
    STATE.districtSearch = e.target.value.trim().toLowerCase();
    updateDistrictRows();
  });

  document.querySelectorAll("#kota-filter-pills .filter-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#kota-filter-pills .filter-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.kotaFilter = btn.dataset.kota;
      updateDistrictRows();
    });
  });

  updateDistrictRows();
}

function updateDistrictRows() {
  const tbody = document.getElementById("districts-tbody");
  let rows = STATE.kecGeojson.features.map((f) => f.properties);

  if (STATE.kotaFilter !== "all") {
    rows = rows.filter((r) => r.kota === STATE.kotaFilter);
  }
  if (STATE.districtSearch) {
    rows = rows.filter(
      (r) =>
        r.kecamatan.toLowerCase().includes(STATE.districtSearch) ||
        r.kota.toLowerCase().includes(STATE.districtSearch)
    );
  }

  const col = STATE.sortCol;
  const dir = STATE.sortDir === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    const va = a[col];
    const vb = b[col];
    if (typeof va === "string") return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });

  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr data-kec="${escapeHtml(r.kecamatan)}">
        <td><strong>${escapeHtml(r.kecamatan)}</strong></td>
        <td>${escapeHtml(r.kota.replace("Jakarta ", ""))}</td>
        <td class="num">${r.area_km2.toFixed(1)}</td>
        <td class="num">
          <span class="bar-cell">
            <span class="mini-bar"><i style="width:${r.rapid_cov_pct}%"></i></span>
            <span>${r.rapid_cov_pct}%</span>
          </span>
        </td>
        <td class="num">
          <span class="bar-cell">
            <span class="mini-bar all"><i style="width:${r.all_cov_pct}%"></i></span>
            <span>${r.all_cov_pct}%</span>
          </span>
        </td>
        <td class="num">+${r.feeder_boost_pct} pts</td>
        <td class="num">${r.cnt_rail}</td>
        <td class="num">${r.cnt_tj_brt}</td>
        <td class="num">${r.cnt_mikrotrans}</td>
        <td class="num">${r.stops_per_km2.toFixed(1)}</td>
      </tr>
    `
    )
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      const kecName = tr.dataset.kec;
      STATE.kecLayer.eachLayer((layer) => {
        if (layer.feature.properties.kecamatan === kecName) {
          STATE.map.fitBounds(layer.getBounds(), { padding: [32, 32] });
          const center = layer.getBounds().getCenter();
          document.getElementById("checker").scrollIntoView({ behavior: "smooth" });
          runServiceAreaCheck(center.lat, center.lng, `${kecName} center`, layer.feature.properties.kota);
        }
      });
    });
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", init);
