#!/usr/bin/env python3
"""
build the merged SPC/NWS product feed used by the weather dashboard.

sources:
  * NWS active alerts at the Clover Terrace point (watches)
  * SPC current Mesoscale Discussion index/products
  * NWS API recent products for WFO Pittsburgh (PBZ)

output:
  data/nws_products.json

"""

from __future__ import annotations

import html
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

LAT = 40.604
LON = -80.286
WFO = "PBZ"

USER_AGENT = "(clover-terrace-weather-station, https://cloverterrace.github.io/weather/)"
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/geo+json, application/ld+json, application/json, text/html;q=0.9, */*;q=0.8",
}

ALERTS_URL = f"https://api.weather.gov/alerts/active?point={LAT},{LON}"
NWS_PRODUCTS_URL = "https://api.weather.gov/products"
SPC_MD_INDEX = "https://www.spc.noaa.gov/products/md/"

# Standard NWS boilerplate that opens the DAY ONE section of nearly every
# Hazardous Weather Outlook, regardless of what's actually happening. It's
# fine inside the full "curated details" text, but it must not be allowed to
# eat the whole hazard/summary preview budget -- otherwise the at-a-glance
# card shows this disclaimer instead of the specific hazard that follows it.
GENERIC_HWO_BOILERPLATE_RE = re.compile(
    r"Please listen to NOAA Weather Radio or go to weather\.gov(?: on the Internet)? "
    r"for more information about the following hazards\.\s*",
    re.I,
)


def strip_generic_lead(text: str) -> str:
    """Remove the generic NOAA-radio disclaimer sentence so summary/hazard
    previews lead with the actual, product-specific content instead."""
    if not text:
        return text
    stripped = GENERIC_HWO_BOILERPLATE_RE.sub("", text)
    return re.sub(r"\s+", " ", stripped).strip()


# Keep the local feed focused on products a spotter actually benefits from.
NWS_UPDATE_CODES = {
    "AFD": "Area Forecast Discussion",
    "HWO": "Hazardous Weather Outlook",
    "SPS": "Special Weather Statement",
    "SVS": "Severe Weather Statement",
    "PNS": "Public Information Statement",
    "NPW": "Non-Precipitation Weather Products",
    "FFA": "Flood Watch / Area Flood Products",
    "FLS": "Flood Statement",
    "RFW": "Red Flag Warning",
}

# keep the storm desk updated with active watches, active/recent SPC
# mesoscale discussions, and only the newest local NWS products.
MD_RECENT_HOURS = 8
NWS_RECENT_HOURS = 18
MAX_MDS = 5
MAX_NWS_UPDATES = 7

# SPC mesoscale discussions are issued nationwide, so the recent-numbers
# index page has to be scanned deeper than the final local list (MAX_MDS)
# to find the handful, if any, that actually concern this station's WFO.
# Recency short-circuits the scan (see fetch_mesoscale_discussions), so this
# is a ceiling on worst-case fetches during a busy nationwide severe day,
# not the typical number actually retrieved.
MD_SCAN_POOL_SIZE = 20

# fallback radius used only when an MD's ATTN...WFO... line can't be parsed
# (rare) -- see md_is_local() below for why ATTN is the primary signal.
MD_LOCAL_FALLBACK_MILES = 60

BOILERPLATE_PATTERNS = [
    r"^\s*WEATHER SERVICE.*$",
    r"^\s*NATIONAL WEATHER SERVICE.*$",
    r"^\s*SPC MESOSCALE DISCUSSION.*$",
    r"^\s*THE NATIONAL WEATHER SERVICE.*$",
]


class TextExtractor(HTMLParser):
    """Extract the actual product body when the source page wraps it in HTML."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0
        self._pre_depth = 0
        self._pre_parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in {"script", "style", "noscript"}:
            self._skip += 1
        elif tag == "pre":
            self._pre_depth += 1

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "style", "noscript"} and self._skip:
            self._skip -= 1
        elif tag == "pre" and self._pre_depth:
            self._pre_depth -= 1

    def handle_data(self, data):
        if self._skip:
            return
        if self._pre_depth:
            self._pre_parts.append(data)
        else:
            text = data.strip()
            if text:
                self.parts.append(text)

    def result(self) -> str:
        if self._pre_parts:
            return "".join(self._pre_parts)
        return "\n".join(self.parts)


def clean_product_text(value: str) -> str:
    """Normalize official product text without carrying the origin page chrome."""
    if not value:
        return ""
    value = html.unescape(value).replace("\r", "")
    # drop common ASCII framing and repeated blank lines.
    value = re.sub(r"^\s*\[?\s*Product:.*$", "", value, flags=re.I | re.M)
    value = re.sub(r"^\s*\$\$\s*$", "", value, flags=re.M)
    lines = [line.rstrip() for line in value.splitlines()]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
     
    cleaned=[]
    for line in lines:
        stripped=line.strip()
        if any(re.match(pat, stripped, re.I) for pat in BOILERPLATE_PATTERNS):
            continue
        if stripped.lower() in {"home", "products", "mesoscale discussions", "storm prediction center", "national weather service"}:
            continue
        cleaned.append(line)
    text="\n".join(cleaned)
    text=re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_html(value: str) -> str:
    parser = TextExtractor()
    parser.feed(value or "")
    return clean_product_text(parser.result())


def normalize_lines(text: str) -> list[str]:
    return [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines() if line.strip()]


def extract_section(text: str, labels: list[str], max_chars: int = 1400) -> str | None:
    lines = text.splitlines()
    label_re = r"^\.?(?:" + "|".join(re.escape(x) for x in labels) + r")\.\.\.\s*"
    start = None
    for i, line in enumerate(lines):
        if re.match(label_re, line.strip(), re.I):
            start = i
            break
    if start is None:
        return None
    first = re.sub(label_re, "", lines[start].strip(), flags=re.I)
    body=[first] if first else []
    for line in lines[start+1:]:
        if re.match(r"^\.?[A-Z][A-Z /&()0-9-]{2,}\.\.\.", line.strip()):
            break
        body.append(line.strip())
    out=re.sub(r"\s+", " ", " ".join(x for x in body if x)).strip()
    return out[:max_chars] if out else None


def clean_nws_product_text(text: str) -> str:
    text=clean_product_text(text)
    lines=normalize_lines(text)
    kept=[]
    for line in lines:
        if re.match(r"^(?:FXUS|WWUS|WUUS|ABUS|FLUS|SXUS|NOUS|NZUS|WWUS|ACUS)\d{2}", line):
            continue
        if re.match(r"^(?:[A-Z]{3,6})\s+\d{3,6}\s+\d{6}", line):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def fetch_bytes(url: str, accept: str | None = None) -> bytes:
    headers = dict(HEADERS)
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def fetch_json(url: str) -> dict:
    raw = fetch_bytes(url, "application/geo+json, application/ld+json, application/json")
    return json.loads(raw.decode("utf-8"))


def fetch_text(url: str) -> str:
    return fetch_bytes(url, "text/html, text/plain;q=0.9, */*;q=0.8").decode("utf-8", "replace")


def safe_iso(value):
    if not value:
        return None
    return value


def distance_to_geometry_miles(geometry: dict | None, lat: float, lon: float) -> float | None:
    if not geometry:
        return None
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return None
    polygons = []
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    else:
        return None
    best = None
    for polygon in polygons:
        # use the outer ring; holes do not materially affect a nearest-distance
        # readout for this small station-focused dashboard.
        if not polygon:
            continue
        pts = [(float(p[1]), float(p[0])) for p in polygon[0] if len(p) >= 2]
        d = distance_to_md_polygon_miles(lat, lon, pts)
        if d is not None and (best is None or d < best):
            best = d
    return best


def alert_to_watch(feature: dict) -> dict | None:
    p = feature.get("properties", {})
    event = p.get("event") or ""
    if "watch" not in event.lower():
        return None

    source_id = p.get("id") or feature.get("id") or ""
    number_match = re.search(r"(?:WW|WOU)\s*0*(\d+)", source_id, re.I)
    number = int(number_match.group(1)) if number_match else None

    description = p.get("description") or ""
    instruction = p.get("instruction") or ""
    area_desc = p.get("areaDesc")
    distance = distance_to_geometry_miles(feature.get("geometry"), LAT, LON)
    details=[]
    if area_desc:
        details.append({"label":"Areas", "text":area_desc})
    if instruction.strip():
        details.append({"label":"Instructions", "text":clean_product_text(instruction)[:1800]})
    elif description.strip():
        details.append({"label":"Alert detail", "text":clean_product_text(description)[:1800]})

    return {
        "id": source_id or f"watch-{p.get('effective')}-{event}",
        "type": event,
        "number": number,
        "issued": safe_iso(p.get("effective")),
        "expires": safe_iso(p.get("expires")),
        "location": area_desc,
        "distanceMiles": distance,
        "summary": p.get("headline") or event,
        "details": details,
        "url": p.get("@id") or feature.get("id"),
        "office": p.get("senderName"),
    }


def fetch_watches() -> list[dict]:
    payload = fetch_json(ALERTS_URL)
    watches = []
    for feature in payload.get("features", []):
        item = alert_to_watch(feature)
        if item:
            watches.append(item)
    watches.sort(key=lambda x: x.get("issued") or "", reverse=True)
    return watches


def parse_spc_datetime(text: str) -> str | None:
    # SPC MD pages use forms such as: 0210 PM CDT SAT AUG 08 2026
    m = re.search(
        r"\b(\d{4})\s+(AM|PM)\s+([A-Z]{3,4})\s+[A-Z]{3}\s+([A-Z]{3})\s+(\d{2})\s+(\d{4})\b",
        text,
        re.I,
    )
    if not m:
        return None
    hm, ampm, tz_name, mon, day, year = m.groups()
    hour = int(hm[:2])
    minute = int(hm[2:])
    if ampm.upper() == "PM" and hour != 12:
        hour += 12
    if ampm.upper() == "AM" and hour == 12:
        hour = 0
    offsets = {
        "EST": -5, "EDT": -4,
        "CST": -6, "CDT": -5,
        "MST": -7, "MDT": -6,
        "PST": -8, "PDT": -7,
    }
    offset = offsets.get(tz_name.upper())
    if offset is None:
        return None
    dt = datetime.strptime(f"{year} {mon.upper()} {day} {hour:02d}:{minute:02d}", "%Y %b %d %H:%M")
    dt = dt.replace(tzinfo=timezone(timedelta(hours=offset)))
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_valid_window(text: str, issued_iso: str | None):
    m = re.search(r"\bVALID\s+(\d{6})Z\s*-\s*(\d{6})Z\b", text, re.I)
    if not m or not issued_iso:
        return None
    issued = datetime.fromisoformat(issued_iso.replace("Z", "+00:00"))
    vals = []
    for raw in m.groups():
        day = int(raw[:2])
        hour = int(raw[2:4])
        minute = int(raw[4:6])
        
        candidate = issued.replace(day=day, hour=hour, minute=minute, second=0, microsecond=0)
        if candidate < issued - timedelta(hours=6):
            candidate += timedelta(days=1)
        vals.append(candidate)
    return vals[0].isoformat().replace("+00:00", "Z"), vals[1].isoformat().replace("+00:00", "Z")

MD_SECTION_LABELS = [
    "Areas affected",
    "Concerning",
    "Probability of (?:Watch|Unconditional) Issuance",
    "SUMMARY",
    "DISCUSSION",
]
MD_BOUNDARY_RE = re.compile(
    r"\b(?:(?P<label>" + "|".join(MD_SECTION_LABELS) +
    r")\.\.\.|(?P<valid>Valid\s+\d{6}Z\s*-\s*\d{6}Z)|"
    r"(?P<tail>ATTN\.\.\.|LAT\.\.\.LON\b|MOST\s+PROBABLE\b|\.\.\.[A-Za-z/ ]+\.\.\s*\d{2}/\d{2}/\d{4}))",
    re.I,
)
MD_SIGNATURE_RE = re.compile(r"\.\.[A-Za-z/ ]+\.\.\s*\d{2}/\d{2}/\d{4}", re.I)
MD_ATTN_RE = re.compile(r"\bATTN\.\.\.\s*(.*?)(?=\bLAT\.\.\.LON\b|\Z)", re.I | re.S)
MD_LATLON_RE = re.compile(r"\bLAT\.\.\.LON\s+((?:\d{8}\s*)+)", re.I)
MD_PEAK_RE = re.compile(r"\b(MOST\s+PROBABLE[^\n]+)", re.I)


def split_md_sections(text: str, max_chars: int = 1800) -> dict[str, str]:
    matches = list(MD_BOUNDARY_RE.finditer(text))
    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        label = m.group("label")
        if not label:
            continue
        start = m.end()
        end = len(text)
        for nxt in matches[i + 1:]:
            end = nxt.start()
            break
        value = text[start:end]
        value = MD_SIGNATURE_RE.split(value, maxsplit=1)[0]
        value = re.sub(r"\s+", " ", value).strip(" .")
        if value:
            sections[label.title()] = value[:max_chars]
    return sections


def parse_md_forecaster(text: str) -> str | None:
    m = MD_SIGNATURE_RE.search(text)
    if not m:
        return None
    value = re.sub(r"^\.\.|\.\.$", "", m.group(0).split("..")[1] if ".." in m.group(0) else m.group(0)).strip()
    return value or None


def parse_md_polygon(text: str) -> list[tuple[float, float]]:
    m = MD_LATLON_RE.search(text)
    if not m:
        return []
    coords = []
    for token in re.findall(r"\d{8}", m.group(1)):
        lat = int(token[:4]) / 100.0
        lon = int(token[4:]) / 100.0
        # SPC's CONUS coordinates are west longitudes unless
        # explicitly outside the CONUS convention.
        if lon > 0:
            lon = -lon
        if 0 <= lat <= 90 and -180 <= lon <= 180:
            coords.append((lat, lon))
    return coords


def distance_to_md_polygon_miles(lat: float, lon: float, polygon: list[tuple[float, float]]) -> float | None:
    if len(polygon) < 2:
        return None
    # local tangent-plane approximation for discussion-scale polygon.
    # lets us report distance without a GIS dependency.
    r = 3958.7613
    lat0 = math.radians(lat)
    def xy(p):
        plat, plon = p
        return (
            r * math.radians(plon - lon) * math.cos(lat0),
            r * math.radians(plat - lat),
        )
    pts = [xy(p) for p in polygon]
    p = (0.0, 0.0)

    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if ((yi > 0) != (yj > 0)) and (0 < (xj - xi) * (-yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    if inside:
        return 0.0

    best = float("inf")
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        ax, ay = a
        bx, by = b
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        t = 0.0 if denom == 0 else max(0.0, min(1.0, (-(ax * dx + ay * dy)) / denom))
        qx, qy = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(qx, qy))
    return round(best, 1)


# A Mesoscale Discussion is only "local" to this dashboard's WFO if that WFO
# is explicitly named in the product's own ATTN...WFO... line -- that's SPC
# stating which forecast offices the discussion concerns, which is a far more
# reliable signal than map distance: an MD's polygon is drawn around the
# meteorological feature it's discussing, not the county warning area, so a
# numerically "close" MD can still belong to a neighboring office's forecast
# area, and a "far" polygon can still name this WFO in its ATTN line.
MD_ATTN_WFO_RE = re.compile(r"\b([A-Z]{3})\b")


def extract_attn_wfos(attn_text: str | None) -> list[str]:
    if not attn_text:
        return []
    return [code for code in MD_ATTN_WFO_RE.findall(attn_text.upper()) if code != "WFO"]


def md_is_local(item: dict) -> bool:
    attn_wfos = item.get("attnWfos") or []
    if attn_wfos:
        return WFO in attn_wfos
    # ATTN line missing or unparseable (rare) -- fall back to an approximate
    # radius around the station rather than silently dropping the item.
    distance = item.get("distanceMiles")
    return distance is not None and distance <= MD_LOCAL_FALLBACK_MILES


def parse_md(url: str, raw_html: str, number: int) -> dict:
    text = strip_html(raw_html)
    issued = parse_spc_datetime(text)
    valid = parse_valid_window(text, issued)
    sections = split_md_sections(text)
    concerning = sections.get("Concerning")
    areas = sections.get("Areas Affected")
    summary = sections.get("Summary")
    discussion = sections.get("Discussion")
    watch_probability = sections.get("Probability Of Watch Issuance") or sections.get("Probability Of Unconditional Issuance")
    forecaster = parse_md_forecaster(text)
    polygon = parse_md_polygon(text)
    distance = distance_to_md_polygon_miles(LAT, LON, polygon)
    attn = None
    m_attn = MD_ATTN_RE.search(text)
    if m_attn:
        attn = re.sub(r"\s+", " ", m_attn.group(1)).strip(" .")

    threats = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if re.match(r"^MOST\s+PROBABLE\b", line, re.I):
            threats.append(line)
    if not threats:
        # the HTML/pre extraction can flatten these into one line.
        threats = [re.sub(r"\s+", " ", m.group(1)).strip() for m in MD_PEAK_RE.finditer(text)]

    if not summary:
        summary = concerning or "Latest SPC mesoscale discussion"

    details = []
    if summary:
        details.append({"label": "Summary", "text": summary})
    if discussion:
        details.append({"label": "Discussion", "text": discussion})
    if watch_probability:
        details.append({"label": "Watch probability", "text": watch_probability})
    if threats:
        details.append({"label": "Most probable threats", "text": " · ".join(threats)})
    if forecaster:
        details.append({"label": "Forecaster", "text": forecaster})
    if attn:
        details.append({"label": "WFOs", "text": attn})

    return {
        "id": f"MD{number:04d}",
        "number": number,
        "issued": issued,
        "expires": valid[1] if valid else None,
        "concerning": concerning,
        "hazard": concerning,
        "areas": areas,
        "location": areas,
        "distanceMiles": distance,
        "summary": summary,
        "watchProbability": watch_probability,
        "forecaster": forecaster,
        "attnWfos": extract_attn_wfos(attn),
        "details": details,
        "url": url,
        "office": "SPC",
    }

def fetch_mesoscale_discussions(limit: int = MAX_MDS) -> list[dict]:
    """Local-area Storm Center: SPC issues MDs nationwide, so this scans a
    wider recent pool (MD_SCAN_POOL_SIZE) than the final count (limit) and
    keeps only the ones that actually name this station's WFO -- see
    md_is_local(). Most runs stop well short of the full pool thanks to the
    recency break below, since the index is newest-first."""
    raw_index = fetch_text(SPC_MD_INDEX)
    links = []
    for match in re.finditer(r"(?:href=[\"'])([^\"']*md(\d{4})\.html)[\"']", raw_index, re.I):
        href, number_raw = match.groups()
        number = int(number_raw)
        url = href if href.startswith("http") else urllib.parse.urljoin(SPC_MD_INDEX, href)
        links.append((number, url))
    links = sorted({n: u for n, u in links}.items(), reverse=True)[:MD_SCAN_POOL_SIZE]

    now = datetime.now(timezone.utc)
    items=[]
    for number, url in links:
        try:
            item=parse_md(url, fetch_text(url), number)
        except Exception as exc:
            print(f"WARNING: failed to parse {url}: {exc}", file=sys.stderr)
            continue

        issued=item.get("issued")
        expires=item.get("expires")
        if expires:
            exp=datetime.fromisoformat(expires.replace("Z","+00:00"))
            if exp < now:
                continue
        elif issued:
            dt=datetime.fromisoformat(issued.replace("Z","+00:00"))
            if dt < now - timedelta(hours=MD_RECENT_HOURS):
                # links are newest-first, so nothing further back in the
                # pool can be recent enough either -- stop scanning.
                break

        if not md_is_local(item):
            continue

        items.append(item)
        if len(items) >= limit:
            break
    items.sort(key=lambda x: (x.get("issued") or "", x.get("number") or 0), reverse=True)
    return items[:limit]


def extract_nws_location(full_text: str, product_name: str) -> str | None:
    lines = normalize_lines(full_text)
    # VTEC-segmented products (warnings/statements tied to an active
    # segment): the /O.NEW.KPBZ.SV.W.0091/ line is immediately followed by
    # the county/area list line.
    for i, line in enumerate(lines):
        if re.match(r"^/[^/]+/$", line) and i + 1 < len(lines):
            candidate = lines[i + 1]
            candidate = re.sub(r"\s+\d{3,4}\s+(?:AM|PM)\s+[A-Z]{2,4}\s+\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4}.*$", "", candidate, flags=re.I)
            candidate = re.sub(r"\s+\d{3,4}\s+(?:AM|PM)\s+[A-Z]{2,4}.*$", "", candidate, flags=re.I)
            if candidate and not re.match(r"^\d{3,4}\s+(?:AM|PM)\b", candidate, re.I):
                return candidate.strip(" -")
    
    ugc_start_re = re.compile(r"^[A-Z]{2,3}[CZ]\d{3}-")
    ugc_line_re = re.compile(r"^[A-Z0-9>-]+-$")
    ugc_end_re = re.compile(r"-\d{6}-$")
    name_list_re = re.compile(r"^(?=.*-)[A-Za-z][A-Za-z .'-]*$")
    for i, line in enumerate(lines):
        if not ugc_start_re.match(line):
            continue
        end_idx = None
        for j in range(i, min(i + 5, len(lines))):
            if ugc_end_re.search(lines[j]):
                end_idx = j
                break
            if not ugc_line_re.match(lines[j]):
                break
        if end_idx is None:
            continue
        parts = []
        for candidate in lines[end_idx + 1:end_idx + 4]:
            if name_list_re.match(candidate):
                parts.append(candidate.strip(" -"))
            else:
                break
        if parts:
            return "-".join(parts)[:200]
    return None


def fetch_nws_updates(limit: int = MAX_NWS_UPDATES) -> list[dict]:
    params = urllib.parse.urlencode({"location": WFO, "limit": 50})
    payload = fetch_json(f"{NWS_PRODUCTS_URL}?{params}")
    candidates=[]
    now=datetime.now(timezone.utc)
    cutoff=now-timedelta(hours=NWS_RECENT_HOURS)

    for feature in payload.get("@graph", payload.get("features", [])):
        props=feature.get("properties", feature)
        code=props.get("productCode") or feature.get("productCode")
        if code not in NWS_UPDATE_CODES:
            continue
        issued_raw=props.get("issuanceTime") or ""
        try:
            issued_dt=datetime.fromisoformat(issued_raw.replace("Z","+00:00")) if issued_raw else None
        except ValueError:
            issued_dt=None
        if issued_dt and issued_dt < cutoff:
            continue
        candidates.append((issued_raw, feature, props, code))

    candidates.sort(key=lambda x: x[0], reverse=True)
    items=[]
    seen=set()
    for _, feature, props, code in candidates:
        url=props.get("@id") or feature.get("@id") or feature.get("id")
        source_id=props.get("id") or feature.get("id") or url
        if source_id in seen:
            continue
        seen.add(source_id)
        full_text=props.get("productText") or ""
        if url and not full_text:
            try:
                product=fetch_json(url)
                full_text=product.get("productText") or product.get("properties", {}).get("productText") or ""
            except Exception:
                pass
        full_text=clean_nws_product_text(full_text)
        product_name=props.get("productName") or NWS_UPDATE_CODES[code]

        details=[]
        for label, labels, limit_chars in [
            ("Overview", ["OVERVIEW", "SUMMARY", "SYNOPSIS"], 1100),
            ("Discussion", ["DISCUSSION"], 1800),
            ("Today's Hazards", ["DAY ONE"], 1100),
            ("Hazards", ["HAZARDS", "IMPACTS", "IMPACT"], 1100),
            ("Extended Outlook", ["DAYS TWO THROUGH SEVEN"], 900),
            ("Timing", ["TIMING", "THREAT", "VALID"], 900),
        ]:
            value=extract_section(full_text, labels, limit_chars)
            if value: details.append({"label":label,"text":value})

        headline=props.get("headline") or product_name
        summary=props.get("headline") or ""
        if not summary or summary == product_name:
            if details:
                summary=strip_generic_lead(details[0]["text"])[:420]
            else:
                banner_re=re.compile(rf"^(?:{re.escape(product_name)}|\d{{3,4}}\s+(?:AM|PM)\s+[A-Z]{{2,4}}\s+\w{{3}}\s+\w{{3}}\s+\d{{1,2}}\s+\d{{4}})$", re.I)
                lines=[x for x in normalize_lines(full_text) if len(x) > 8 and not banner_re.match(x)]
                summary=strip_generic_lead(" ".join(lines[:2]))[:420] if lines else product_name
        if not details and full_text:
            details=[{"label":"Product detail","text":" ".join(normalize_lines(full_text)[:8])[:1800]}]

        hazard_text=props.get("headline") or summary or product_name
        hazard=hazard_text[:160].rsplit(" ", 1)[0] if len(hazard_text) > 160 else hazard_text

        items.append({
            "id": source_id,
            "type": product_name,
            "office": props.get("issuingOffice") or WFO,
            "issued": props.get("issuanceTime"),
            "expires": props.get("expirationTime") or props.get("expires"),
            "location": (
                props.get("areaDesc")
                or extract_nws_location(full_text, product_name)
                or "NWS Pittsburgh PA (PBZ) coverage area"
            ),
            "hazard": hazard,
            "distanceMiles": None,
            "headline": headline,
            "summary": summary,
            "details": details,
            "url": url,
        })
        if len(items) >= limit:
            break
    return items


def main():
    os.makedirs("data", exist_ok=True)
    output_path = "data/nws_products.json"

    # preserve the last good section if one upstream source has a blip 
    previous = {
        "generatedAt": None,
        "watches": [],
        "mesoscaleDiscussions": [],
        "statements": [],
    }
    if os.path.exists(output_path):
        try:
            with open(output_path, "r", encoding="utf-8") as f:
                previous.update(json.load(f))
        except Exception:
            pass

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "watches": previous.get("watches", []),
        "mesoscaleDiscussions": previous.get("mesoscaleDiscussions", []),
        "statements": previous.get("statements", []),
    }
    successes = 0

    try:
        output["watches"] = fetch_watches()
        successes += 1
    except Exception as exc:
        print(f"WARNING: failed to fetch NWS watches; keeping previous data: {exc}", file=sys.stderr)

    try:
        output["mesoscaleDiscussions"] = fetch_mesoscale_discussions()
        successes += 1
    except Exception as exc:
        print(f"WARNING: failed to fetch SPC mesoscale discussions; keeping previous data: {exc}", file=sys.stderr)

    try:
        output["statements"] = fetch_nws_updates()
        successes += 1
    except Exception as exc:
        print(f"WARNING: failed to fetch NWS product updates; keeping previous data: {exc}", file=sys.stderr)

    if successes == 0:
        print("ERROR: all SPC/NWS sources failed; leaving existing data/nws_products.json untouched.", file=sys.stderr)
        return 1

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(
        "Saved data/nws_products.json — "
        f"{len(output['watches'])} watches, "
        f"{len(output['mesoscaleDiscussions'])} MDs, "
        f"{len(output['statements'])} NWS updates"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"ERROR: network failure while building NWS/SPC feed: {exc}", file=sys.stderr)
        sys.exit(1)
