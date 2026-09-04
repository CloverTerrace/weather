const SKY_REFRESH_MS = 15 * 60 * 1000;

document.addEventListener('DOMContentLoaded', () => {
  loadLiveSky().catch(() => {});
  fetchKpIndex();
  getVisibleConstellations();
  setupCardArrows();

  window.addEventListener('resize', debounce(() => {
    renderSkyOverlay();
    updateCardArrowVisibility();
  }, 150));
  window.addEventListener('orientationchange', debounce(renderSkyOverlay, 150));
  setInterval(loadLiveSky, SKY_REFRESH_MS);
  setInterval(fetchKpIndex, SKY_REFRESH_MS);
});

let latestOverlayData = null;
let latestAuroraData = null;

async function loadLiveSky() {
  const timestamp = new Date().getTime();
  const img = document.getElementById('sky-render-img');
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
  // the sun-up/down status may have changed, which affects the Kp bar's wording
  if (latestAuroraData) updateKpUI(latestAuroraData);
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

    if (obj.type === 'moon') {
      marker.appendChild(buildMoonDisk(obj));
    } else {
      const dot = document.createElement('div');
      dot.className = 'sky-marker-dot';
      marker.appendChild(dot);
    }

    const label = document.createElement('div');
    label.className = 'sky-marker-label';
    label.textContent = buildMarkerLabel(obj);
    marker.appendChild(label);

    overlay.appendChild(marker);
    marker.addEventListener('click', () => openCelestialModal(obj));
  });
}

// Renders the moon marker as an actual shaded phase disk (lit half + a
// terminator ellipse that grows/shrinks with illumination) instead of a
// plain dot plus a percentage label.
function buildMoonDisk(obj) {
  const diameter = 20;
  const illum = typeof obj.illumination === 'number' ? obj.illumination : 0.5;
  const waxing = !/waning/i.test(obj.phase_name || '');

  const disk = document.createElement('div');
  disk.className = 'moon-disk';

  const litHalf = document.createElement('div');
  litHalf.className = `moon-lit-half ${waxing ? 'waxing' : 'waning'}`;
  disk.appendChild(litHalf);

  const terminator = document.createElement('div');
  terminator.className = 'moon-terminator';
  const width = Math.abs(2 * illum - 1) * diameter;
  terminator.style.width = `${width}px`;
  terminator.style.background = illum < 0.5 ? '#1c2033' : '#e7ebf2';
  disk.appendChild(terminator);

  return disk;
}

function buildMarkerLabel(obj) {
  if (obj.type === 'moon') {
    return 'Moon';
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

/*----- swipeable card row -----*/
function setupCardArrows() {
  const row = document.getElementById('sky-card-row');
  const left = document.getElementById('card-arrow-left');
  const right = document.getElementById('card-arrow-right');
  if (!row || !left || !right) return;

  left.addEventListener('click', () => row.scrollBy({ left: -260, behavior: 'smooth' }));
  right.addEventListener('click', () => row.scrollBy({ left: 260, behavior: 'smooth' }));
  updateCardArrowVisibility();
}

function updateCardArrowVisibility() {
  const row = document.getElementById('sky-card-row');
  const left = document.getElementById('card-arrow-left');
  const right = document.getElementById('card-arrow-right');
  if (!row || !left || !right) return;

  const scrollable = row.scrollWidth > row.clientWidth + 4;
  left.classList.toggle('is-disabled', !scrollable);
  right.classList.toggle('is-disabled', !scrollable);
}

/*----- Kp index: hidden unless activity is actually worth knowing about -----*/
async function fetchKpIndex() {
  try {
    const res = await fetch(`data/aurora.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`aurora.json ${res.status}`);
    const data = await res.json();
    latestAuroraData = data;
    updateKpUI(data);
  } catch (e) {
    latestAuroraData = null;
    updateKpUI(null);
  }
}

function auroraLevelSlug(chance) {
  if (chance === 'Likely!') return 'high';
  if (chance === 'Possible!') return 'elevated';
  if (chance === 'Elevated') return 'watch';
  return 'low';
}

function auroraContextNote() {
  const sunIsUp = latestOverlayData && Array.isArray(latestOverlayData.objects)
    ? latestOverlayData.objects.some(o => o.type === 'sun')
    : false;
  return sunIsUp ? 'aurora would be washed out in daylight right now' : 'aurora possible after dark';
}

function updateKpUI(data) {
  const elevatedBar = document.getElementById('kp-elevated-bar');
  const elevatedText = document.getElementById('kp-elevated-text');
  const alertBar = document.getElementById('kp-alert-bar');
  const alertHeadline = document.getElementById('kp-alert-headline');
  const alertBody = document.getElementById('kp-alert-body');
  if (!elevatedBar || !alertBar) return;

  if (!data || typeof data.kp !== 'number') {
    elevatedBar.classList.add('hidden');
    alertBar.classList.add('hidden');
    document.body.classList.remove('kp-severe');
    return;
  }

  const level = auroraLevelSlug(data.auroraChance);

  if (level === 'high') {
    elevatedBar.classList.add('hidden');
    alertHeadline.textContent = `Kp ${data.kp.toFixed(1)} — aurora likely tonight`;
    alertBody.textContent = auroraContextNote();
    alertBar.classList.remove('hidden');
    document.body.classList.add('kp-severe');
  } else if (level === 'elevated' || level === 'watch') {
    alertBar.classList.add('hidden');
    document.body.classList.remove('kp-severe');
    elevatedText.textContent = `Kp elevated — ${auroraContextNote()}`;
    elevatedBar.classList.remove('hidden');
  } else {
    elevatedBar.classList.add('hidden');
    alertBar.classList.add('hidden');
    document.body.classList.remove('kp-severe');
  }
}

function renderKpSparkline(history, targetId) {
  const sparkEl = document.getElementById(targetId);
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

function openKpModal() {
  modal.classList.remove('hidden');
  const kp = latestAuroraData && typeof latestAuroraData.kp === 'number' ? latestAuroraData.kp.toFixed(1) : '--';
  const chance = latestAuroraData && latestAuroraData.auroraChance ? latestAuroraData.auroraChance : 'Unknown';
  modalContent.innerHTML = `
    <h2 style="color: #a5c0ee; margin-top: 0;">Geomagnetic Kp Index</h2>
    <div style="font-size: 1.6rem; font-weight: 700; margin-bottom: 0.25rem;">${kp}</div>
    <div style="font-size: 0.85rem; color: rgba(246, 248, 250, 0.8); margin-bottom: 0.75rem;">Aurora chance: ${chance}</div>
    <div class="kp-sparkline" id="modal-kp-sparkline" aria-label="Recent Kp index trend"></div>
  `;
  renderKpSparkline((latestAuroraData && latestAuroraData.history) || [], 'modal-kp-sparkline');
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
    if (!info) return `<li data-name="${name}"><span class="constellation-name">${name}</span></li>`;
    return `<li data-name="${name}">
      <span class="constellation-name">${name}</span>
      <span class="constellation-fact">Brightest: ${info.star} (mag ${info.mag}) — ${info.fact}</span>
    </li>`;
  }).join('');

  list.querySelectorAll('li[data-name]').forEach(li => {
    li.addEventListener('click', () => highlightConstellation(li.dataset.name));
  });

  updateCardArrowVisibility();
}

/*----- tap-to-locate: highlight a constellation's anchor star in the live sky -----*/
function highlightConstellation(name) {
  document.querySelectorAll('.sky-constellation-glow').forEach(el => el.remove());

  const overlay = document.getElementById('sky-overlay');
  const img = document.getElementById('sky-render-img');
  const stage = document.querySelector('.sky-stage');
  if (!overlay || !img || !stage || !img.naturalWidth) return;

  const entry = latestOverlayData && Array.isArray(latestOverlayData.constellations)
    ? latestOverlayData.constellations.find(c => c.name === name)
    : null;

  if (!entry || entry.x === null || entry.x === undefined || entry.y === null || entry.y === undefined) {
    openConstellationUnavailableNote(name);
    return;
  }

  const cover = computeCoverRect(img.naturalWidth, img.naturalHeight, stage.clientWidth, stage.clientHeight);
  const { leftPct, topPct } = renderSpaceToPercent(
    entry.x, entry.y, img.naturalWidth, img.naturalHeight, cover, stage.clientWidth, stage.clientHeight
  );

  const glow = document.createElement('div');
  glow.className = 'sky-constellation-glow';
  glow.style.left = `${leftPct}%`;
  glow.style.top = `${topPct}%`;
  overlay.appendChild(glow);
  setTimeout(() => glow.remove(), 6000);
}

function openConstellationUnavailableNote(name) {
  modal.classList.remove('hidden');
  modalContent.innerHTML = `
    <h2 style="color: #a5c0ee; margin-top: 0;">${name}</h2>
    <p style="font-size: 0.9rem;">Not currently above the horizon from here.</p>
  `;
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

document.getElementById('kp-elevated-bar').addEventListener('click', openKpModal);
document.getElementById('kp-alert-bar').addEventListener('click', openKpModal);

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
