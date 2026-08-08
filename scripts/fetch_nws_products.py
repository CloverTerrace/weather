#!/usr/bin/env python3
"""
Build the merged SPC/NWS product feed used by the weather dashboard.

Sources:
  * NWS active alerts at the Clover Terrace point (watches)
  * SPC current Mesoscale Discussion index/products
  * NWS API recent products for WFO Pittsburgh (PBZ)

Output:
  data/nws_products.json

The script intentionally keeps the payload small: the dashboard gets a concise
summary first and the full source text only when a user expands a product.
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


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag.lower() in {"script", "style", "noscript"}:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag.lower() in {"script", "style", "noscript"} and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            text = data.strip()
            if text:
                self.parts.append(text)


def strip_html(value: str) -> str:
    parser = TextExtractor()
    parser.feed(value or "")
    text = "\n".join(parser.parts)
    text = html.unescape(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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
    full_text = "\n\n".join(x for x in [description.strip(), instruction.strip()] if x.strip())

    return {
        "id": source_id or f"watch-{p.get('effective')}-{event}",
        "type": event,
        "number": number,
        "issued": safe_iso(p.get("effective")),
        "expires": safe_iso(p.get("expires")),
        "areas": p.get("areaDesc"),
        "summary": p.get("headline") or event,
        "fullText": full_text,
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


def extract_md_field(text: str, label: str) -> str | None:
    m = re.search(rf"^\s*{re.escape(label)}\.\.\.\s*(.+?)(?=\n[A-Z][A-Z /-]+\.\.\.|\Z)", text, re.I | re.M | re.S)
    if not m:
        return None
    value = re.sub(r"\s+", " ", m.group(1)).strip()
    return value[:700]


def parse_md(url: str, raw_html: str, number: int) -> dict:
    text = strip_html(raw_html)
    issued = parse_spc_datetime(text)
    valid = parse_valid_window(text, issued)
    concerning = extract_md_field(text, "CONCERNING")
    summary = extract_md_field(text, "SUMMARY")
    areas = extract_md_field(text, "AREAS AFFECTED")
    if not summary:
        # Keep the collapsed card useful even if SPC changes its formatting.
        summary = concerning or "Latest SPC mesoscale discussion"

    return {
        "id": f"MD{number:04d}",
        "number": number,
        "issued": issued,
        "expires": valid[1] if valid else None,
        "concerning": concerning,
        "areas": areas,
        "summary": summary,
        "fullText": text,
        "url": url,
        "office": "SPC",
    }


def fetch_mesoscale_discussions(limit: int = 6) -> list[dict]:
    raw_index = fetch_text(SPC_MD_INDEX)
    links = []
    for match in re.finditer(r"(?:href=[\"'])([^\"']*md(\d{4})\.html)[\"']", raw_index, re.I):
        href, number_raw = match.groups()
        number = int(number_raw)
        if href.startswith("http"):
            url = href
        else:
            url = urllib.parse.urljoin(SPC_MD_INDEX, href)
        links.append((number, url))
    # Highest-numbered MDs are normally the newest. De-duplicate by number.
    links = sorted({n: u for n, u in links}.items(), reverse=True)[:limit]

    items = []
    for number, url in links:
        try:
            item = parse_md(url, fetch_text(url), number)
            items.append(item)
        except Exception as exc:
            print(f"WARNING: failed to parse {url}: {exc}", file=sys.stderr)
    items.sort(key=lambda x: (x.get("issued") or "", x.get("number") or 0), reverse=True)
    return items


def fetch_nws_updates(limit: int = 8) -> list[dict]:
    params = urllib.parse.urlencode({"location": WFO, "limit": 50})
    payload = fetch_json(f"{NWS_PRODUCTS_URL}?{params}")
    candidates = []

    for feature in payload.get("@graph", payload.get("features", [])):
        props = feature.get("properties", feature)
        code = props.get("productCode") or feature.get("productCode")
        if code not in NWS_UPDATE_CODES:
            continue
        candidates.append((props.get("issuanceTime") or "", feature, props, code))

    candidates.sort(key=lambda x: x[0], reverse=True)
    items = []
    for _, feature, props, code in candidates[:limit]:
        url = props.get("@id") or feature.get("@id") or feature.get("id")
        full_text = props.get("productText") or ""
        if url and not full_text:
            try:
                product = fetch_json(url)
                full_text = product.get("productText") or product.get("properties", {}).get("productText") or ""
            except Exception:
                pass

        product_name = props.get("productName") or NWS_UPDATE_CODES[code]
        text_summary = ""
        if full_text:
            lines = [line.strip() for line in full_text.splitlines() if line.strip()]
            # Avoid duplicating the WMO header; the first few human-readable
            # lines are a better collapsed synopsis.
            text_summary = " ".join(lines[:3])[:420]

        items.append({
            "id": props.get("id") or feature.get("id") or url,
            "type": product_name,
            "office": props.get("issuingOffice") or WFO,
            "issued": props.get("issuanceTime"),
            "expires": None,
            "headline": product_name,
            "summary": text_summary,
            "fullText": full_text,
            "url": url,
        })
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
