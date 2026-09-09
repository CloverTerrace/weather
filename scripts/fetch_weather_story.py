#!/usr/bin/env python3
import os
import re
from pathlib import Path
import urllib.request

# NWS Pittsburgh Weather Story URLs
PAGE_URL = "https://www.weather.gov/pbz/weatherstory"
FALLBACK_IMG_URL = "https://www.weather.gov/images/pbz/weatherstory/weatherstory.png"

# Target path: resolves to /data/pbz_weather_story.png relative to /scripts
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR.parent / "data"
DEST_PATH = OUTPUT_DIR / "pbz_weather_story.png"

# NWS servers block default python-urllib user agents
HEADERS = {
    "User-Agent": "CloverTerraceWeatherBot/1.0 (https://github.com/my-weather-dashboard)"
}

def get_latest_image_url() -> str:
    """Scrapes the PBZ page to find the current dynamically linked Weather Story graphic."""
    try:
        req = urllib.request.Request(PAGE_URL, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode("utf-8")
            # Extract image path from page markup
            match = re.search(r'src="(/images/pbz/weatherstory/[^"]+\.(?:png|jpg|jpeg))"', html, re.IGNORECASE)
            if match:
                return f"https://www.weather.gov{match.group(1)}"
    except Exception as e:
        print(f"Warning: Scraping PBZ page failed ({e}). Falling back to default URL.")
    
    return FALLBACK_IMG_URL

def fetch_weather_story():
    image_url = get_latest_image_url()
    print(f"Fetching Weather Story graphic: {image_url}")
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = DEST_PATH.with_suffix(".tmp")
    
    req = urllib.request.Request(image_url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as response, open(temp_path, "wb") as out_file:
            out_file.write(response.read())
        
        # Atomic replacement to prevent broken image reads
        temp_path.replace(DEST_PATH)
        print(f"Successfully saved graphic to {DEST_PATH}")
    except Exception as e:
        print(f"Error downloading graphic: {e}")
        if temp_path.exists():
            temp_path.unlink()

if __name__ == "__main__":
    fetch_weather_story()
  
