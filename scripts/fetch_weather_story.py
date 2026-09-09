#!/usr/bin/env python3
import os
import re
import sys
from pathlib import Path
import urllib.request

PAGE_URL = "https://www.weather.gov/pbz/weatherstory"

# Target path: resolves to /data/pbz_weather_story.png relative to /scripts
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR.parent / "data"
DEST_PATH = OUTPUT_DIR / "pbz_weather_story.png"

# Standard browser headers required to pass NWS Akamai firewall checks in GH Actions
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

def get_latest_image_url() -> str:
    """Scrapes the PBZ page to find the active Weather Story image path."""
    req = urllib.request.Request(PAGE_URL, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            html = response.read().decode("utf-8", errors="ignore")
            
            # Match image tags or javascript paths pointing to PBZ weather story images
            patterns = [
                r'src=["\']([^"\']*(?:weatherstory|wxstory)[^"\']*\.(?:png|jpg|jpeg))["\']',
                r'["\'](/images/pbz/[^"\']+\.(?:png|jpg|jpeg))["\']',
            ]
            
            for pattern in patterns:
                match = re.search(pattern, html, re.IGNORECASE)
                if match:
                    img_path = match.group(1)
                    if img_path.startswith("//"):
                        return f"https:{img_path}"
                    elif img_path.startswith("/"):
                        return f"https://www.weather.gov{img_path}"
                    elif img_path.startswith("http"):
                        return img_path
                    else:
                        return f"https://www.weather.gov/pbz/{img_path}"
                        
    except Exception as e:
        print(f"Error scraping {PAGE_URL}: {e}")
        
    return None

def fetch_weather_story():
    image_url = get_latest_image_url()
    
    if not image_url:
        print("No active Weather Story image found on page. Skipping download.")
        # Exit cleanly so the workflow does not fail when no graphic is available
        sys.exit(0)
        
    print(f"Fetching Weather Story graphic: {image_url}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = DEST_PATH.with_suffix(".tmp")
    
    req = urllib.request.Request(image_url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as response, open(temp_path, "wb") as out_file:
            out_file.write(response.read())
        
        # Atomic file replacement
        temp_path.replace(DEST_PATH)
        print(f"Successfully saved graphic to {DEST_PATH}")
    except Exception as e:
        print(f"Error downloading graphic: {e}")
        if temp_path.exists():
            temp_path.unlink()
        sys.exit(1)

if __name__ == "__main__":
    fetch_weather_story()
    
