#!/usr/bin/env python3
"""
fetch_atmosphere.py
--------------------
Pulls the most recent available HRRR analysis (fxx=0) for a single lat/lon,
builds an atmospheric profile with MetPy, and computes the instability/shear/
helicity parameters for the "Atmosphere" page. Writes data/atmosphere.json
(see the payload dict built in main() for the exact shape -- generated_at,
model_cycle, model, parameters{}, profile[]). Deliberately does NOT include
the station's lat/lon in the output: this is a public file the frontend
fetches directly, and the site otherwise keeps the exact station location
fuzzed (see the radar/map coordinates in index.html).

Design notes (read before editing):

- Idempotent by design. HRRR only updates once an hour, and GitHub Actions'
  `schedule` trigger is explicitly best-effort (can be delayed, can
  occasionally skip a run under load). So instead of assuming "this runs at
  the top of the hour," this script always asks Herbie for the freshest
  HRRR cycle that's actually posted, and only overwrites atmosphere.json if
  that cycle is newer than what's already committed. Whatever cadence the
  workflow actually runs at, the output just tracks "freshest we've seen."
  This means it's safe to call this from your *existing* 10-minute
  update-weather.yml step instead of standing up a separate hourly
  schedule -- most calls will be no-ops (same cycle, nothing to do),
  which is intentional and cheap (one small index-file check).

- Data source: Herbie (https://github.com/blaylockbk/Herbie), not raw
  Siphon/NCSS or hand-rolled NOMADS grib-filter URLs. Herbie already knows
  how to fall back across AWS/GCP/Azure (NODD) and NOMADS, and its search
  strings let you download only the fields you need via byte-range
  subsetting -- a few hundred KB per run, not a full model file.

- Pressure-level fields only (HRRR's isobaricInhPa fields), not native
  hybrid levels. Coarser vertical resolution than a true native-level
  sounding, but far simpler to work with in MetPy and plenty for
  CAPE/shear/SRH/lapse-rate purposes. If you want SPC-grade native-level
  soundings later, that's a bigger lift (native levels aren't on a clean
  pressure grid, need hybrid-to-pressure interpolation) -- flagging it as
  a possible v2, not attempting it here.

- True surface, not the lowest isobaric level. Isobaric levels are fixed
  pressure surfaces, not terrain-following, so for a station above sea
  level the 1000mb (and sometimes 975mb) level can sit below the actual
  ground -- an extrapolated value, not real atmosphere. load_profile()
  pulls HRRR's own terrain height + true 2m/10m surface fields (see
  _load_surface_point()), drops any isobaric level below that terrain
  height, and splices the real surface observation in as the new bottom
  of the profile before anything else (CAPE, shear, SRH, lapse rates,
  the frontend chart) is computed from it.

- NOT execution-tested. This sandbox has no network access to NOMADS/NODD,
  so Herbie's download step and the exact GRIB field names used in the
  search regex below could not be verified live. The field-name regex is
  written to match HRRR's standard wgrib2-style inventory strings, which
  have been stable for years, but confirm the .inventory() output looks
  sane on your first real run before trusting the numbers.

Requirements (install via pip, --break-system-packages if needed):
    herbie-data metpy xarray cfgrib numpy

cfgrib also needs the eccodes system library. On the GitHub Actions
ubuntu-latest runner:
    sudo apt-get install -y libeccodes0 libeccodes-dev
On the Actions image this is usually already present via conda-forge if
you install cfgrib through conda; via pip you may need the apt packages
above, or `pip install eccodes` (which now bundles the binary).
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch_atmosphere")

# ---------------------------------------------------------------------------
# Config -- the station's real coordinates. Safe to use the exact values
# here even though the radar/map on the frontend intentionally uses a
# fuzzed "general area" location instead: this script only ever writes
# computed numbers (CAPE, shear, SRH, lapse rates, a profile array) to
# atmosphere.json, never the lat/lon itself, so nothing coordinate-shaped
# reaches the page or a map marker.
# ---------------------------------------------------------------------------
STATION_LAT = 40.610380
STATION_LON = -80.277123
OUTPUT_PATH = Path("data/atmosphere.json")

# How far back to search for a usable HRRR cycle if the very latest one
# isn't posted yet (NODD/NOMADS lag is usually 45-70 min after cycle time).
MAX_CYCLE_LOOKBACK_HOURS = 4

# Pressure levels to request (mb). HRRR pressure-level grids go from 1000mb
# up to 50mb; we don't need the full stratospheric stack for CAPE/shear/SRH,
# so this is trimmed to the troposphere + a little headroom.
PRESSURE_LEVELS_MB = [
    1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700,
    675, 650, 625, 600, 575, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100,
]


def find_latest_available_cycle():
    """
    Ask Herbie for the most recent HRRR cycle (fxx=0, i.e. the analysis,
    not a forecast hour) that actually has a pressure-level ('prs') file
    posted somewhere Herbie knows how to look. Walks backward hour by hour
    up to MAX_CYCLE_LOOKBACK_HOURS until it finds one.

    Returns a (Herbie_object, cycle_datetime_utc) tuple, or (None, None) if
    nothing was found in the lookback window (rare -- would mean a real
    upstream outage).
    """
    from herbie import Herbie

    now = datetime.now(timezone.utc)
    # Round down to the top of the current hour, then walk backward.
    cycle = now.replace(minute=0, second=0, microsecond=0)

    for _ in range(MAX_CYCLE_LOOKBACK_HOURS + 1):
        log.info("Checking HRRR cycle %sZ ...", cycle.strftime("%Y-%m-%d %H:00"))
        try:
            H = Herbie(
                cycle.strftime("%Y-%m-%d %H:00"),
                model="hrrr",
                product="prs",   # pressure-level product
                fxx=0,           # analysis, not a forecast lead time
                # Skip NOMADS: it serves the raw GRIB for very-fresh cycles
                # but doesn't reliably have a matching .idx file yet, and
                # Herbie's subset download requires that index (confirmed
                # against a real run: "No index file was found... Download
                # the full file first" -- not a fluke). AWS/Google/Azure
                # (the actual NOAA Open Data Dissemination partners) always
                # publish grib+idx together, so restricting to those three
                # avoids the failure mode instead of catching it after the fact.
                priority=["aws", "google", "azure"],
            )
            if H.grib is not None:
                log.info("Found usable cycle: %sZ (source: %s)", cycle, H.grib_source)
                return H, cycle
        except Exception as exc:  # Herbie raises a mix of exception types
            log.info("  not available yet (%s)", exc)

        cycle -= timedelta(hours=1)

    return None, None


def _nearest_grid_indices(ds, lat, lon):
    """
    HRRR's native grid is a Lambert Conformal Conic projection, not a plain
    lat/lon grid -- cfgrib exposes 'latitude'/'longitude' as 2-D coordinates
    that vary across BOTH grid axes, not a clean 1-D axis. That means
    `.sel(latitude=..., longitude=..., method="nearest")` can't build an
    index at all (xarray raises "Could not automatically create PandasIndex
    for coord 'latitude' with 2 dimensions" -- confirmed against a real
    HRRR run, not theoretical). The fix: brute-force the nearest grid cell
    by distance across the 2-D lat/lon fields, then select by integer
    position instead of by coordinate value. Dimension names aren't
    hardcoded ('y'/'x' vs 'yc'/'xc' vs other cfgrib conventions vary), read
    them off the coordinate itself so this works regardless.
    """
    import numpy as np

    lat2d = ds["latitude"].values
    lon2d = ds["longitude"].values
    lon_target = lon % 360  # HRRR longitudes run 0-360

    # Planar distance in degrees is plenty precise at HRRR's ~3km spacing
    # (no need for a full haversine at this scale).
    dist2 = (lat2d - lat) ** 2 + (lon2d - lon_target) ** 2
    flat_idx = np.argmin(dist2)
    iy, ix = np.unravel_index(flat_idx, dist2.shape)

    dim_y, dim_x = ds["latitude"].dims  # e.g. ('y', 'x') -- read, not assumed
    return {dim_y: int(iy), dim_x: int(ix)}


def _load_surface_point(H) -> dict:
    """
    Pull HRRR's own terrain height plus true near-surface fields (2m temp/
    dewpoint, 10m wind, surface pressure) for this grid cell.

    Why this is a SEPARATE Herbie fetch rather than folded into the
    isobaric search in load_profile(): cfgrib names fields by GRIB
    shortName, and the isobaric temperature/dewpoint/wind fields share
    shortNames ('t', 'dpt', 'u', 'v') with these surface-level fields --
    merging both into one Dataset lets one silently clobber the other.
    Keeping them as two independent subsets avoids that entirely.

    Field-name mapping used below (standard cfgrib/ecCodes shortNames for
    these GRIB2 parameters -- stable across models, but like the rest of
    this script's field access, worth confirming against a real
    `sfc_point.data_vars` on first run rather than trusting blindly):
        HGT:surface            -> orog  (model terrain height, m MSL)
        PRES:surface            -> sp    (Pa)
        TMP:2 m above ground    -> t2m   (K)
        DPT:2 m above ground    -> d2m   (K)
        UGRD:10 m above ground  -> u10   (m/s)
        VGRD:10 m above ground  -> v10   (m/s)
    """
    import xarray as xr
    from metpy.units import units

    search = (
        r":HGT:surface:|:PRES:surface:|:TMP:2 m above ground:"
        r"|:DPT:2 m above ground:|:(?:UGRD|VGRD):10 m above ground:"
    )
    ds = H.xarray(search, remove_grib=True)
    merged = xr.merge(ds, compat="override") if isinstance(ds, list) else ds

    indexers = _nearest_grid_indices(merged, STATION_LAT, STATION_LON)
    point = merged.isel(indexers)

    missing = [name for name in ("orog", "sp", "t2m", "d2m", "u10", "v10") if name not in point]
    if missing:
        # Don't guess at alternate names silently -- log what's actually
        # there so a real run's logs tell you exactly what to fix, same
        # spirit as the other "confirmed against a real run" notes above.
        log.warning(
            "Surface fetch missing expected var(s) %s -- available: %s",
            missing, list(point.data_vars),
        )

    return {
        "terrain_m": float(point["orog"].values),
        "pressure_mb": float(point["sp"].values) / 100.0,  # Pa -> hPa
        "temp_c": float((point["t2m"].values * units.kelvin).to("degC").magnitude),
        "dewpoint_c": float((point["d2m"].values * units.kelvin).to("degC").magnitude),
        "u_ms": float(point["u10"].values),
        "v_ms": float(point["v10"].values),
    }


def load_profile(H) -> "Profile":
    """
    Download just the fields we need for this lat/lon and return a Profile
    with 1-D arrays (surface-to-top) of pressure, height, temperature,
    dewpoint, and wind components, all as MetPy pint.Quantity arrays --
    with the true surface (not a below-ground isobaric extrapolation)
    spliced in as the bottom point. See _load_surface_point() for why.
    """
    import numpy as np
    import xarray as xr
    import metpy.calc as mpcalc
    from metpy.units import units

    # Search string matches TMP/DPT/UGRD/VGRD/HGT on isobaric levels.
    # HRRR's wgrib2 inventory labels these like "500 mb" per level; Herbie's
    # xarray() groups same-variable-different-level fields into one
    # DataArray with an `isobaricInhPa` dimension automatically via cfgrib.
    search = r":(?:TMP|DPT|UGRD|VGRD|HGT):\d+ mb:"
    ds = H.xarray(search, remove_grib=True)

    # H.xarray() can return either one Dataset or a list of Datasets
    # (one per distinct grid/level-type cfgrib finds) -- normalize to one.
    if isinstance(ds, list):
        merged = xr.merge(ds, compat="override")
    else:
        merged = ds

    indexers = _nearest_grid_indices(merged, STATION_LAT, STATION_LON)
    point = merged.isel(indexers)

    # Sort ascending by pressure descending (surface first) -- MetPy's
    # sounding functions expect pressure decreasing with height, i.e.
    # the array ordered from the ground up.
    point = point.sortby("isobaricInhPa", ascending=False)

    p = (point["isobaricInhPa"].values * units.hPa)
    T = (point["t"].values * units.kelvin).to("degC")
    Td = mpcalc.dewpoint_from_relative_humidity(T, point.get("r", None)) \
        if "r" in point else (point["dpt"].values * units.kelvin).to("degC")
    height = point["gh"].values * units.meter if "gh" in point else point["z"].values * units.meter
    u = point["u"].values * units("m/s")
    v = point["v"].values * units("m/s")

    # ---------------------------------------------------------------
    # Splice in the true surface. HRRR's isobaric levels are fixed
    # PRESSURE surfaces, not terrain-following -- for any station above
    # roughly sea level, the lowest one or two of them (1000mb, and on
    # low-pressure days sometimes 975mb) sit BELOW the model's actual
    # terrain. HRRR still returns a temperature/dewpoint/wind there, but
    # it's an extrapolation into the ground, not real atmosphere.
    # Confirmed against this station's real elevation (~287m): the
    # previously-reported "surface" height of ~105m was just the
    # textbook height of the 1000mb surface everywhere on Earth, not
    # this station's ground.
    #
    # Fix: drop every isobaric level at or below the model's own terrain
    # height, then prepend a real surface observation (terrain height,
    # 2m temp/dewpoint, 10m wind, surface pressure) as the new bottom of
    # the profile -- the same approach SPC-style soundings use.
    # ---------------------------------------------------------------
    sfc = _load_surface_point(H)

    keep = height.magnitude > sfc["terrain_m"]
    if not keep.any():
        # Pathological (e.g. a very-low-pressure day pushes even 700mb
        # underground) -- fall back to keeping everything rather than
        # emitting an empty profile.
        log.warning("All isobaric levels fell below terrain height (%.0fm) -- keeping full stack.", sfc["terrain_m"])
        keep = np.ones_like(height.magnitude, dtype=bool)

    p, height, T, Td, u, v = (arr[keep] for arr in (p, height, T, Td, u, v))

    p = np.concatenate([[sfc["pressure_mb"]], p.magnitude]) * units.hPa
    height = np.concatenate([[sfc["terrain_m"]], height.magnitude]) * units.meter
    T = np.concatenate([[sfc["temp_c"]], T.to("degC").magnitude]) * units.degC
    Td = np.concatenate([[sfc["dewpoint_c"]], Td.to("degC").magnitude]) * units.degC
    u = np.concatenate([[sfc["u_ms"]], u.to("m/s").magnitude]) * units("m/s")
    v = np.concatenate([[sfc["v_ms"]], v.to("m/s").magnitude]) * units("m/s")

    return Profile(pressure=p, height=height, temperature=T, dewpoint=Td, u=u, v=v,
                    elevation_m=sfc["terrain_m"])


@dataclass
class Profile:
    pressure: "any"
    height: "any"
    temperature: "any"
    dewpoint: "any"
    u: "any"
    v: "any"
    elevation_m: float


def compute_parameters(prof: Profile) -> dict:
    """
    Run the actual MetPy calculations. Returns a plain dict of floats
    (already stripped of units, in the units named by each key) ready to
    drop into JSON.
    """
    import metpy.calc as mpcalc
    from metpy.units import units

    p, z, T, Td, u, v = (
        prof.pressure, prof.height, prof.temperature, prof.dewpoint, prof.u, prof.v,
    )

    out = {}

    def r(value, digits):
        """round() a pint/numpy scalar down to a plain JSON-safe Python
        float. GRIB data is float32 -- round() on a numpy float32 returns
        another numpy float32, and Python's json module can't serialize
        ANY numpy numeric type (confirmed against a real run: this was
        the actual cause of the 'Object of type float32 is not JSON
        serializable' failure, not the rounding itself)."""
        return round(float(value), digits)

    # --- CAPE / CIN -------------------------------------------------
    sb_cape, sb_cin = mpcalc.surface_based_cape_cin(p, T, Td)
    out["sbcape_j_kg"] = r(sb_cape.to("J/kg").magnitude, 0)
    out["sbcin_j_kg"] = r(sb_cin.to("J/kg").magnitude, 0)

    ml_cape, ml_cin = mpcalc.mixed_layer_cape_cin(p, T, Td, depth=100 * units.hPa)
    out["mlcape_j_kg"] = r(ml_cape.to("J/kg").magnitude, 0)
    out["mlcin_j_kg"] = r(ml_cin.to("J/kg").magnitude, 0)

    # --- Storm motion + helicity -------------------------------------
    try:
        rm, lm, mean_wind = mpcalc.bunkers_storm_motion(p, u, v, z)
        srh_1km = mpcalc.storm_relative_helicity(z, u, v, depth=1 * units.km, storm_u=rm[0], storm_v=rm[1])
        srh_3km = mpcalc.storm_relative_helicity(z, u, v, depth=3 * units.km, storm_u=rm[0], storm_v=rm[1])
        out["srh_0_1km_m2_s2"] = r(srh_1km[0].to("m^2/s^2").magnitude, 0)
        out["srh_0_3km_m2_s2"] = r(srh_3km[0].to("m^2/s^2").magnitude, 0)
        out["bunkers_right_mover_kt"] = r(rm[0].to("knot").magnitude, 1)
    except Exception as exc:
        log.warning("Storm motion / SRH calc failed: %s", exc)
        out["srh_0_1km_m2_s2"] = None
        out["srh_0_3km_m2_s2"] = None

    # --- Bulk shear ----------------------------------------------------
    shear_1km_u, shear_1km_v = mpcalc.bulk_shear(p, u, v, height=z, depth=1 * units.km)
    shear_6km_u, shear_6km_v = mpcalc.bulk_shear(p, u, v, height=z, depth=6 * units.km)
    out["shear_0_1km_kt"] = r(mpcalc.wind_speed(shear_1km_u, shear_1km_v).to("knot").magnitude, 1)
    out["shear_0_6km_kt"] = r(mpcalc.wind_speed(shear_6km_u, shear_6km_v).to("knot").magnitude, 1)

    # --- Lapse rates -----------------------------------------------
    # 0-3km AGL lapse rate: simple ΔT/Δz against height AGL.
    agl = z - z[0]
    try:
        idx_3km = int(np.argmin(np.abs(agl.to("km").magnitude - 3.0)))
        dz = float((z[idx_3km] - z[0]).to("km").magnitude)
        dT = float((T[0] - T[idx_3km]).to("delta_degC").magnitude)
        out["lapse_rate_0_3km_c_km"] = round(dT / dz, 2) if dz > 0 else None
    except Exception as exc:
        log.warning("0-3km lapse rate calc failed: %s", exc)
        out["lapse_rate_0_3km_c_km"] = None

    # 700-500mb lapse rate (the classic "mid-level steepness" SPC metric).
    # NOTE: there is no mpcalc.lapse_rate(bottom=..., depth=...) helper in
    # MetPy's actual API (confirmed against a real run: AttributeError,
    # not a fluke) -- this is computed directly rather than pretending
    # there's a built-in to fall back FROM.
    try:
        i700 = int(np.argmin(np.abs(p.magnitude - 700)))
        i500 = int(np.argmin(np.abs(p.magnitude - 500)))
        dz = float((z[i500] - z[i700]).to("km").magnitude)
        dT = float((T[i700] - T[i500]).to("delta_degC").magnitude)
        out["lapse_rate_700_500mb_c_km"] = round(dT / dz, 2) if dz else None
    except Exception as exc:
        log.warning("700-500mb lapse rate calc failed: %s", exc)
        out["lapse_rate_700_500mb_c_km"] = None

    return out


def profile_to_json(prof: Profile) -> list:
    """Full profile (for a skew-T or simple sounding chart on the frontend).

    height_m stays MSL (matches the raw model field, useful for anyone
    cross-checking against a real skew-T). height_agl_m is height above
    THIS station's ground (height_m - prof.elevation_m) -- that's what
    the frontend chart plots now, so the visible profile starts at 0
    instead of at an arbitrary MSL offset.
    """
    rows = []
    for i in range(len(prof.pressure)):
        height_m = float(prof.height[i].magnitude)
        rows.append({
            "pressure_mb": round(float(prof.pressure[i].magnitude), 1),
            "height_m": round(height_m, 0),
            "height_agl_m": round(height_m - prof.elevation_m, 0),
            "temp_c": round(float(prof.temperature[i].magnitude), 1),
            "dewpoint_c": round(float(prof.dewpoint[i].magnitude), 1),
            "wind_u_kt": round(float(prof.u[i].to("knot").magnitude), 1),
            "wind_v_kt": round(float(prof.v[i].to("knot").magnitude), 1),
        })
    return rows


CAPE_HISTORY_MAX_ENTRIES = 24  # ~24 HRRR cycles = 1 day of hourly readings,
                                 # comfortably covering the main page's 3h
                                 # trend window and 6h sparkline window with
                                 # room to spare


def build_cape_history(existing_payload: dict, cycle_iso: str, params: dict) -> list:
    """
    Append this cycle's CAPE reading to whatever history already exists in
    the previous atmosphere.json, trimmed to CAPE_HISTORY_MAX_ENTRIES.

    Mirrors fetch_aurora.py's rolling-history approach for its Kp trend --
    same idea, applied here so the main page's existing CAPE trend
    arrow/sparkline (previously fed by fetch_cape.py's Open-Meteo history)
    keeps working once it switches to reading HRRR CAPE from this file
    instead. This only ever gets called when main() is about to write a
    genuinely NEW cycle (the idempotency check above returns early
    otherwise), so history naturally grows once per real HRRR cycle, not
    once per workflow run.
    """
    history = existing_payload.get("cape_history") or []
    # defensive: drop anything malformed rather than let one bad entry
    # break every subsequent run.
    history = [h for h in history if isinstance(h, dict) and h.get("time")]

    history.append({
        "time": cycle_iso,
        "sbcape_j_kg": params.get("sbcape_j_kg"),
        "mlcape_j_kg": params.get("mlcape_j_kg"),
    })

    # de-dupe by cycle time (defends against a manual re-run of the same
    # cycle somehow reaching this point) and keep the most recent entries.
    seen = set()
    deduped = []
    for entry in reversed(history):
        if entry["time"] in seen:
            continue
        seen.add(entry["time"])
        deduped.append(entry)
    deduped.reverse()

    return deduped[-CAPE_HISTORY_MAX_ENTRIES:]


def main() -> int:
    H, cycle = find_latest_available_cycle()
    if H is None:
        log.error("No HRRR cycle found within %sh lookback -- leaving atmosphere.json untouched.",
                   MAX_CYCLE_LOOKBACK_HOURS)
        return 1

    cycle_iso = cycle.strftime("%Y-%m-%dT%H:00:00Z")

    # Read whatever's already there once, up front -- used both for the
    # idempotency check below AND (if we do proceed) as the base for
    # cape_history, so this is the only place the existing file gets read.
    existing_payload = {}
    if OUTPUT_PATH.exists():
        try:
            existing_payload = json.loads(OUTPUT_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            existing_payload = {}  # corrupt/missing -- proceed as if empty

    # Idempotency check: skip the (slower) download + compute work entirely
    # if we already have this exact cycle written out.
    if existing_payload.get("model_cycle") == cycle_iso:
        log.info("atmosphere.json already reflects cycle %s -- nothing to do.", cycle_iso)
        return 0

    prof = load_profile(H)
    params = compute_parameters(prof)
    cape_history = build_cape_history(existing_payload, cycle_iso, params)

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model_cycle": cycle_iso,
        "model": "HRRR",
        # Station elevation (m), used by the frontend chart caption and
        # already implied by every height_agl_m value below -- not
        # coordinate-shaped, so this doesn't touch the lat/lon-fuzzing
        # the rest of the site does for the map/radar.
        "station_elevation_m": round(prof.elevation_m),
        "parameters": params,
        "cape_history": cape_history,
        "profile": profile_to_json(prof),
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2))
    log.info("Wrote %s (cycle %s, %d cape_history entries)", OUTPUT_PATH, cycle_iso, len(cape_history))
    return 0


if __name__ == "__main__":
    sys.exit(main())
