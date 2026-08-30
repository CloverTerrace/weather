/* Clover Terrace Gardening page */
(() => {
  const DATA_REPO_BASE = 'https://raw.githubusercontent.com/CloverTerrace/weather-data/main/data';
  const WEATHER_URL = `${DATA_REPO_BASE}/weather.json`;
  const HISTORY_URL = `${DATA_REPO_BASE}/history.json`;

  const LAT = 40.616;
  const LON = -80.274;

  const STATION_TIMEZONE = 'America/New_York';

  const $ = id => document.getElementById(id);

  const fmt = (value, decimals = 1, suffix = '') =>
    Number.isFinite(Number(value)) ? `${Number(value).toFixed(decimals)}${suffix}` : '--';

  // prevent user clock fron interfering with observation times
  function stationDate(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    return new Date(Date.UTC(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6] || 0)
    ));
  }

  function localDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '--';
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function formatDate(dateString) {
    const d = dateString instanceof Date ? dateString : new Date(dateString);
    if (Number.isNaN(d.getTime())) return '--';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric'
    }).format(d);
  }

  function formatDateTime(value) {
    const d = stationDate(value);
    if (!d) return '--';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(d);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  // sets a "<value> / <colored status word> / <caption>" stat card in one
  // call. `valueId` is the numeric/text span, `statusId` is the colored
  // status word, `captionId` is the small note underneath. `cls` is one of
  // '', 'good', 'warn', 'danger', 'info', or a season-* class (see CSS).
  function setStatCard({ valueId, statusId, captionId, value, status, cls, caption }) {
    setText(valueId, value);
    const statusEl = $(statusId);
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = `garden-stat-status ${cls || ''}`.trim();
    }
    setText(captionId, caption);
  }

  function normalizeHistory(history) {
    return (Array.isArray(history) ? history : [])
      .map(entry => ({
        ...entry,
        date: stationDate(entry.time)
      }))
      .filter(entry => entry.date && Number.isFinite(Number(entry.temp)))
      .sort((a, b) => a.date - b.date);
  }

  function calculateGDD(history, baseTemp) {
    const byDay = new Map();

    for (const entry of history) {
      const key = localDateKey(entry.date);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(Number(entry.temp));
    }

    let total = 0;
    for (const temps of byDay.values()) {
      if (!temps.length) continue;
      const min = Math.min(...temps);
      const max = Math.max(...temps);
      const mean = (min + max) / 2;
      total += Math.max(0, mean - baseTemp);
    }

    return total;
  }

  // Vapor Pressure Deficit (kPa) -- same Tetens-equation formula the main
  // dashboard uses for its "muggy/dry" comfort read, but reframed here for
  // gardening: low VPD tracks with fungal/disease risk (air too saturated
  // for plants to transpire), high VPD tracks with water stress (plants
  // losing moisture faster than roots can keep up).
  function calculateVPD(tempF, humidity) {
    if (tempF === undefined || tempF === null || humidity === undefined || humidity === null) return null;
    if (isNaN(tempF) || isNaN(humidity)) return null;
    const tempC = (tempF - 32) * 5 / 9;
    const es = 0.6108 * Math.exp(17.27 * tempC / (tempC + 237.3));
    const ea = es * (humidity / 100);
    return es - ea;
  }

  function classifyVpd(vpd) {
    if (vpd === null || isNaN(vpd)) {
      return { status: '--', cls: '', caption: 'Waiting on station data…' };
    }
    if (vpd < 0.4) {
      return { status: 'Disease Risk', cls: 'warn', caption: 'Humid air — watch for fungal issues like powdery mildew.' };
    }
    if (vpd <= 1.6) {
      return { status: 'Ideal', cls: 'good', caption: 'Good range for transpiration and steady growth.' };
    }
    return { status: 'Water Stress', cls: 'danger', caption: 'Plants are losing moisture fast — check soil before it dries out.' };
  }

  // ---------- rain-chance forecast (distinct from the hero's rain-gauge
  // totals, which look backward at what's already fallen) ----------
  function getUpcomingRainChance(periods) {
    const now = Date.now();
    const horizon = now + 24 * 60 * 60 * 1000;
    let best = null;

    for (const period of periods || []) {
      const t = new Date(period.startTime).getTime();
      if (!Number.isFinite(t) || t < now || t > horizon) continue;
      const pop = period.probabilityOfPrecipitation && typeof period.probabilityOfPrecipitation.value === 'number'
        ? period.probabilityOfPrecipitation.value
        : null;
      if (pop === null) continue;
      if (!best || pop > best.pop) best = { pop, name: period.name };
    }

    return best;
  }

  function classifyRainChance(pop) {
    if (pop === null || pop === undefined || isNaN(pop)) {
      return { status: '--', cls: '', caption: 'Forecast probability unavailable.' };
    }
    if (pop < 15) {
      return { status: 'Water Needed', cls: 'warn', caption: 'Little rain expected — plan to water.' };
    }
    if (pop < 50) {
      return { status: 'Possible', cls: 'info', caption: 'Some chance of rain — check before watering.' };
    }
    return { status: 'Rain Likely', cls: 'good', caption: "Good chance of rain — you can probably skip watering." };
  }

  // ---------- next-season countdown (meteorological + astronomical) ----------
  const SEASON_NAMES = ['Spring', 'Summer', 'Fall', 'Winter'];
  const SEASON_CLASS = ['season-spring', 'season-summer', 'season-fall', 'season-winter'];

  function meteorologicalSeasonStarts(year) {
    return [
      new Date(Date.UTC(year, 2, 1)),
      new Date(Date.UTC(year, 5, 1)),
      new Date(Date.UTC(year, 8, 1)),
      new Date(Date.UTC(year, 11, 1))
    ];
  }

  // low-precision approximation of equinox/solstice instants (Meeus,
  // "Astronomical Algorithms" ch. 27 -- the mean-equinox JDE0 term only,
  // without the ~24-term periodic correction). good to within roughly a
  // day for years near ours, which is plenty for a "days until" tile.
  function seasonJDE0(year, index) {
    const Y = (year - 2000) / 1000;
    const c = [
      [2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057], // Mar equinox
      [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.00030],  // Jun solstice
      [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],  // Sep equinox
      [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032]  // Dec solstice
    ][index];
    return c[0] + c[1] * Y + c[2] * Y ** 2 + c[3] * Y ** 3 + c[4] * Y ** 4;
  }

  function julianDayToDate(jd) {
    const Z = Math.floor(jd + 0.5);
    const F = (jd + 0.5) - Z;
    let A = Z;
    if (Z >= 2299161) {
      const alpha = Math.floor((Z - 1867216.25) / 36524.25);
      A = Z + 1 + alpha - Math.floor(alpha / 4);
    }
    const B = A + 1524;
    const C = Math.floor((B - 122.1) / 365.25);
    const D = Math.floor(365.25 * C);
    const E = Math.floor((B - D) / 30.6001);
    const day = B - D - Math.floor(30.6001 * E) + F;
    const month = E < 14 ? E - 1 : E - 13;
    const year = month > 2 ? C - 4716 : C - 4715;
    const dayInt = Math.floor(day);
    const hours = (day - dayInt) * 24;
    return new Date(Date.UTC(year, month - 1, dayInt, Math.floor(hours), Math.round((hours % 1) * 60)));
  }

  function astronomicalSeasonStarts(year) {
    return [0, 1, 2, 3].map(i => julianDayToDate(seasonJDE0(year, i)));
  }

  function computeSeasonCountdown() {
    const now = new Date();
    const year = now.getUTCFullYear();

    const met = [...meteorologicalSeasonStarts(year), ...meteorologicalSeasonStarts(year + 1)];
    const astro = [...astronomicalSeasonStarts(year), ...astronomicalSeasonStarts(year + 1)];

    const nextMet = met.find(d => d > now);
    const nextAstro = astro.find(d => d > now);
    if (!nextMet || !nextAstro) return null;

    const metIndex = met.indexOf(nextMet) % 4;
    const astroIndex = astro.indexOf(nextAstro) % 4;
    const msPerDay = 24 * 60 * 60 * 1000;

    const metResult = {
      label: 'meteorological', name: SEASON_NAMES[metIndex], cls: SEASON_CLASS[metIndex],
      days: Math.ceil((nextMet - now) / msPerDay), date: nextMet
    };
    const astroResult = {
      label: 'astronomical', name: SEASON_NAMES[astroIndex], cls: SEASON_CLASS[astroIndex],
      days: Math.ceil((nextAstro - now) / msPerDay), date: nextAstro
    };

    const primary = metResult.days <= astroResult.days ? metResult : astroResult;
    const secondary = primary === metResult ? astroResult : metResult;
    return { primary, secondary };
  }

  function renderSeasonCountdown() {
    const result = computeSeasonCountdown();
    if (!result) return;
    const { primary, secondary } = result;
    setStatCard({
      valueId: 'season-days',
      statusId: 'season-name',
      captionId: 'season-caption',
      value: primary.days,
      status: `${primary.name} (${primary.label})`,
      cls: primary.cls,
      caption: `${secondary.label === 'astronomical' ? 'Astronomical' : 'Meteorological'} ${secondary.name.toLowerCase()}: ${formatDate(secondary.date)} · ${secondary.days}d`
    });
  }

  function applyFrostCard({ value, status, cls, caption }) {
    setStatCard({ valueId: 'frost-value', statusId: 'frost-status-word', captionId: 'frost-caption', value, status, cls, caption });
  }

  // latest data from each source, kept around so the sky/weather-fx
  // system (below) can reclassify conditions whenever either one updates,
  // without the two fetches racing each other.
  let latestStationData = null;
  let latestCurrentPeriod = null;

  async function loadStation() {
    const response = await fetch(`${WEATHER_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Station data: HTTP ${response.status}`);
    const data = await response.json();
    latestStationData = data;
    refreshGardenWeather();

    setText('garden-temp', fmt(data.temp));
    setText('garden-dew', fmt(data.dewpt));
    setText('garden-rh', fmt(data.humidity, 0));
    setText('garden-rain', fmt(data.precipTotal, 2));
    setText('garden-rain-week', `${fmt(data.precipTotalWeek, 2)} in`);
    setText('garden-rain-month', `${fmt(data.precipTotalMonth, 2)} in`);
    setText('garden-wind', `${fmt(data.windSpeed)} mph`);
    setText('garden-sun', data.uv == null ? '--' : `UV ${fmt(data.uv, 1)}`);

    setText('garden-updated', `Station update: ${formatDateTime(data.obsTimeLocal)} · source: ${data.source || 'local'}`);

    const vpd = calculateVPD(data.temp, data.humidity);
    const vpdInfo = classifyVpd(vpd);
    setStatCard({
      valueId: 'vpd-value',
      statusId: 'vpd-status',
      captionId: 'vpd-caption',
      value: vpd === null ? '--' : vpd.toFixed(2),
      status: vpdInfo.status,
      cls: vpdInfo.cls,
      caption: vpdInfo.caption
    });

    return data;
  }

  async function loadHistory() {
    const response = await fetch(`${HISTORY_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`History: HTTP ${response.status}`);
    const history = normalizeHistory(await response.json());

    const gdd50 = calculateGDD(history, 50);
    const gdd40 = calculateGDD(history, 40);
    setText('gdd50', Math.round(gdd50).toLocaleString());
    setText(
      'gdd-caption',
      `Base 40°F: ${Math.round(gdd40).toLocaleString()}${history.length ? ` · since ${formatDate(history[0].date)}` : ''}`
    );

    return history;
  }

  async function loadNws() {
    const pointsResponse = await fetch(`https://api.weather.gov/points/${LAT},${LON}`, {
      headers: { Accept: 'application/geo+json' }
    });
    if (!pointsResponse.ok) throw new Error(`NWS points: HTTP ${pointsResponse.status}`);
    const points = await pointsResponse.json();

    const hourlyResponse = await fetch(points.properties.forecastHourly, {
      headers: { Accept: 'application/geo+json' }
    });
    if (!hourlyResponse.ok) throw new Error(`NWS hourly: HTTP ${hourlyResponse.status}`);
    const hourly = await hourlyResponse.json();

    const periods = hourly.properties?.periods || [];
    const nextSevenDays = periods.filter(period => {
      const time = new Date(period.startTime);
      return time <= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    });

    const mins = new Map();

    for (const period of nextSevenDays) {
      const dateKey = localDateKey(new Date(period.startTime));
      const temp = Number(period.temperature);
      if (!Number.isFinite(temp)) continue;

      if (!mins.has(dateKey)) mins.set(dateKey, { temp, date: new Date(period.startTime) });
      mins.get(dateKey).temp = Math.min(mins.get(dateKey).temp, temp);
    }

    latestCurrentPeriod = periods[0] || null;
    refreshGardenWeather();

    const days = [...mins.values()].sort((a, b) => a.date - b.date);
    const frost = days.find(day => day.temp <= 36);
    const freeze = days.find(day => day.temp <= 32);
    const hardFreeze = days.find(day => day.temp <= 28);

    if (hardFreeze) {
      applyFrostCard({ value: formatDate(hardFreeze.date), status: 'Hard Freeze', cls: 'danger', caption: `${Math.round(hardFreeze.temp)}°F expected` });
    } else if (freeze) {
      applyFrostCard({ value: formatDate(freeze.date), status: 'Freeze', cls: 'danger', caption: `${Math.round(freeze.temp)}°F expected` });
    } else if (frost) {
      applyFrostCard({ value: formatDate(frost.date), status: 'Frost Risk', cls: 'warn', caption: `${Math.round(frost.temp)}°F expected` });
    } else {
      applyFrostCard({ value: 'Clear', status: 'No Risk', cls: 'good', caption: 'No ≤36°F signal in the next 7 days.' });
    }

    const rainChance = getUpcomingRainChance(periods);
    const rainInfo = classifyRainChance(rainChance ? rainChance.pop : null);
    setStatCard({
      valueId: 'rain-chance',
      statusId: 'rain-status',
      captionId: 'rain-caption',
      value: rainChance ? rainChance.pop : '--',
      status: rainInfo.status,
      cls: rainInfo.cls,
      caption: rainChance ? `${rainInfo.caption} (peak ${rainChance.name})` : rainInfo.caption
    });

    try {
      const alertsResponse = await fetch(
        `https://api.weather.gov/alerts/active?point=${LAT},${LON}`,
        { headers: { Accept: 'application/geo+json' } }
      );

      if (alertsResponse.ok) {
        const alerts = await alertsResponse.json();
        const frostAlerts = (alerts.features || []).filter(feature => {
          const event = String(feature.properties?.event || '').toLowerCase();
          return event.includes('frost advisory') ||
            event.includes('freeze warning') ||
            event.includes('freeze watch');
        });

        if (frostAlerts.length) {
          const event = frostAlerts[0].properties.event;
          applyFrostCard({ value: 'Active', status: event, cls: 'danger', caption: `An official NWS ${event} currently applies to the station area.` });
        }
      }
    } catch (e) {
      // Forecast data is still useful if the alert endpoint has a transient issue.
    }
  }

  // ---------- sky: day/night + weather-responsive atmosphere ----------
  // mirrors the main dashboard's SunCalc-driven sky tracker and
  // #weather-fx system (see site.js), scoped down and restyled for this
  // page's parchment/pixel palette. data-garden-time / data-garden-weather
  // live on <html> rather than <body> so the inline script in <head> can
  // set them before gardening.js even loads (no purple flash on paint).

  function getSkyPhase(now) {
    const pos = SunCalc.getPosition(now, LAT, LON);
    const times = SunCalc.getTimes(now, LAT, LON);
    const altDeg = pos.altitude * 180 / Math.PI;
    const isMorning = now < times.solarNoon;
    if (altDeg >= 6) return 'day';
    if (altDeg <= -12) return 'night';
    return isMorning ? 'dawn' : 'dusk';
  }

  // Solid (non-alpha) versions of each phase's sky-top color, used for
  // the browser chrome's theme-color -- keep these in sync with
  // --garden-overscroll-top per data-garden-time in gardening.css, and
  // with the matching inline pre-paint script in gardening.html's <head>.
  const GARDEN_THEME_COLORS = {
    day: '#5e96c4',
    dawn: '#3f2d5c',
    dusk: '#3f2d5c',
    night: '#0f0c22',
  };

  function updateGardenThemeColor(phase) {
    const meta = document.getElementById('garden-theme-color');
    if (meta) meta.setAttribute('content', GARDEN_THEME_COLORS[phase] || GARDEN_THEME_COLORS.dusk);
  }

  function positionSkyBody(el, altitudeRad, azimuthRad) {
    if (!el) return;
    const altDeg = altitudeRad * 180 / Math.PI;
    const azDeg = azimuthRad * 180 / Math.PI;
    const leftPercent = ((azDeg + 180) / 360) * 100;
    const clampedAlt = Math.max(-15, Math.min(90, altDeg));
    const topPercent = 92 - ((clampedAlt + 15) / 105) * 80;
    const opacity = altDeg <= -8 ? 0 : Math.min(1, (altDeg + 8) / 10);
    el.style.left = `${leftPercent}%`;
    el.style.top = `${topPercent}%`;
    el.style.opacity = opacity;
  }

  function updateGardenSky() {
    if (typeof SunCalc === 'undefined') return;
    const now = new Date();
    const phase = getSkyPhase(now);
    document.documentElement.dataset.gardenTime = phase;
    updateGardenThemeColor(phase);

    const sunPos = SunCalc.getPosition(now, LAT, LON);
    const moonPos = SunCalc.getMoonPosition(now, LAT, LON);
    positionSkyBody($('garden-sun-body'), sunPos.altitude, sunPos.azimuth);
    positionSkyBody($('garden-moon-body'), moonPos.altitude, moonPos.azimuth);
  }

  function initGardenWeatherFx() {
    const rain = $('garden-fx-rain');
    for (let i = 0; i < 22; i++) {
      const drop = document.createElement('div');
      drop.className = 'garden-raindrop';
      drop.style.left = `${Math.random() * 100}%`;
      drop.style.animationDuration = `${0.6 + Math.random() * 0.6}s`;
      drop.style.animationDelay = `${Math.random() * 2}s`;
      rain.appendChild(drop);
    }

    const snow = $('garden-fx-snow');
    for (let i = 0; i < 26; i++) {
      const flake = document.createElement('div');
      flake.className = 'garden-snowflake';
      const size = 3 + Math.random() * 3;
      flake.style.width = `${size}px`;
      flake.style.height = `${size}px`;
      flake.style.left = `${Math.random() * 100}%`;
      flake.style.opacity = 0.5 + Math.random() * 0.5;
      flake.style.animationDuration = `${7 + Math.random() * 7}s`;
      flake.style.animationDelay = `${Math.random() * -10}s`;
      snow.appendChild(flake);
    }

    const clouds = $('garden-fx-clouds');
    for (let i = 0; i < 3; i++) {
      const puff = document.createElement('div');
      puff.className = 'garden-cloud-puff';
      puff.style.top = `${5 + Math.random() * 30}%`;
      puff.style.transform = `scale(${0.8 + Math.random() * 0.7})`;
      puff.style.opacity = 0.4 + Math.random() * 0.3;
      puff.style.animationDuration = `${60 + Math.random() * 40}s`;
      puff.style.animationDelay = `${Math.random() * -60}s`;
      clouds.appendChild(puff);
    }

    const stars = $('garden-fx-stars');
    for (let i = 0; i < 40; i++) {
      const star = document.createElement('div');
      star.className = 'garden-fx-star';
      const size = 1 + Math.random() * 1.6;
      star.style.width = `${size}px`;
      star.style.height = `${size}px`;
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 70}%`;
      star.style.animationDuration = `${3 + Math.random() * 5}s`;
      star.style.animationDelay = `${Math.random() * -8}s`;
      star.style.setProperty('--star-min-opacity', (0.15 + Math.random() * 0.2).toFixed(2));
      star.style.setProperty('--star-max-opacity', (0.6 + Math.random() * 0.4).toFixed(2));
      stars.appendChild(star);
    }
  }

  // classifies current conditions into the handful of buckets the garden
  // sky reacts to. prefers the NWS short-range text (already fetched for
  // the frost/freeze watch) and falls back to the station's own rain
  // gauge, so the effect still shows up even if the NWS call is slow.
  function classifyGardenWeather(currentPeriod, stationData) {
    const text = String(currentPeriod?.shortForecast || '').toLowerCase();
    const precipNow = Number(stationData?.precipRate) > 0;

    if (/thunderstorm|t-storm/.test(text)) return 'thunderstorm';
    if (/snow|flurr|sleet|ice/.test(text)) return 'snow';
    if (/rain|shower|drizzle/.test(text) || precipNow) return 'rain';
    if (/overcast/.test(text) || (/cloudy/.test(text) && !/partly|mostly clear|mostly sunny/.test(text))) return 'cloudy';
    return 'clear';
  }

  function refreshGardenWeather() {
    const condition = classifyGardenWeather(latestCurrentPeriod, latestStationData);
    document.documentElement.dataset.gardenWeather = condition;
  }

  function initGardenDetails() {
    const meadow = document.querySelector('.garden-meadow');
    const secret = document.querySelector('.garden-secret');
    const clover = document.querySelector('.pixel-clover');

    if (secret && clover) {
      secret.addEventListener('click', () => {
        secret.classList.remove('garden-secret-found');
        void secret.offsetWidth;
        secret.classList.add('garden-secret-found');
        clover.classList.toggle('garden-four-leaf');
      });
    }

    if (meadow) {
      meadow.addEventListener('click', event => {
        const bee = event.target.closest?.('.garden-bee');
        if (bee) {
          bee.classList.remove('garden-bee-ping');
          void bee.offsetWidth;
          bee.classList.add('garden-bee-ping');
        }
      });
    }
  }

  function updateCurrentSeasonDisplay() {
    // getUTCMonth() returns 0 for Jan, 11 for Dec
    const month = new Date().getUTCMonth(); 
    
    let seasonKey, displaySeason, iconFile;
    
    if (month >= 2 && month <= 4) {
      seasonKey = 'spring';
      displaySeason = 'Spring';
      iconFile = 'icon-sprout.png'; 
    } else if (month >= 5 && month <= 7) {
      seasonKey = 'summer';
      displaySeason = 'Summer';
      iconFile = 'icon-sun.png'; // Your pixelated sun icon
    } else if (month >= 8 && month <= 10) {
      seasonKey = 'autumn'; // Matches the dataset expected in your CSS
      displaySeason = 'Autumn';
      iconFile = 'icon-leaf.png';
    } else {
      seasonKey = 'winter';
      displaySeason = 'Winter';
      iconFile = 'icon-snowflake.png';
    }

    // 1. update the body tag to drive CSS background terrain
    document.body.dataset.gardenSeason = seasonKey;
    
    // update the .garden-world container
    const world = document.querySelector('.garden-world');
    if (world) world.dataset.gardenSeason = seasonKey;
    
    // 2. build the visual season tag (badge) using innerHTML
    const subtitle = $('garden-header-subtitle');
    if (subtitle) {
      subtitle.innerHTML = `
        <span class="garden-season-tag">
          <img src="assets/garden/${seasonKey}/${iconFile}" class="garden-tag-icon" alt=""> 
          ${displaySeason}
        </span>
      `;
    }
    
  }

  
  
  async function init() {
    updateCurrentSeasonDisplay();
    updateGardenSky();
    initGardenWeatherFx();
    initGardenDetails();
    renderSeasonCountdown();

    const results = await Promise.allSettled([
      loadStation(),
      loadHistory(),
      loadNws()
    ]);

    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) {
      console.warn('Gardening page data issue:', failures.map(f => f.reason?.message || f.reason));
      if (results[0]?.status === 'rejected') {
        setText('garden-updated', 'Live station data temporarily unavailable.');
      }
      if (results[2]?.status === 'rejected') {
        applyFrostCard({ value: '--', status: 'Unavailable', cls: '', caption: 'NWS frost/freeze forecast temporarily unavailable.' });
      }
    }
  }

  init();
  setInterval(updateGardenSky, 60 * 1000);
  setInterval(() => loadStation().catch(() => {}), 60 * 1000);
  setInterval(() => loadNws().catch(() => {}), 15 * 60 * 1000);
  setInterval(renderSeasonCountdown, 60 * 60 * 1000);
})();
