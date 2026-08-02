#!/usr/bin/env python3
"""
WeeWX service that exports weather.json (on every loop packet -- as fast as
the interceptor driver receives pushes from the gateway) and appends to
history.json (on every archive record) in the schema your site already
reads.

Install:
  1. Copy this file to your WeeWX user directory (commonly
     ~/weewx-data/bin/user/ for pip installs, or /etc/weewx/bin/user/ for
     package installs -- run `find / -name weewx.conf 2>/dev/null` if unsure).
  2. Add to weewx.conf:

        [JsonExport]
            data_dir = /home/weather/weather-site/data
            station_id = KPASOMEW3
            neighborhood = YourNeighborhoodName
            max_history_entries = 14400

        [Engine]
            [[Services]]
                data_services = user.weewx_json_export.JsonExportService

     (append to the existing data_services list rather than replacing it,
     if you already have other data_services entries.)

  3. Restart weewx: sudo systemctl restart weewx
"""

import json
import os
import time
import traceback

import weewx
import weewx.units
import weewx.xtypes
import weeutil.weeutil
from weewx.engine import StdService


class JsonExportService(StdService):
    def __init__(self, engine, config_dict):
        super().__init__(engine, config_dict)

        export_conf = config_dict.get("JsonExport", {})
        self.data_dir = export_conf.get("data_dir", "/home/weather/weather-site/data")
        self.station_id = export_conf.get("station_id", "")
        self.neighborhood = export_conf.get("neighborhood", "")
        self.max_history_entries = int(export_conf.get("max_history_entries", 14400))
        self.data_binding = export_conf.get("data_binding", "wx_binding")

        os.makedirs(self.data_dir, exist_ok=True)
        self.weather_json = os.path.join(self.data_dir, "weather.json")
        self.history_json = os.path.join(self.data_dir, "history.json")

        self._last_precip_total = None

        self.bind(weewx.NEW_LOOP_PACKET, self.new_loop_packet)
        self.bind(weewx.NEW_ARCHIVE_RECORD, self.new_archive_record)

    # -- helpers ------------------------------------------------------

    @staticmethod
    def _to_us(record, obs):
        """Convert a single observation in a loop/archive record to US units."""
        if obs not in record or record[obs] is None:
            return None
        try:
            vt = weewx.units.as_value_tuple(record, obs)
            converted = weewx.units.convertStd(vt, weewx.US)
            return round(converted[0], 2)
        except (KeyError, TypeError):
            return None

    def _refresh_daily_precip_total(self, db_manager):
        try:
            timespan = weeutil.weeutil.archiveDaySpan(time.time())
            vt = weewx.xtypes.get_aggregate("rain", timespan, "sum", db_manager)
            converted = weewx.units.convertStd(vt, weewx.US)
            self._last_precip_total = round(converted[0], 2) if converted[0] is not None else None
        except Exception:
            weewx.debug and print(traceback.format_exc())
            # leave the previous value in place rather than blanking it out

    def _build_output(self, record):
        dt = record.get("dateTime", time.time())
        obs_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(dt))
        obs_local = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(dt))
        g = lambda obs: self._to_us(record, obs)

        return {
            "stationID": self.station_id,
            "obsTimeLocal": obs_local,
            "obsTimeUtc": obs_utc,
            "neighborhood": self.neighborhood,
            "humidity": g("outHumidity"),
            "winddir": g("windDir"),
            "uv": g("UV"),
            "solarRadiation": g("radiation"),
            "temp": g("outTemp"),
            "heatIndex": g("heatindex"),
            "windChill": g("windchill"),
            "dewpt": g("dewpoint"),
            "windSpeed": g("windSpeed"),
            "windGust": g("windGust"),
            "pressure": g("barometer"),
            "precipRate": g("rainRate"),
            "precipTotal": self._last_precip_total,
            "source": "local",
        }

    @staticmethod
    def _atomic_write_json(path, obj):
        tmp = path + ".tmp"
        with open(tmp, "w") as fp:
            json.dump(obj, fp, indent=2)
        os.replace(tmp, path)

    # -- event handlers -------------------------------------------------

    def new_loop_packet(self, event):
        try:
            output = self._build_output(event.packet)
            self._atomic_write_json(self.weather_json, output)
        except Exception:
            print("JsonExportService: error handling loop packet")
            print(traceback.format_exc())

    def new_archive_record(self, event):
        try:
            db_manager = self.engine.db_binder.get_manager(self.data_binding)
            self._refresh_daily_precip_total(db_manager)
            output = self._build_output(event.record)

            history = []
            if os.path.exists(self.history_json):
                try:
                    with open(self.history_json) as fp:
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
            history = history[-self.max_history_entries:]
            self._atomic_write_json(self.history_json, history)
        except Exception:
            print("JsonExportService: error handling archive record")
            print(traceback.format_exc())
