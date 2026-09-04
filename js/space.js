const SKY_REFRESH_MS = 15 * 60 * 1000;

document.addEventListener('DOMContentLoaded', () => {
  getVisibleConstellations(); // seasonal fallback, shown instantly before live data arrives
  loadLiveSky().catch(() => {});
  fetchKpIndex();
  setupCardArrows();
  setupSkyPan();

  window.addEventListener('resize', debounce(() => {
    clearConstellationHighlight();
    revertConstellationZoom();
    renderSkyOverlay();
    updateCardArrowVisibility();
    updateActiveCardHeight();
  }, 150));
  window.addEventListener('orientationchange', debounce(() => {
    clearConstellationHighlight();
    revertConstellationZoom();
    renderSkyOverlay();
    updateActiveCardHeight();
  }, 150));
  setInterval(loadLiveSky, SKY_REFRESH_MS);
  setInterval(fetchKpIndex, SKY_REFRESH_MS);
});

let latestOverlayData = null;
let latestAuroraData = null;

// Sky pan/zoom state. The sky render is a fixed 16:9 image; on narrow
// (mobile/portrait) viewports it's taller-than-wide, so filling the
// viewport height leaves extra image width off both sides — panX lets
// the user drag to explore that hidden east/west sky instead of it just
// being permanently cropped off like a plain object-fit:cover would do.
let panX = 0;
let userHasPanned = false;
let skyLayout = { scale: 1, paneWidth: 0, paneHeight: 0 };

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
  getVisibleConstellations(); // re-render with real live-sky data, now that it's in
  // the sun-up/down status may have changed, which affects the Kp bar's wording
  if (latestAuroraData) updateKpUI(latestAuroraData);
}

// Filling the viewport height exactly (scale=1:1 crop) is what the old
// object-fit:cover behavior did too, so this isn't new — but it does mean
// on a narrow phone only a fairly tight vertical slice of the render is
// ever visible. Backing off slightly lets a bit more sky show at once
// (small top/bottom letterbox, same navy as the render's own background so
// it's not visually obvious). Tune this number — or set it back to 1 — once
// you've seen it against the real generated sky-bg.png.
const SKY_FIT_PADDING = 0.85;

// Chooses a pane size that always fully fills the viewport's height (so
// nothing is cropped top/bottom) and, when the viewport is narrower than
// that, leaves the extra image width pannable rather than cropping the
// east/west sky. Only falls back to filling by width (which can crop
// top/bottom, matching the old cover behavior) for the rare case of a
// viewport wider than the image even after a height-fill.
function computeSkyLayout(naturalW, naturalH, containerW, containerH) {
  let scale = (containerH / naturalH) * SKY_FIT_PADDING;
  let paneWidth = naturalW * scale;
  let paneHeight = naturalH * scale;
  if (paneWidth < containerW) {
    scale = containerW / naturalW;
    paneWidth = containerW;
    paneHeight = naturalH * scale;
  }
  return { scale, paneWidth, paneHeight };
}

// Normalized stereographic (x, y in [-1, 1]) sky coords -> pixel position
// within the (unpanned) .sky-pan box. Panning is applied separately as a
// single transform on the whole pane, so every marker stays put relative
// to the stars around it while dragging.
function skyToPanPixels(x, y, naturalW, naturalH, scale) {
  return {
    x: ((x + 1) / 2) * naturalW * scale,
    y: ((1 - y) / 2) * naturalH * scale,
  };
}

function clampPanX(x, paneWidth, containerW) {
  const minX = Math.min(0, containerW - paneWidth);
  return Math.max(minX, Math.min(0, x));
}

function renderSkyOverlay() {
  const img = document.getElementById('sky-render-img');
  const viewport = document.getElementById('sky-viewport');
  const pan = document.getElementById('sky-pan');
  const overlay = document.getElementById('sky-overlay');
  if (!img || !viewport || !pan || !overlay || !img.naturalWidth) return;

  overlay.innerHTML = '';
  const containerW = viewport.clientWidth;
  const containerH = viewport.clientHeight;
  skyLayout = computeSkyLayout(img.naturalWidth, img.naturalHeight, containerW, containerH);
  const { scale, paneWidth, paneHeight } = skyLayout;

  pan.style.width = `${paneWidth}px`;
  pan.style.height = `${paneHeight}px`;
  pan.style.top = `${(containerH - paneHeight) / 2}px`;
  img.style.width = `${paneWidth}px`;
  img.style.height = `${paneHeight}px`;

  const pannable = paneWidth > containerW + 1;
  pan.classList.toggle('is-pannable', pannable);
  if (!pannable) {
    panX = 0;
  } else if (userHasPanned) {
    panX = clampPanX(panX, paneWidth, containerW);
  } else {
    panX = (containerW - paneWidth) / 2; // start centered, same framing as before
  }
  pan.style.transform = `translateX(${panX}px)`;

  const cardinals = (latestOverlayData && latestOverlayData.cardinal_points) || {
    N: { x: 0, y: 1 }, E: { x: 1, y: 0 }, S: { x: 0, y: -1 }, W: { x: -1, y: 0 },
  };
  Object.entries(cardinals).forEach(([label, pos]) => {
    const { x, y } = skyToPanPixels(pos.x, pos.y, img.naturalWidth, img.naturalHeight, scale);
    const tick = document.createElement('div');
    tick.className = 'sky-cardinal';
    tick.style.left = `${x}px`;
    tick.style.top = `${y}px`;
    tick.textContent = label;
    overlay.appendChild(tick);
  });

  if (!latestOverlayData || !Array.isArray(latestOverlayData.objects)) return;

  latestOverlayData.objects.forEach(obj => {
    if (obj.x === null || obj.x === undefined || obj.y === null || obj.y === undefined) return;
    const { x, y } = skyToPanPixels(obj.x, obj.y, img.naturalWidth, img.naturalHeight, scale);

    const marker = document.createElement('div');
    marker.className = 'sky-marker is-shown';
    marker.dataset.type = obj.type;
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
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

/*----- drag-to-pan the sky (mainly relevant on narrow/mobile viewports,
   where the render's extra width beyond the screen is otherwise hidden) -----*/
function setupSkyPan() {
  const viewport = document.getElementById('sky-viewport');
  const pan = document.getElementById('sky-pan');
  if (!viewport || !pan) return;

  let dragging = false;
  let startClientX = 0;
  let startPanX = 0;

  viewport.addEventListener('pointerdown', (e) => {
    // dragging always wins over an in-progress constellation callout — snap
    // straight back to the normal view so panning is never blocked by it
    if (constellationZoomActive) revertConstellationZoom();
    if (!pan.classList.contains('is-pannable')) return;
    dragging = true;
    userHasPanned = true;
    startClientX = e.clientX;
    startPanX = panX;
    pan.classList.add('is-panning');
    try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startClientX;
    panX = clampPanX(startPanX + dx, skyLayout.paneWidth, viewport.clientWidth);
    pan.style.transform = `translateX(${panX}px)`;
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    pan.classList.remove('is-panning');
    try { viewport.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
}

// Brings a given x position (in .sky-pan pixel space) to the center of the
// viewport, so tapping a constellation in the list scrolls it into view if
// dragging had left it off-screen.
function panToPanX(targetX) {
  const viewport = document.getElementById('sky-viewport');
  const pan = document.getElementById('sky-pan');
  if (!viewport || !pan || !pan.classList.contains('is-pannable')) return;
  const containerW = viewport.clientWidth;
  panX = clampPanX(containerW / 2 - targetX, skyLayout.paneWidth, containerW);
  userHasPanned = true;
  pan.style.transform = `translateX(${panX}px)`;
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

  left.addEventListener('click', () => row.scrollBy({ left: -row.clientWidth, behavior: 'smooth' }));
  right.addEventListener('click', () => row.scrollBy({ left: row.clientWidth, behavior: 'smooth' }));
  row.addEventListener('scroll', debounce(updateActiveCardHeight, 80), { passive: true });
  updateCardArrowVisibility();
  updateActiveCardHeight();
}

// Sizes the row (and, in turn, the dock + its scrim above it, since they
// simply follow the row's natural content height) to whichever card is
// currently swiped into view — not the tallest card in the carousel — so
// unused vertical space always reads as sky rather than leftover scrim.
function updateActiveCardHeight() {
  const row = document.getElementById('sky-card-row');
  if (!row || !row.children.length) return;
  const width = row.clientWidth || 1;
  const index = Math.round(row.scrollLeft / width);
  const clamped = Math.max(0, Math.min(row.children.length - 1, index));
  const active = row.children[clamped];
  if (active) {
    row.style.height = `${active.scrollHeight}px`;
  }
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

// Only used as an instant-paint placeholder before real overlay data has
// loaded — NOT what determines the final list once live data is in.
function seasonalFallbackNames() {
  const month = new Date().getMonth();
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
  return seasonal[season];
}

function getVisibleConstellations() {
  const list = document.getElementById('constellation-list');
  if (!list) return;

  const liveEntries = latestOverlayData && Array.isArray(latestOverlayData.constellations)
    ? latestOverlayData.constellations.filter(c => c.x !== null && c.x !== undefined && c.y !== null && c.y !== undefined)
    : null;

  let names;
  if (liveEntries) {
    // highest-in-sky first — most useful order for "what am I looking at right now"
    liveEntries.sort((a, b) => (b.alt ?? -999) - (a.alt ?? -999));
    names = liveEntries.map(c => c.name);
  } else {
    names = seasonalFallbackNames();
  }

  if (names.length === 0) {
    list.innerHTML = `<li>None of the tracked constellations are above the horizon right now.</li>`;
    updateCardArrowVisibility();
    updateActiveCardHeight();
    return;
  }

  list.innerHTML = names.map(name => {
    const info = CONSTELLATION_INFO[name];
    if (!info) return `<li data-name="${name}"><span class="constellation-name">${name}</span></li>`;
    return `<li data-name="${name}">
      <span class="constellation-name">${name}</span>
      <span class="constellation-fact">Brightest: ${info.star} (mag ${info.mag}) — ${info.fact}</span>
    </li>`;
  }).join('');

  list.querySelectorAll('li[data-name]').forEach(li => {
    li.addEventListener('click', () => {
      pulseTapFeedback(li);
      highlightConstellation(li.dataset.name);
    });
  });

  updateCardArrowVisibility();
  updateActiveCardHeight();
}

// Explicit press feedback for the constellation list rows: a brief
// highlight/scale pulse plus a light haptic tick where the browser
// supports it (mainly Android Chrome — no-op elsewhere).
function pulseTapFeedback(el) {
  el.classList.remove('is-tapped');
  void el.offsetWidth; // restart the transition if tapped again quickly
  el.classList.add('is-tapped');
  setTimeout(() => el.classList.remove('is-tapped'), 220);
  if (navigator.vibrate) navigator.vibrate(8);
}

/*----- tap-to-locate: trace the constellation's actual shape in the live sky -----*/
const CONSTELLATION_HIGHLIGHT_MS = 7000;
const CONSTELLATION_ZOOM = 1.6;
let constellationHighlightTimeout = null;
let constellationZoomActive = false;
let preZoomPanX = 0;
let preZoomTop = '';

function clearConstellationHighlight() {
  document.querySelectorAll('.sky-constellation-glow, .sky-constellation-highlight').forEach(el => el.remove());
  if (constellationHighlightTimeout) {
    clearTimeout(constellationHighlightTimeout);
    constellationHighlightTimeout = null;
  }
}

function highlightConstellation(name) {
  clearConstellationHighlight();
  revertConstellationZoom();

  const overlay = document.getElementById('sky-overlay');
  const img = document.getElementById('sky-render-img');
  if (!overlay || !img || !img.naturalWidth) return;

  const entry = latestOverlayData && Array.isArray(latestOverlayData.constellations)
    ? latestOverlayData.constellations.find(c => c.name === name)
    : null;

  const stars = entry && Array.isArray(entry.stars) ? entry.stars : [];
  const visibleStars = stars
    .map((s, i) => ({ x: s.x, y: s.y, i }))
    .filter(s => s.x !== null && s.x !== undefined && s.y !== null && s.y !== undefined);

  if (visibleStars.length === 0) {
    openConstellationUnavailableNote(name);
    return;
  }

  // pixel positions for every visible star, in unscaled .sky-pan local space
  const points = visibleStars.map(s => {
    const p = skyToPanPixels(s.x, s.y, img.naturalWidth, img.naturalHeight, skyLayout.scale);
    return { i: s.i, x: p.x, y: p.y };
  });

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const pad = 32; // breathing room around the outermost stars for the ambient glow

  const container = document.createElement('div');
  container.className = 'sky-constellation-highlight';
  const boxWidth = (maxX - minX) + pad * 2;
  const boxHeight = (maxY - minY) + pad * 2;
  container.style.left = `${minX - pad}px`;
  container.style.top = `${minY - pad}px`;
  container.style.width = `${boxWidth}px`;
  container.style.height = `${boxHeight}px`;

  const fieldGlow = document.createElement('div');
  fieldGlow.className = 'sky-constellation-field-glow';
  container.appendChild(fieldGlow);

  // faint connecting lines tracing the shape — only between stars that are
  // actually above the horizon right now
  const validIndices = new Set(visibleStars.map(s => s.i));
  const byIndex = new Map(points.map(p => [p.i, p]));
  const lines = (entry.lines || []).filter(([a, b]) => validIndices.has(a) && validIndices.has(b));

  if (lines.length) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sky-constellation-lines');
    svg.style.width = `${boxWidth}px`;
    svg.style.height = `${boxHeight}px`;
    lines.forEach(([a, b], idx) => {
      const p1 = byIndex.get(a), p2 = byIndex.get(b);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', p1.x - minX + pad);
      line.setAttribute('y1', p1.y - minY + pad);
      line.setAttribute('x2', p2.x - minX + pad);
      line.setAttribute('y2', p2.y - minY + pad);
      line.style.animationDelay = `${idx * 90}ms`;
      svg.appendChild(line);
    });
    container.appendChild(svg);
  }

  // small twinkling dot per star, on top of the lines, staggered so they
  // don't all pulse in lockstep
  points.forEach((p, idx) => {
    const dot = document.createElement('div');
    dot.className = 'sky-constellation-star';
    dot.style.left = `${p.x - minX + pad}px`;
    dot.style.top = `${p.y - minY + pad}px`;
    dot.style.animationDelay = `${idx * 220}ms`;
    container.appendChild(dot);
  });

  overlay.appendChild(container);
  constellationHighlightTimeout = setTimeout(() => {
    clearConstellationHighlight();
    revertConstellationZoom();
  }, CONSTELLATION_HIGHLIGHT_MS);

  // bring it into view if dragging had panned it off-screen; for shapes
  // small enough on screen to be hard to read, zoom in on them briefly too
  const zoomed = zoomToConstellation(cx, cy, maxX - minX, maxY - minY);
  if (!zoomed) panToPanX(cx);
}

// Briefly scales up .sky-pan (image + overlay together, so the highlighted
// shape stays pixel-aligned with the real stars under it) centered on the
// constellation's own midpoint, so a shape that's cramped at normal scale
// is easier to read. Centering on that exact point first — before scaling —
// means the zoom only ever reveals more of the area already in view, never
// content the pan/scroll model can't reach, so full sky panning still works
// exactly as before once the callout ends. Returns whether it zoomed.
function zoomToConstellation(cx, cy, spanX, spanY) {
  const viewport = document.getElementById('sky-viewport');
  const pan = document.getElementById('sky-pan');
  if (!viewport || !pan) return false;

  const containerW = viewport.clientWidth;
  const containerH = viewport.clientHeight;
  const largestSpan = Math.max(spanX, spanY, 1);
  if (largestSpan > Math.min(containerW, containerH) * 0.5) return false; // already legible at normal scale

  preZoomPanX = panX;
  preZoomTop = pan.style.top;

  panX = clampPanX(containerW / 2 - cx, skyLayout.paneWidth, containerW);
  const topOffset = containerH / 2 - cy;

  pan.classList.add('is-zooming');
  pan.style.top = `${topOffset}px`;
  pan.style.transformOrigin = `${cx}px ${cy}px`;
  pan.style.transform = `translateX(${panX}px) scale(${CONSTELLATION_ZOOM})`;
  constellationZoomActive = true;
  return true;
}

function revertConstellationZoom() {
  if (!constellationZoomActive) return;
  const pan = document.getElementById('sky-pan');
  constellationZoomActive = false;
  if (!pan) return;
  panX = preZoomPanX;
  pan.style.top = preZoomTop;
  pan.style.transform = `translateX(${panX}px) scale(1)`;
  pan.style.transformOrigin = '';
  setTimeout(() => pan.classList.remove('is-zooming'), 650); // let the zoom-out transition finish first
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

// Auto-close on scroll (the page uses scroll-snap to reveal the full sky below
// the card dock — a modal staying pinned to the screen while that happens
// reads as broken) and on any click outside the modal itself. Clicks on the
// elements that *open* the modal are excluded so opening one doesn't
// immediately re-trigger a close from the same click bubbling to document.
document.getElementById('space-page').addEventListener('scroll', () => {
  if (!modal.classList.contains('hidden')) {
    modal.classList.add('hidden');
  }
  clearConstellationHighlight();
  revertConstellationZoom();
}, { passive: true });

document.addEventListener('click', (e) => {
  if (modal.classList.contains('hidden')) return;
  if (modal.contains(e.target)) return;
  if (e.target.closest('.sky-marker, #kp-elevated-bar, #kp-alert-bar, .constellation-list li')) return;
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
