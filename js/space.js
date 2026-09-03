const SKY_REFRESH_MS = 15 * 60 * 1000;

document.addEventListener('DOMContentLoaded', () => {
  // Run tasks independently so one failure never blocks the rest of the page
  loadLiveSky().catch(() => {});
  fetchKpIndex();
  calculateMoonPhase();
  getVisibleConstellations();

  window.addEventListener('resize', debounce(renderSkyOverlay, 150));
  window.addEventListener('orientationchange', debounce(renderSkyOverlay, 150));
  setInterval(loadLiveSky, SKY_REFRESH_MS);
});

let latestOverlayData = null;

async function loadLiveSky() {
  const timestamp = new Date().getTime();
  const img = document.getElementById('sky-render-img');
  const titleEl = document.getElementById('apod-title');
  if (titleEl) titleEl.textContent = 'Live 4K Night Sky View';

  if (!img) return;
  img.classList.remove('is-loaded');

  const loadImage = new Promise((resolve) => {
    img.onload = () => {
      img.classList.add('is-loaded');
      resolve();
    };
    img.onerror = () => {
      resolve(); // Resolve anyway so Promise.all never hangs
    };
    img.src = `assets/skyrender/sky-bg.png?t=${timestamp}`;

    if (img.complete) {
      img.classList.add('is-loaded');
      resolve();
    }
  });

  const loadJson = fetch(`assets/skyrender/sky_overlay.json?t=${timestamp}`)
    .then(res => res.ok ? res.json() : null)
    .then(data => { latestOverlayData = data; })
    .catch(() => { latestOverlayData = null; });

  await Promise.all([loadImage, loadJson]);
  renderSkyOverlay();
}

function computeCoverRect(naturalW, naturalH, containerW, containerH) {
  const scale = Math.max(containerW / naturalW, containerH / naturalH);
  return {
    scale,
    offsetX: (containerW - naturalW * scale) / 2,
    offsetY: (containerH - naturalH * scale) / 2,
  };
}

function renderSpaceToPercent(x, y, naturalW, naturalH, cover, containerW, containerH) {
  const pixelX = ((x + 1) / 2) * naturalW;
  const pixelY = ((1 - y) / 2) * naturalH;
  return {
    leftPct: ((cover.offsetX + pixelX * cover.scale) / containerW) * 100,
    topPct: ((cover.offsetY + pixelY * cover.scale) / containerH) * 100,
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

async function fetchKpIndex() {
  try {
    const res = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    const data = await res.json();
    const latestEntry = data[data.length - 1];
    const kp = parseFloat(latestEntry[1]);

    const kpValEl = document.getElementById('kp-value');
    if (kpValEl) kpValEl.textContent = kp.toFixed(1);

    let status = 'Quiet (Poor Aurora / Clear Stargazing)';
    if (kp >= 5) status = 'Geomagnetic Storm! (Aurora Likely Visible)';
    else if (kp >= 3) status = 'Unsettled / Active Sky';

    const kpStatusEl = document.getElementById('kp-status');
    if (kpStatusEl) kpStatusEl.textContent = status;
  } catch (err) {
    const kpValEl = document.getElementById('kp-value');
    if (kpValEl) kpValEl.textContent = 'N/A';
  }
}

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

  const moonPhaseEl = document.getElementById('moon-phase');
  const moonIllumEl = document.getElementById('moon-illumination');
  if (moonPhaseEl) moonPhaseEl.textContent = phases[phaseIndex];
  if (moonIllumEl) moonIllumEl.textContent = `Cycle Progress: ${(jd * 100).toFixed(0)}%`;
}

function getVisibleConstellations() {
  const month = new Date().getMonth();
  const list = document.getElementById('constellation-list');
  if (!list) return;

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
