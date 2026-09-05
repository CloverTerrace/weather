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


def load_profile(H) -> "Profile":
    """
    Download just the fields we need for this lat/lon and return a Profile
    with 1-D arrays (surface-to-top) of pressure, height, temperature,
    dewpoint, and wind components, all as MetPy pint.Quantity arrays.
    """
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

    return Profile(pressure=p, height=height, temperature=T, dewpoint=Td, u=u, v=v)


@dataclass
class Profile:
    pressure: "any"
    height: "any"
    temperature: "any"
    dewpoint: "any"
    u: "any"
    v: "any"


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
    """Full profile (for a skew-T or simple sounding chart on the frontend)."""
    rows = []
    for i in range(len(prof.pressure)):
        rows.append({
            "pressure_mb": round(float(prof.pressure[i].magnitude), 1),
            "height_m": round(float(prof.height[i].magnitude), 0),
            "temp_c": round(float(prof.temperature[i].magnitude), 1),
            "dewpoint_c": round(float(prof.dewpoint[i].magnitude), 1),
            "wind_u_kt": round(float(prof.u[i].to("knot").magnitude), 1),
            "wind_v_kt": round(float(prof.v[i].to("knot").magnitude), 1),
        })
    return rows


def main() -> int:
    H, cycle = find_latest_available_cycle()
    if H is None:
        log.error("No HRRR cycle found within %sh lookback -- leaving atmosphere.json untouched.",
                   MAX_CYCLE_LOOKBACK_HOURS)
        return 1

    cycle_iso = cycle.strftime("%Y-%m-%dT%H:00:00Z")

    # Idempotency check: skip the (slower) download + compute work entirely
    # if we already have this exact cycle written out.
    if OUTPUT_PATH.exists():
        try:
            existing = json.loads(OUTPUT_PATH.read_text())
            if existing.get("model_cycle") == cycle_iso:
                log.info("atmosphere.json already reflects cycle %s -- nothing to do.", cycle_iso)
                return 0
        except (json.JSONDecodeError, OSError):
            pass  # corrupt/missing existing file -- just proceed and overwrite

    prof = load_profile(H)
    params = compute_parameters(prof)

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model_cycle": cycle_iso,
        "model": "HRRR",
        "parameters": params,
        "profile": profile_to_json(prof),
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2))
    log.info("Wrote %s (cycle %s)", OUTPUT_PATH, cycle_iso)
    return 0


if __name__ == "__main__":
    sys.exit(main())
