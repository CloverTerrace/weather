/* Clover Terrace Gardening page */
(() => {
  const DATA_REPO_BASE = 'https://raw.githubusercontent.com/CloverTerrace/weather-data/main/data';
  const WEATHER_URL = `${DATA_REPO_BASE}/weather.json`;
  const HISTORY_URL = `${DATA_REPO_BASE}/history.json`;

  // Same map-center coordinates already used by the main dashboard.
  const LAT = 40.616;
  const LON = -80.274;

  const STATION_TIMEZONE = 'America/New_York';

  const $ = id => document.getElementById(id);

  const fmt = (value, decimals = 1, suffix = '') =>
    Number.isFinite(Number(value)) ? `${Number(value).toFixed(decimals)}${suffix}` : '--';

  // WeeWX timestamps are station-local wall-clock times. We represent those
  // wall-clock components as UTC internally so a visitor's browser timezone
  // cannot move an observation across midnight.
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

  function setStatus(kind, message) {
    const el = $('frost-status');
    if (!el) return;
    el.className = `garden-status ${kind || ''}`;
    el.innerHTML = `<span class="garden-status-dot"></span><span>${message}</span>`;
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

  function findFreezeDates(history) {
    const byDay = new Map();

    for (const entry of history) {
      const key = localDateKey(entry.date);
      const temp = Number(entry.temp);
      if (!Number.isFinite(temp)) continue;

      if (!byDay.has(key)) byDay.set(key, { min: Infinity, date: entry.date });
      const day = byDay.get(key);
      day.min = Math.min(day.min, temp);
    }

    const now = new Date();
    const currentYear = now.getFullYear();

    const days = [...byDay.values()].filter(day => {
      return day.date.getUTCFullYear() === currentYear && day.min <= 32;
    }).sort((a, b) => a.date - b.date);

    // In spring, the last <=32°F day before the growing season.
    const spring = days.filter(day => day.date.getUTCMonth() + 1 <= 6);

    // In fall, the first <=32°F day from July onward.
    const fall = days.filter(day => day.date.getUTCMonth() + 1 >= 7);

    return {
      lastSpring: spring.length ? spring[spring.length - 1] : null,
      firstFall: fall.length ? fall[0] : null
    };
  }

  // Latest data from each source, kept around so the sky/weather-fx
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

    const today = Number(data.precipTotal) || 0;
    const week = Number(data.precipTotalWeek) || 0;
    const month = Number(data.precipTotalMonth) || 0;
    const scale = Math.max(month, week, today, 0.01);

    const bars = [
      ['rainbar-today', 'rainbar-today-value', today],
      ['rainbar-week', 'rainbar-week-value', week],
      ['rainbar-month', 'rainbar-month-value', month]
    ];

    for (const [barId, valueId, amount] of bars) {
      $(barId).style.width = `${Math.min(100, amount / scale * 100)}%`;
      setText(valueId, `${amount.toFixed(2)}"`);
    }

    return data;
  }

  async function loadHistory() {
    const response = await fetch(`${HISTORY_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`History: HTTP ${response.status}`);
    const history = normalizeHistory(await response.json());

    const freezes = findFreezeDates(history);
    setText('last-freeze-local', freezes.lastSpring ? formatDate(freezes.lastSpring.date) : 'building record');
    setText('first-freeze-local', freezes.firstFall ? formatDate(freezes.firstFall.date) : 'not observed yet');
    setText(
      'local-record-span',
      history.length
        ? `${formatDate(history[0].date)} → ${formatDate(history[history.length - 1].date)}`
        : '--'
    );

    setText('gdd50', Math.round(calculateGDD(history, 50)).toLocaleString());
    setText('gdd40', Math.round(calculateGDD(history, 40)).toLocaleString());

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

    setText('frost-next', frost ? `${formatDate(frost.date)} · ${Math.round(frost.temp)}°` : 'none');
    setText('freeze-next', freeze ? `${formatDate(freeze.date)} · ${Math.round(freeze.temp)}°` : 'none');
    setText('hard-freeze-next', hardFreeze ? `${formatDate(hardFreeze.date)} · ${Math.round(hardFreeze.temp)}°` : 'none');

    if (hardFreeze) {
      setStatus('danger', `Hard-freeze signal in the NWS forecast: ${formatDate(hardFreeze.date)}.`);
    } else if (freeze) {
      setStatus('danger', `Freeze signal in the NWS forecast: ${formatDate(freeze.date)}.`);
    } else if (frost) {
      setStatus('warn', `Frost-risk temperature in the NWS forecast: ${formatDate(frost.date)}.`);
    } else {
      setStatus('good', 'No ≤36°F temperature signal in the next 7 days.');
    }

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
          setStatus('danger', `Active NWS ${event} for the station area.`);
          setText('frost-note', 'An official NWS frost/freeze product currently applies to the station area. Check the advisory/warning for timing and expected minimum temperatures.');
        }
      }
    } catch (e) {
      // Forecast data is still useful if the alert endpoint has a transient issue.
    }
  }

  // ---------- sky: day/night + weather-responsive atmosphere ----------
  // Mirrors the main dashboard's SunCalc-driven sky tracker and
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
    document.documentElement.dataset.gardenTime = getSkyPhase(now);

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

  // Classifies current conditions into the handful of buckets the garden
  // sky reacts to. Prefers the NWS short-range text (already fetched for
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

  async function init() {
    updateGardenSky();
    initGardenWeatherFx();
    initGardenDetails();

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
        setStatus('', 'NWS frost/freeze forecast temporarily unavailable.');
      }
    }
  }

  init();
  setInterval(updateGardenSky, 60 * 1000);
  setInterval(() => loadStation().catch(() => {}), 60 * 1000);
  setInterval(() => loadNws().catch(() => {}), 15 * 60 * 1000);
})();
