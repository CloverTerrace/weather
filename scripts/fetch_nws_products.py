#!/usr/bin/env python3
"""
Build the merged SPC/NWS product feed used by the weather dashboard.

Sources:
  * NWS active alerts at the Clover Terrace point (watches)
  * SPC current Mesoscale Discussion index/products
  * NWS API recent products for WFO Pittsburgh (PBZ)

Output:
  data/nws_products.json

The script intentionally keeps the payload small: the dashboard gets a concise summary first and only curated product sections
when a user expands a product. Source-page navigation/chrome is never stored.
"""

from __future__ import annotations

import html
import json
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

# Keep the storm desk intentionally "live": active watches, active/recent SPC
# mesoscale discussions, and only the newest local NWS products.
MD_RECENT_HOURS = 8
NWS_RECENT_HOURS = 18
MAX_MDS = 5
MAX_NWS_UPDATES = 7

# Product boilerplate that belongs to the source page rather than the dashboard.
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
    # Drop common ASCII framing and repeated blank lines.
    value = re.sub(r"^\s*\[?\s*Product:.*$", "", value, flags=re.I | re.M)
    value = re.sub(r"^\s*$$", "", value, flags=re.M)
    lines = [line.rstrip() for line in value.splitlines()]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    # Remove source-page boilerplate when it appears around a product body.
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
    label_re = r"^(?:" + "|".join(re.escape(x) for x in labels) + r")\.\.\.\s*"
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
        if re.match(r"^[A-Z][A-Z /&()0-9-]{2,}\.\.\.", line.strip()):
            break
        body.append(line.strip())
    out=re.sub(r"\s+", " ", " ".join(x for x in body if x)).strip()
    return out[:max_chars] if out else None


def clean_nws_product_text(text: str) -> str:
    text=clean_product_text(text)
    lines=normalize_lines(text)
    # Strip WMO headers / product IDs / leading office timestamps.
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
    details=[]
    if p.get("areaDesc"):
        details.append({"label":"Areas", "text":p.get("areaDesc")})
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
        # MD valid windows can cross UTC midnight; choose the date nearest the
        # issuance date, then allow a one-day rollover.
        candidate = issued.replace(day=day, hour=hour, minute=minute, second=0, microsecond=0)
        if candidate < issued - timedelta(hours=6):
            candidate += timedelta(days=1)
        vals.append(candidate)
    return vals[0].isoformat().replace("+00:00", "Z"), vals[1].isoformat().replace("+00:00", "Z")


# SPC MD text products are one continuous flowing paragraph -- e.g.
# "Areas affected...X Concerning...Y Valid HHMMSSZ-HHMMSSZ Probability of
# Watch Issuance...Z SUMMARY...A DISCUSSION...B" -- with NO newline between
# sections. A line-anchored "next section starts a new line" boundary (the
# old approach) never matches here, so each field used to swallow
# everything after it, all the way to the next field it COULD find (or the
# character limit). This splits on every label's position directly,
# wherever it falls in the running text, and "Valid HHMMSSZ-HHMMSSZ" is
# matched as a boundary-only token (it has no "..." of its own) so it
# still stops "Concerning" from bleeding into "Probability of Issuance".
MD_SECTION_LABELS = ["Areas affected", "Concerning", "Probability of (?:Watch|Unconditional) Issuance", "SUMMARY", "DISCUSSION"]
MD_BOUNDARY_RE = re.compile(
    r"\b(?:(?P<label>" + "|".join(MD_SECTION_LABELS) + r")\.\.\.|(?P<valid>Valid\s+\d{6}Z\s*-\s*\d{6}Z))",
    re.I,
)
# trailing forecaster signature line, e.g.
# "..Squitieri/Mosier.. 08/09/2026 ...Please see www.spc.noaa.gov..."
MD_SIGNATURE_RE = re.compile(r"\.\.[A-Za-z/ ]+\.\.\s*\d{2}/\d{2}/\d{4}")


def split_md_sections(text: str, max_chars: int = 1800) -> dict[str, str]:
    matches = list(MD_BOUNDARY_RE.finditer(text))
    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        if not m.group("label"):
            continue  # "Valid ..." is a boundary only, not a captured section
        label = m.group("label")
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        value = MD_SIGNATURE_RE.split(text[start:end], maxsplit=1)[0]
        value = re.sub(r"\s+", " ", value).strip()
        if value:
            sections[label.title()] = value[:max_chars]
    return sections


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
    if not summary:
        summary = concerning or "Latest SPC mesoscale discussion"

    details=[]
    if concerning: details.append({"label":"Concerning", "text":concerning})
    if areas: details.append({"label":"Areas affected", "text":areas})
    if watch_probability: details.append({"label":"Watch Probability", "text":watch_probability})
    if discussion: details.append({"label":"Discussion", "text":discussion})

    return {
        "id": f"MD{number:04d}",
        "number": number,
        "issued": issued,
        "expires": valid[1] if valid else None,
        "concerning": concerning,
        "areas": areas,
        "summary": summary,
        "details": details,
        "url": url,
        "office": "SPC",
    }


def fetch_mesoscale_discussions(limit: int = MAX_MDS) -> list[dict]:
    raw_index = fetch_text(SPC_MD_INDEX)
    links = []
    for match in re.finditer(r"(?:href=[\"'])([^\"']*md(\d{4})\.html)[\"']", raw_index, re.I):
        href, number_raw = match.groups()
        number = int(number_raw)
        url = href if href.startswith("http") else urllib.parse.urljoin(SPC_MD_INDEX, href)
        links.append((number, url))
    links = sorted({n: u for n, u in links}.items(), reverse=True)[:10]

    now = datetime.now(timezone.utc)
    items=[]
    for number, url in links:
        try:
            item=parse_md(url, fetch_text(url), number)
            issued=item.get("issued")
            expires=item.get("expires")
            if expires:
                exp=datetime.fromisoformat(expires.replace("Z","+00:00"))
                if exp < now:
                    continue
            elif issued:
                dt=datetime.fromisoformat(issued.replace("Z","+00:00"))
                if dt < now - timedelta(hours=MD_RECENT_HOURS):
                    continue
            items.append(item)
        except Exception as exc:
            print(f"WARNING: failed to parse {url}: {exc}", file=sys.stderr)
    items.sort(key=lambda x: (x.get("issued") or "", x.get("number") or 0), reverse=True)
    return items[:limit]


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

        # Prefer official structured metadata; fall back to the first clean body lines.
        headline=props.get("headline") or product_name
        summary=props.get("headline") or ""
        if not summary or summary == product_name:
            lines=[x for x in normalize_lines(full_text) if len(x) > 8]
            summary=" ".join(lines[:2])[:420] if lines else product_name

        details=[]
        for label, labels, limit_chars in [
            ("Overview", ["OVERVIEW", "SUMMARY", "SYNOPSIS"], 1100),
            ("Discussion", ["DISCUSSION"], 1800),
            ("Hazards", ["HAZARDS", "IMPACTS", "IMPACT"], 1100),
            ("Timing", ["TIMING", "THREAT", "VALID"], 900),
        ]:
            value=extract_section(full_text, labels, limit_chars)
            if value: details.append({"label":label,"text":value})
        if not details and full_text:
            details=[{"label":"Product detail","text":" ".join(normalize_lines(full_text)[:8])[:1800]}]

        items.append({
            "id": source_id,
            "type": product_name,
            "office": props.get("issuingOffice") or WFO,
            "issued": props.get("issuanceTime"),
            "expires": props.get("expirationTime") or props.get("expires"),
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

    # Preserve the last good section if one upstream source has a transient
    # outage. A complete failure leaves the existing file untouched.
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
