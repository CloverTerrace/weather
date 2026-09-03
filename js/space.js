const SKY_REFRESH_MS = 15 * 60 * 1000;

document.addEventListener('DOMContentLoaded', () => {
  loadLiveSky().catch(() => {});
  fetchKpIndex();
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
  if (titleEl) titleEl.textContent = '';

  if (!img) return;

  const loadImage = new Promise((resolve) => {
    img.onload = () => {
      img.classList.add('is-loaded');
      resolve();
    };
    img.onerror = () => resolve();
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
  updateSpaceWeatherNote();
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
    if (obj.x === null || obj.x === undefined || obj.y === null || obj.y === undefined) return;
    const { leftPct, topPct } = renderSpaceToPercent(
      obj.x, obj.y, img.naturalWidth, img.naturalHeight, cover, containerW, containerH
    );
    if (leftPct < -10 || leftPct > 110 || topPct < -10 || topPct > 110) return;

    const marker = document.createElement('div');
    marker.className = 'sky-marker is-shown';
    marker.dataset.type = obj.type;
    marker.style.left = `${leftPct}%`;
    marker.style.top = `${topPct}%`;
    marker.style.cursor = 'pointer';

    const dot = document.createElement('div');
    dot.className = 'sky-marker-dot';

    const label = document.createElement('div');
    label.className = 'sky-marker-label';
    label.textContent = buildMarkerLabel(obj);

    marker.appendChild(dot);
    marker.appendChild(label);
    overlay.appendChild(marker);

    marker.addEventListener('click', () => openCelestialModal(obj));
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

let latestAuroraData = null;

async function fetchKpIndex() {
  const kpValEl = document.getElementById('kp-value');
  const kpChipEl = document.getElementById('kp-chip');

  try {
    const res = await fetch(`data/aurora.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`aurora.json ${res.status}`);
    const data = await res.json();
    latestAuroraData = data;

    if (kpValEl && typeof data.kp === 'number') {
      kpValEl.textContent = data.kp.toFixed(1);
    }
    if (kpChipEl && data.auroraChance) {
      kpChipEl.textContent = `Aurora chance: ${data.auroraChance}`;
      kpChipEl.dataset.level = auroraLevelSlug(data.auroraChance);
    }
    renderKpSparkline(data.history || []);
    updateSpaceWeatherNote();
    return;
  } catch (e) {
    if (kpValEl) kpValEl.textContent = 'N/A';
    if (kpChipEl) {
      kpChipEl.textContent = 'Kp data unavailable';
      kpChipEl.dataset.level = 'unknown';
    }
  }
}

function auroraLevelSlug(chance) {
  if (chance === 'Likely!') return 'high';
  if (chance === 'Possible!') return 'elevated';
  if (chance === 'Elevated') return 'watch';
  return 'low';
}

function renderKpSparkline(history) {
  const sparkEl = document.getElementById('kp-sparkline');
  if (!sparkEl) return;
  sparkEl.innerHTML = '';
  history.forEach(entry => {
    if (typeof entry.kp !== 'number') return;
    const bar = document.createElement('div');
    bar.className = 'kp-bar';
    const pct = Math.max(4, Math.min(100, (entry.kp / 9) * 100));
    bar.style.height = `${pct}%`;
    bar.style.setProperty('--bar-color', kpBarColor(entry.kp));
    bar.title = `Kp ${entry.kp.toFixed(1)} — ${entry.time || ''}`;
    sparkEl.appendChild(bar);
  });
}

function kpBarColor(kp) {
  if (kp >= 6) return '#f87171';
  if (kp >= 5) return '#fb923c';
  if (kp >= 4) return '#fbbf24';
  return '#4ade80';
}

function updateSpaceWeatherNote() {
  const noteEl = document.getElementById('kp-dark-note');
  if (!noteEl || !latestAuroraData || !latestOverlayData) return;
  const sunIsUp = latestOverlayData.objects.some(o => o.type === 'sun');
  noteEl.textContent = sunIsUp
    ? 'Daylight right now — any aurora would be washed out.'
    : 'The sun is below the horizon — dark enough for aurora to be visible if it happens.';
}

const CONSTELLATION_INFO = {
  'Ursa Major': { star: 'Alioth', mag: 1.76, fact: 'Home of the Big Dipper asterism.' },
  'Leo': { star: 'Regulus', mag: 1.35, fact: "Regulus marks the lion's heart." },
  'Boötes': { star: 'Arcturus', mag: -0.05, fact: 'Follow the Big Dipper’s handle to "arc to Arcturus."' },
  'Cygnus': { star: 'Deneb', mag: 1.25, fact: 'Forms the Northern Cross, part of the Summer Triangle.' },
  'Lyra': { star: 'Vega', mag: 0.03, fact: 'One of the brightest stars in the northern sky.' },
  'Aquila': { star: 'Altair', mag: 0.77, fact: 'Completes the Summer Triangle with Vega and Deneb.' },
  'Scorpius': { star: 'Antares', mag: 1.06, fact: 'A red supergiant marking the scorpion’s heart.' },
  'Pegasus': { star: 'Enif', mag: 2.4, fact: 'Anchors the Great Square asterism.' },
  'Andromeda': { star: 'Alpheratz', mag: 2.06, fact: 'Home to the Andromeda Galaxy, our nearest large spiral neighbor.' },
  'Cassiopeia': { star: 'Schedar', mag: 2.24, fact: 'Its W shape circles the north celestial pole.' },
  'Orion': { star: 'Rigel', mag: 0.13, fact: "Marked by the three-star Orion's Belt." },
  'Taurus': { star: 'Aldebaran', mag: 0.85, fact: 'The bull’s red eye, near the Pleiades cluster.' },
  'Gemini': { star: 'Pollux', mag: 1.14, fact: 'The twins, marked by stars Castor and Pollux.' },
  'Canis Major': { star: 'Sirius', mag: -1.46, fact: 'Home to Sirius, the brightest star in the night sky.' },
};

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

  list.innerHTML = seasonal[season].map(name => {
    const info = CONSTELLATION_INFO[name];
    if (!info) return `<li><span class="constellation-name">${name}</span></li>`;
    return `<li>
      <span class="constellation-name">${name}</span>
      <span class="constellation-fact">Brightest: ${info.star} (mag ${info.mag}) — ${info.fact}</span>
    </li>`;
  }).join('');
}

function formatLocalTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '--';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function altDescription(alt) {
  if (alt < 20) return 'low';
  if (alt < 50) return 'mid-sky';
  return 'high overhead';
}

function compassFromAz(az) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const idx = Math.round(az / 22.5) % 16;
  return dirs[idx];
}

const modal = document.getElementById('celestial-modal');
const modalContent = document.getElementById('modal-content');
const closeModalBtn = document.getElementById('close-modal');

closeModalBtn.addEventListener('click', () => {
  modal.classList.add('hidden');
});

function openCelestialModal(obj) {
  modal.classList.remove('hidden');
  
  if (obj.type === 'moon') {
    modalContent.innerHTML = `
      <h2 style="color: #a5c0ee; margin-top: 0;">The Moon</h2>
      <div style="font-size: 1.5rem; font-weight: 700; margin-bottom: 1rem;">${obj.phase_name || '--'}</div>
      <ul class="moon-detail-list">
        <li><span class="moon-detail-label">Illumination</span><span>${Math.round((obj.illumination || 0) * 100)}%</span></li>
        <li><span class="moon-detail-label">Moonrise</span><span>${obj.next_moonrise ? formatLocalTime(obj.next_moonrise) : '--'}</span></li>
        <li><span class="moon-detail-label">Moonset</span><span>${obj.next_moonset ? formatLocalTime(obj.next_moonset) : '--'}</span></li>
      </ul>
    `;
  } else if (obj.type === 'planet') {
    const magText = typeof obj.magnitude === 'number' ? `Magnitude ${obj.magnitude.toFixed(1)}` : '';
    modalContent.innerHTML = `
      <h2 style="color: #a5c0ee; margin-top: 0;">${obj.name}</h2>
      <div style="font-size: 1.2rem; margin-bottom: 1rem;">${magText}</div>
      <p style="font-size: 0.9rem; color: rgba(246, 248, 250, 0.8);">
        Currently ${altDescription(obj.alt)} in the ${compassFromAz(obj.az)}.
      </p>
    `;
  } else {
    modalContent.innerHTML = `
      <h2 style="color: #a5c0ee; margin-top: 0;">${obj.name}</h2>
      <p style="font-size: 0.9rem;">Type: ${obj.type}</p>
    `;
  }
}
