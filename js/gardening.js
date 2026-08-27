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

  async function loadStation() {
    const response = await fetch(`${WEATHER_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Station data: HTTP ${response.status}`);
    const data = await response.json();

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

  function updateGardenClock() {
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: STATION_TIMEZONE,
      hour: 'numeric',
      hour12: false
    }).format(new Date()));

    document.body.dataset.gardenTime =
      hour >= 6 && hour < 20 ? 'day' : 'night';
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
    updateGardenClock();
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
  setInterval(updateGardenClock, 60 * 1000);
  setInterval(() => loadStation().catch(() => {}), 60 * 1000);
  setInterval(() => loadNws().catch(() => {}), 15 * 60 * 1000);
})();
