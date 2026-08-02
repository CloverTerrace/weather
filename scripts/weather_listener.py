#!/usr/bin/env python3
"""
Local listener for live pushes from an Ecowitt gateway (GW1000/GW2000/etc).

Configure the gateway's "Customized" server upload (in WS View Plus, or the
gateway's local web UI) as follows:

    Protocol Type:  Wunderground
    Server IP/Host: <this machine's LAN IP>
    Path:           /weatherstation/updateweatherstation.php
    Port:           8000 (or whatever WEATHER_LISTENER_PORT is set to)
    Station ID:     any string (must match WU_PUSH_ID below)
    Station Key:    any string (must match WU_PUSH_PASSWORD below)
    Upload Interval: 30-60s recommended

This writes data/weather.json on every push, and appends to
data/history.json at most once per HISTORY_INTERVAL_SECONDS so the chart
history doesn't balloon in size. A separate committer script (see
commit_and_push.sh) is responsible for getting these files onto GitHub --
this script only ever touches the local filesystem.

All configuration is via environment variables (see systemd/weather-listener.env.example).
"""

import json
import os
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

# ---- Configuration -----------------------------------------------------

LISTEN_PORT = int(os.environ.get("WEATHER_LISTENER_PORT", "8000"))
DATA_DIR = os.environ.get("WEATHER_DATA_DIR", "data")
STATION_ID = os.environ.get("WEATHER_STATION_ID", "")
NEIGHBORHOOD = os.environ.get("WEATHER_NEIGHBORHOOD", "")
LOCAL_TZ = os.environ.get("WEATHER_LOCAL_TZ", "America/New_York")
PUSH_ID = os.environ.get("WU_PUSH_ID")
PUSH_PASSWORD = os.environ.get("WU_PUSH_PASSWORD")
HISTORY_INTERVAL_SECONDS = int(os.environ.get("WEATHER_HISTORY_INTERVAL_SECONDS", "60"))
MAX_HISTORY_ENTRIES = int(os.environ.get("WEATHER_MAX_HISTORY_ENTRIES", "14400"))  # ~10 days @ 60s

if not PUSH_ID or not PUSH_PASSWORD:
    print("ERROR: WU_PUSH_ID and WU_PUSH_PASSWORD must be set (shared secret with the gateway).",
          file=sys.stderr)
    sys.exit(1)

WEATHER_JSON = os.path.join(DATA_DIR, "weather.json")
HISTORY_JSON = os.path.join(DATA_DIR, "history.json")

_lock = threading.Lock()
_last_history_write = 0.0

# ---- Unit helpers --------------------------------------------------------

def f(v):
    """Best-effort float parse; returns None if missing/invalid."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def compute_heat_index(temp_f, humidity):
    if temp_f is None or humidity is None:
        return None
    t, r = temp_f, humidity
    hi = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + r * 0.094)
    if (hi + t) / 2 >= 80:
        hi = (-42.379 + 2.04901523 * t + 10.14333127 * r - 0.22475541 * t * r
              - 0.00683783 * t * t - 0.05481717 * r * r + 0.00122874 * t * t * r
              + 0.00085282 * t * r * r - 0.00000199 * t * t * r * r)
        if r < 13 and 80 <= t <= 112:
            hi -= ((13 - r) / 4) * ((17 - abs(t - 95)) / 17) ** 0.5
        elif r > 85 and 80 <= t <= 87:
            hi += ((r - 85) / 10) * ((87 - t) / 5)
    return round(hi, 1) if t >= 80 else round(t, 1)


def compute_wind_chill(temp_f, wind_mph):
    if temp_f is None or wind_mph is None:
        return round(temp_f, 1) if temp_f is not None else None
    if temp_f <= 50 and wind_mph >= 3:
        v16 = wind_mph ** 0.16
        wc = 35.74 + 0.6215 * temp_f - 35.75 * v16 + 0.4275 * temp_f * v16
        return round(wc, 1)
    return round(temp_f, 1)


def parse_dateutc(raw):
    if not raw or raw.lower() == "now":
        return datetime.now(timezone.utc)
    try:
        return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as fp:
        json.dump(obj, fp, indent=2)
    os.replace(tmp, path)


# ---- Request handling -----------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def do_GET(self):
        self._handle(parse_qs(urlparse(self.path).query))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", "ignore")
        self._handle(parse_qs(body))

    def _handle(self, params):
        get = lambda k: params.get(k, [None])[0]

        if get("ID") != PUSH_ID or get("PASSWORD") != PUSH_PASSWORD:
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"forbidden")
            return

        temp_f = f(get("tempf"))
        humidity = f(get("humidity"))
        wind_mph = f(get("windspeedmph"))
        wind_gust_mph = f(get("windgustmph"))

        obs_utc = parse_dateutc(get("dateutc"))
        obs_local = obs_utc.astimezone(ZoneInfo(LOCAL_TZ))

        output = {
            "stationID": STATION_ID,
            "obsTimeLocal": obs_local.strftime("%Y-%m-%d %H:%M:%S"),
            "obsTimeUtc": obs_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "neighborhood": NEIGHBORHOOD,
            "humidity": humidity,
            "winddir": f(get("winddir")),
            "uv": f(get("UV")),
            "solarRadiation": f(get("solarradiation")),
            "temp": temp_f,
            "heatIndex": compute_heat_index(temp_f, humidity),
            "windChill": compute_wind_chill(temp_f, wind_mph),
            "dewpt": f(get("dewptf")),
            "windSpeed": wind_mph,
            "windGust": wind_gust_mph,
            "pressure": f(get("baromin")),
            "precipRate": f(get("rainin")),
            "precipTotal": f(get("dailyrainin")),
            "source": "local",
        }

        with _lock:
            os.makedirs(DATA_DIR, exist_ok=True)
            atomic_write_json(WEATHER_JSON, output)
            self._maybe_append_history(output)

        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"success")

    def _maybe_append_history(self, output):
        global _last_history_write
        import time
        now = time.time()
        if now - _last_history_write < HISTORY_INTERVAL_SECONDS:
            return
        _last_history_write = now

        history = []
        if os.path.exists(HISTORY_JSON):
            try:
                with open(HISTORY_JSON) as fp:
                    history = json.load(fp)
            except (json.JSONDecodeError, ValueError):
                history = []

        history.append({
            "time": output["obsTimeLocal"],
            "temp": output["temp"],
            "humidity": output["humidity"],
            "windSpeed": output["windSpeed"],
            "windGust": output["windGust"],
            "winddir": output["winddir"],
            "pressure": output["pressure"],
            "solarRadiation": output["solarRadiation"],
        })
        history = history[-MAX_HISTORY_ENTRIES:]
        atomic_write_json(HISTORY_JSON, history)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    print(f"Listening on 0.0.0.0:{LISTEN_PORT}, writing to {DATA_DIR}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
