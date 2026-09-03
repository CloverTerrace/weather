const SKY_REFRESH_MS = 15 * 60 * 1000; // matches the server render cadence (~15-30min)

document.addEventListener('DOMContentLoaded', () => {
  loadLiveSky();
  fetchKpIndex();
  calculateMoonPhase();
  getVisibleConstellations();

  window.addEventListener('resize', debounce(renderSkyOverlay, 150));
  window.addEventListener('orientationchange', debounce(renderSkyOverlay, 150));
  setInterval(loadLiveSky, SKY_REFRESH_MS);
});

let latestOverlayData = null;

// Load the live 4K sky render + its matching overlay data together, using
// the same cache-busting timestamp for both so they never show a render
// and a HUD from two different moments.
function loadLiveSky() {
  const timestamp = new Date().getTime();
  const img = document.getElementById('sky-render-img');

  img.classList.remove('is-loaded');
  img.onload = () => {
    img.classList.add('is-loaded');
    renderSkyOverlay(); // natural width/height only available once loaded
  };
  img.src = `assets/skyrender/sky-bg.png?t=${timestamp}`;

  fetchSkyOverlay(timestamp);

  const titleEl = document.getElementById('apod-title');
  if (titleEl) {
    titleEl.textContent = 'Live 4K Night Sky View';
  }
}

async function fetchSkyOverlay(timestamp) {
  try {
    const res = await fetch(`assets/skyrender/sky_overlay.json?t=${timestamp}`);
    latestOverlayData = await res.json();
    renderSkyOverlay();
  } catch (err) {
    latestOverlayData = null;
  }
}

// Given the sky-stage container's box and the image's natural pixel size,
// figure out exactly how `object-fit: cover` scaled/cropped it — needed so
// overlay markers (in the render's own -1..1 normalized space) land on the
// same sky feature regardless of the viewport's aspect ratio.
function computeCoverRect(naturalW, naturalH, containerW, containerH) {
  const scale = Math.max(containerW / naturalW, containerH / naturalH);
  const renderedW = naturalW * scale;
  const renderedH = naturalH * scale;
  return {
    scale,
    offsetX: (containerW - renderedW) / 2,
    offsetY: (containerH - renderedH) / 2,
  };
}

// Convert a render-space point (x,y in -1..1, zenith at 0,0, north up,
// east right — matching render_sky.py's stereographic projection exactly)
// into a percentage position over the sky-stage container.
function renderSpaceToPercent(x, y, naturalW, naturalH, cover, containerW, containerH) {
  const pixelX = ((x + 1) / 2) * naturalW;
  const pixelY = ((1 - y) / 2) * naturalH; // image rows increase downward
  const screenX = cover.offsetX + pixelX * cover.scale;
  const screenY = cover.offsetY + pixelY * cover.scale;
  return {
    leftPct: (screenX / containerW) * 100,
    topPct: (screenY / containerH) * 100,
  };
}

function renderSkyOverlay() {
  const img = document.getElementById('sky-render-img');
  const stage = document.querySelector('.sky-stage');
  const overlay = document.getElementById('sky-overlay');
  if (!img || !stage || !overlay || !img.naturalWidth) return;

  overlay.innerHTML = '';
  const containerW = stage.clientWidth;
  const containerH = stage.clientHeight;
  const cover = computeCoverRect(img.naturalWidth, img.naturalHeight, containerW, containerH);

  // Cardinal direction ticks around the horizon
  const cardinals = (latestOverlayData && latestOverlayData.cardinal_points) || {
    N: { x: 0, y: 1 }, E: { x: 1, y: 0 }, S: { x: 0, y: -1 }, W: { x: -1, y: 0 },
  };
  Object.entries(cardinals).forEach(([label, pos]) => {
    const { leftPct, topPct } = renderSpaceToPercent(
      pos.x, pos.y, img.naturalWidth, img.naturalHeight, cover, containerW, containerH
    );
    if (leftPct < -10 || leftPct > 110 || topPct < -10 || topPct > 110) return;
    const tick = document.createElement('div');
    tick.className = 'sky-cardinal';
    tick.style.left = `${leftPct}%`;
    tick.style.top = `${topPct}%`;
    tick.textContent = label;
    overlay.appendChild(tick);
  });

  if (!latestOverlayData || !Array.isArray(latestOverlayData.objects)) return;

  latestOverlayData.objects.forEach(obj => {
    const { leftPct, topPct } = renderSpaceToPercent(
      obj.x, obj.y, img.naturalWidth, img.naturalHeight, cover, containerW, containerH
    );
    // Skip markers that landed outside the visible cropped area
    if (leftPct < -5 || leftPct > 105 || topPct < -5 || topPct > 105) return;

    const marker = document.createElement('div');
    marker.className = 'sky-marker';
    marker.dataset.type = obj.type;
    marker.style.left = `${leftPct}%`;
    marker.style.top = `${topPct}%`;

    const dot = document.createElement('div');
    dot.className = 'sky-marker-dot';

    const label = document.createElement('div');
    label.className = 'sky-marker-label';
    label.textContent = buildMarkerLabel(obj);

    marker.appendChild(dot);
    marker.appendChild(label);
    overlay.appendChild(marker);

    // fade in after layout settles
    requestAnimationFrame(() => marker.classList.add('is-shown'));
  });
}

function buildMarkerLabel(obj) {
  if (obj.type === 'moon' && typeof obj.illumination === 'number') {
    return `Moon ${Math.round(obj.illumination * 100)}%`;
  }
  if (obj.type === 'satellite') {
    return obj.sunlit ? 'ISS (visible)' : 'ISS';
  }
  if (typeof obj.magnitude === 'number') {
    return `${obj.name} ${obj.magnitude.toFixed(1)}`;
  }
  return obj.name;
}

function debounce(fn, wait) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}


// 2. Fetch Live Planetary Kp Index from NOAA SWPC
async function fetchKpIndex() {
  try {
    const res = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    const data = await res.json();
    const latestEntry = data[data.length - 1]; // [time, kp, status, ...]
    const kp = parseFloat(latestEntry[1]);

    document.getElementById('kp-value').textContent = kp.toFixed(1);
    
    let status = 'Quiet (Poor Aurora / Clear Stargazing)';
    if (kp >= 5) status = 'Geomagnetic Storm! (Aurora Likely Visible)';
    else if (kp >= 3) status = 'Unsettled / Active Sky';
    
    document.getElementById('kp-status').textContent = status;
  } catch (err) {
    document.getElementById('kp-value').textContent = 'N/A';
  }
}

// 3. Moon Phase Calculation
function calculateMoonPhase() {
  const date = new Date();
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  let day = date.getDate();

  if (month < 3) { year--; month += 12; }
  month++;
  let c = 365.25 * year;
  let e = 30.6 * month;
  let jd = c + e + day - 694039.09; 
  jd /= 29.5305882; 
  let b = parseInt(jd); 
  jd -= b; 
  
  let phaseIndex = Math.round(jd * 8) % 8;
  const phases = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Third Quarter', 'Waning Crescent'];
  
  document.getElementById('moon-phase').textContent = phases[phaseIndex];
  document.getElementById('moon-illumination').textContent = `Cycle Progress: ${(jd * 100).toFixed(0)}%`;
}

// 4. Seasonal Constellations Helper
function getVisibleConstellations() {
  const month = new Date().getMonth();
  const list = document.getElementById('constellation-list');
  
  // Seasonal mapping for Northern Hemisphere
  const seasonal = {
    Spring: ['Ursa Major', 'Leo', 'Boötes'],
    Summer: ['Cygnus', 'Lyra', 'Aquila', 'Scorpius'],
    Autumn: ['Pegasus', 'Andromeda', 'Cassiopeia'],
    Winter: ['Orion', 'Taurus', 'Gemini', 'Canis Major']
  };

  let season = 'Winter';
  if (month >= 2 && month <= 4) season = 'Spring';
  else if (month >= 5 && month <= 7) season = 'Summer';
  else if (month >= 8 && month <= 10) season = 'Autumn';

  list.innerHTML = seasonal[season].map(c => `<li>${c}</li>`).join('');
}
