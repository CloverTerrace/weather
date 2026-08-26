
  
  const DATA_REPO_BASE = 'https://raw.githubusercontent.com/CloverTerrace/weather-data/main/data';
  const DATA_URL = `${DATA_REPO_BASE}/weather.json`;
  const REFRESH_INTERVAL_MS = 15 * 1000;
  const HISTORY_URL = `${DATA_REPO_BASE}/history.json`;
  // path to the WU-sourced backup file

  const WU_BACKUP_URL = 'data/weather_wu.json';
  const PRIMARY_STALE_MS = 15 * 60 * 1000;
  const STATION_CALLSIGN = 'GW7673';
  const STATION_CITY = 'Aliquippa';

  // USGS gauge — Ohio River at Dashields Lock & Dam, upper pool (Sewickley, PA).
  const USGS_SITE_ID = '03086000';
  const USGS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
  let currentUsgs = null;
  let usgsHistory = []; 

  // NWS flood stage thresholds for the Dashields Lock & Dam gauge (AHPS
  // station DSHP1), Ohio River Forecast Center — Ohio River, PA - PBZ.
  const DASHIELDS_STAGES = [
    { label: 'Action Stage',         ft: 19.4, color: '#c9a800' },
    { label: 'Flood Stage',          ft: 25.0, color: '#ff7e00' },
    { label: 'Moderate Flood Stage', ft: 29.0, color: '#ff4136' },
    { label: 'Major Flood Stage',    ft: 32.0, color: '#8f3f97' },
  ];

  function getDashieldsStageNote(gageHeight) {
    if (gageHeight === undefined || gageHeight === null || isNaN(gageHeight)) return null;
    for (let i = DASHIELDS_STAGES.length - 1; i >= 0; i--) {
      if (gageHeight >= DASHIELDS_STAGES[i].ft) {
        return { text: `At/above ${DASHIELDS_STAGES[i].label}`, color: DASHIELDS_STAGES[i].color };
      }
    }
    const toAction = DASHIELDS_STAGES[0].ft - gageHeight;
    return { text: `${toAction.toFixed(1)} ft below Action Stage`, color: 'var(--muted-color)' };
  }

  let cachedTodaysExtremes = {};
  let cachedRiverMax = null;
  let lastWeatherData = null;
  let lastSuccessfulLoadTime = null;

  // universal formatting function to enforce specific decimal places
  const formatVal = (v, dec = 1) => v !== undefined && v !== null && !isNaN(v) ? Number(v).toFixed(dec) : '--';

  function parseStationTime(str) {
    if (!str) return new Date(NaN);
    return new Date(str.includes('T') ? str : str.replace(' ', 'T'));
  }

  // the station timezone
  const STATION_TIMEZONE = 'America/New_York';

  // returns the time "YYYY-MM-DD HH:MM:SS" string in
  // the station's timezone -- the same shape weewx/WU already write to
  // obsTimeLocal. two values built this way (this function and a
  // station reading) through parseStationTime() cancels out the visitor's
  // own timezone entirely, the result is always the true elapsed
  // time at the station
  function stationNowNaive() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: STATION_TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type).value;
    const hour = get('hour') === '24' ? '00' : get('hour'); // Intl quirk: midnight can read "24"
    return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'updated just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes === 1) return 'updated 1 minute ago';
    if (minutes < 60) return `updated ${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours === 1) return 'updated 1 hour ago';
    return `updated ${hours} hours ago`;
  }

  // helper for small times in standard format
  function formatShortTime(isoString) {
    if (!isoString) return '--:--';
    const d = new Date(isoString);
    if (isNaN(d)) return '--:--';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }

  function updateStatusLine() {
    if (errorBanner.style.display === 'block') return;
    if (!lastWeatherData || !lastSuccessfulLoadTime) return;
    const obsTime = lastWeatherData.obsTimeLocal || 'unknown';
    status.textContent = `Station observed ${obsTime} · ${formatRelativeTime(lastSuccessfulLoadTime)}`;
  }
  
  async function loadVisitorCount() {
    const el = document.getElementById('visitor-count-text');
    try {
      const res = await fetch(
        'https://countapi.mileshilliard.com/api/v1/hit/cloverterrace-weather-visits',
        { cache: 'no-store' }
      );
      const rawText = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} — body: ${rawText.slice(0, 200)}`);
      let data = JSON.parse(rawText);
      const count = data.value ?? data.count ?? data.hits;
      el.textContent = `${count} visitors`;
    } catch (err) {
      el.textContent = '—';
    }
  }

  function getRiverTrend(values) {
    if (!values || values.length < 2) return null;
    const latest = values[values.length - 1];
    const targetTime = Date.now() - 3 * 60 * 60 * 1000;
    let closest = null;
    let closestDiff = Infinity;
    
    values.forEach(entry => {
        const diff = Math.abs(new Date(entry.dateTime).getTime() - targetTime);
        if (diff < closestDiff) {
            closestDiff = diff;
            closest = entry;
        }
    });
    
    if (!closest) return null;
    const delta = parseFloat(latest.value) - parseFloat(closest.value);
    
    if (delta >= 0.05) return { arrow: '↑', label: 'Rising', className: 'trend-rising' };
    if (delta <= -0.05) return { arrow: '↓', label: 'Falling', className: 'trend-falling' };
    return { arrow: '→', label: 'Steady', className: 'trend-steady' };
  }

    async function fetchUsgsGauge() {
    try {
      const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${USGS_SITE_ID}&parameterCd=00065,00060&format=json&period=P10D`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const timeSeriesList = data?.value?.timeSeries || [];
      
      // 1. find the specific series for Gage Height (00065) and Discharge/CFS (00060)
      const heightSeries = timeSeriesList.find(s => s.variable?.variableCode?.[0]?.value === '00065');
      const cfsSeries = timeSeriesList.find(s => s.variable?.variableCode?.[0]?.value === '00060');

      // 2. extract the values arrays from both series
      const heightValues = heightSeries?.values?.[0]?.value || [];
      const cfsValues = cfsSeries?.values?.[0]?.value || [];

      // 3. get the most recent data point for both
      const latestHeight = heightValues[heightValues.length - 1];
      const latestCfs = cfsValues[cfsValues.length - 1];

      if (!latestHeight) throw new Error('No gage height data returned');

      // keep the height history for the chart and trend calculations
      usgsHistory = heightValues; 

      currentUsgs = {
        siteName: heightSeries?.sourceInfo?.siteName || 'Ohio River — Dashields L&D',
        gageHeight: parseFloat(latestHeight.value),
        // add the new CFS property safely:
        dischargeCfs: latestCfs ? parseFloat(latestCfs.value) : null,
        time: latestHeight.dateTime,
        trend: getRiverTrend(heightValues) 
      };
    } catch (err) {
      console.warn('Could not load USGS gauge data:', err.message);
    }
    if (lastWeatherData) renderCards(lastWeatherData);
    renderAllCharts();
  }


  const grid = document.getElementById('grid');
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');
  const errorBanner = document.getElementById('error-banner');
  const refreshBtn = document.getElementById('refresh-btn');

  let historyChart = null;
  let windChart = null;
  let windRoseChart = null;
  let pressureChart = null;
  let solarChart = null;
  let riverChart = null;
  let isRefreshing = false;
  let fullHistory = [];
  let capeHistory = [];

  // cards the user has tapped open. renderCards() rebuilds the whole
  // grid every refresh cycle, this tracks expand state across that
  // rebuild instead of losing it every 60s.
  const expandedCards = new Set();

  // calculates vapor pressure deficit based on T and RH
  function calculateVPD(tempF, humidity) {
    if (tempF === undefined || tempF === null || humidity === undefined || humidity === null) return '--';
    const tempC = (tempF - 32) * 5 / 9;
    const es = 0.6108 * Math.exp(17.27 * tempC / (tempC + 237.3));
    const ea = es * (humidity / 100);
    return (es - ea).toFixed(3);
  }

  // comfort read on dew point
  function getDewpointComfort(dewpt) {
    if (dewpt === undefined || dewpt === null || isNaN(dewpt)) return '';
    if (dewpt < 50) return 'dry';
    if (dewpt < 55) return 'comfortable';
    if (dewpt < 60) return 'pleasant';
    if (dewpt < 65) return 'a bit sticky';
    if (dewpt < 70) return 'humid';
    if (dewpt < 75) return 'muggy';
    if (dewpt < 80) return 'oppressive';
    return 'miserable';
  }

  // beaufort scale label for a wind speed in mph
  function getBeaufortLabel(mph) {
    if (mph === undefined || mph === null || isNaN(mph)) return '--';
    if (mph < 1) return 'Calm';
    if (mph < 4) return 'Light Air';
    if (mph < 8) return 'Light Breeze';
    if (mph < 13) return 'Gentle Breeze';
    if (mph < 19) return 'Moderate Breeze';
    if (mph < 25) return 'Fresh Breeze';
    if (mph < 32) return 'Strong Breeze';
    if (mph < 39) return 'Near Gale';
    if (mph < 47) return 'Gale';
    if (mph < 55) return 'Strong Gale';
    if (mph < 64) return 'Storm';
    if (mph < 73) return 'Violent Storm';
    return 'Hurricane Force';
  }

  // NWS UV Index risk category + color, straight from the EPA/NWS scale.
  function getUvRiskCategory(uv) {
    if (uv === undefined || uv === null || isNaN(uv)) return { label: '--', color: 'var(--muted-color)' };
    if (uv < 3) return { label: 'Low', color: '#8fd6a8' };
    if (uv < 6) return { label: 'Moderate', color: '#ffe27a' };
    if (uv < 8) return { label: 'High', color: '#ffb347' };
    if (uv < 11) return { label: 'Very High', color: '#ff7e67' };
    return { label: 'Extreme', color: '#c792ff' };
  }

  // plain-language read on CAPE (Convective Available Potential Energy)
  function getCapeCategory(cape) {
    if (cape === undefined || cape === null || isNaN(cape)) return { label: '--', color: 'var(--muted-color)' };
    if (cape < 100) return { label: 'Stable', color: 'var(--muted-color)' };
    if (cape < 1000) return { label: 'Weak', color: '#8fd6a8' };
    if (cape < 2500) return { label: 'Moderate', color: '#ffe27a' };
    if (cape < 4000) return { label: 'Strong', color: '#ffb347' };
    return { label: 'Extreme', color: '#ff5b5b' };
  }

  // plain-language storm-development read combining the 3h pressure trend
  function getStormPotentialNote(trend, rateHtml, cape) {
    const rateSuffix = rateHtml ? ` · ${rateHtml}` : '';
    const hasCape = cape !== undefined && cape !== null && !isNaN(cape);
    const unstable = hasCape && cape >= 1000;      // Moderate CAPE or higher
    const veryUnstable = hasCape && cape >= 2500;  // Strong CAPE or higher
    const capeLabel = hasCape ? getCapeCategory(cape).label.toLowerCase() : '';

    if (!trend || trend.deltaPerHour === null || trend.deltaPerHour === undefined || isNaN(trend.deltaPerHour)) {
      if (veryUnstable) return `No trend yet, but <strong>${capeLabel}ly unstable</strong> air (${formatVal(cape, 0)} J/kg) — worth watching.`;
      return 'Not enough pressure history yet for a trend.';
    }

    const rate = Math.abs(trend.deltaPerHour);

    if (trend.label === 'Falling') {
      if (rate >= 0.06) {
        if (unstable) return `<strong>Rapid fall</strong>${rateSuffix} + <strong>${capeLabel}</strong> instability — good storm setup.`;
        return `<strong>Rapid fall</strong>${rateSuffix} — storm system likely approaching.`;
      }
      if (unstable) return `<strong>Falling</strong>${rateSuffix} + <strong>${capeLabel}</strong> instability — watch for storms.`;
      return `<strong>Falling</strong>${rateSuffix} — turning more unsettled.`;
    }
    if (trend.label === 'Rising') {
      const risePrefix = rate >= 0.06 ? 'Rapid rise' : 'Rising';
      if (veryUnstable) return `<strong>${risePrefix}</strong>${rateSuffix} — but <strong>${capeLabel}</strong> CAPE remains, isolated storms possible.`;
      if (rate >= 0.06) return `<strong>Rapid rise</strong>${rateSuffix} — system clearing, skies improving.`;
      return `<strong>Rising</strong>${rateSuffix} — fair weather building.`;
    }
    if (veryUnstable) return `<strong>Steady</strong>${rateSuffix}, but <strong>${capeLabel}</strong> instability — storms possible with a trigger.`;
    return `<strong>Steady</strong>${rateSuffix} — no major change expected.`;
  }

  // gets official descriptive text for AQI
  function getAqiDescription(aqi) {
    if (aqi === undefined || aqi === null) return '';
    if (aqi <= 50) return 'Air quality is considered satisfactory, and air pollution poses little or no risk. Safe to enjoy outdoor activities.';
    if (aqi <= 100) return 'If you are unusually sensitive to particle pollution consider reducing your activity level or shorten the amount of time you are active outdoors.';
    if (aqi <= 150) return 'Members of sensitive groups may experience health effects. The general public is not likely to be affected.';
    if (aqi <= 200) return 'Everyone may begin to experience health effects; members of sensitive groups may experience more serious health effects.';
    if (aqi <= 300) return 'Health alert: everyone may experience more serious health effects.';
    return 'Health warnings of emergency conditions. The entire population is more likely to be affected.';
  }

  // searches today's history entries and captures both max and min with timestamps.
  function getTodayExtremes(history, fieldKey) {
    if (!history || history.length === 0) return null;
    const todayStr = new Date().toDateString();
    let max = null;
    let min = null;
    history.forEach(entry => {
      if (new Date(entry.time).toDateString() !== todayStr) return;
      const val = entry[fieldKey];
      if (val === undefined || val === null) return;
      if (!max || val > max.val) max = { val, time: entry.time };
      if (!min || val < min.val) min = { val, time: entry.time };
    });
    if (!max || !min) return null;
    return { max, min };
  }

  // safely grab cached or calculated extremes, falling back to current values if needed
  function getExtremesSafe(history, cached, data, fieldKey) {
    const todayStr = new Date().toDateString();

    // if the running store is left over from a previous day, drop it --
    // otherwise a stale peak/low would carry over into today forever via
    // the merge below.
    if (cached._day !== todayStr) {
        Object.keys(cached).forEach(k => delete cached[k]);
        cached._day = todayStr;
    }

    let ext = getTodayExtremes(history, fieldKey);

    // merge in whatever we've already locked in this session, so a live
    // spike folded into the extremes on an earlier tick isn't lost just
    // because the instantaneous reading has since dropped back down.
    if (cached[fieldKey]) {
        const c = cached[fieldKey];
        if (!ext) {
            ext = c;
        } else {
            if (c.max && c.max.val !== undefined && c.max.val !== null &&
                (ext.max.val === undefined || ext.max.val === null || c.max.val > ext.max.val)) {
                ext = { ...ext, max: c.max };
            }
            if (c.min && c.min.val !== undefined && c.min.val !== null &&
                (ext.min.val === undefined || ext.min.val === null || c.min.val < ext.min.val)) {
                ext = { ...ext, min: c.min };
            }
        }
    }

    if (!ext) {
        const val = data[fieldKey];
        if (val !== undefined && val !== null) {
            ext = { max: {val, time: new Date().toISOString()}, min: {val, time: new Date().toISOString()} };
        }
    }
    if (!ext) return { max: {val: '--', time: null}, min: {val: '--', time: null} };

    const liveVal = data[fieldKey];
    if (liveVal !== undefined && liveVal !== null && !isNaN(liveVal)) {
        const liveTime = data.obsTimeLocal || new Date().toISOString();
        if (ext.max.val === undefined || ext.max.val === null || liveVal > ext.max.val) {
            ext = { ...ext, max: { val: liveVal, time: liveTime } };
        }
        if (ext.min.val === undefined || ext.min.val === null || liveVal < ext.min.val) {
            ext = { ...ext, min: { val: liveVal, time: liveTime } };
        }
    }

    // persist the merged result so the next tick builds on it instead of
    // restarting from just the (possibly stale) history snapshot.
    cached[fieldKey] = ext;

    return ext;
  }

  // fields eligible for WU backfill -- the numeric station readings. Not
  // lightning (WU has no such field) and not identity/time fields (those
  // are handled separately based on which source is treated as primary).
  const WU_FILLABLE_FIELDS = [
    'temp', 'heatIndex', 'windChill', 'dewpt', 'humidity', 'winddir',
    'windSpeed', 'windGust', 'pressure', 'precipRate', 'precipTotal',
    'solarRadiation', 'uv',
  ];

  // merges the primary (weewx) reading with the WU backup reading.
  // - if weewx's own data is fresh, keep it as the base and only pull in
  //   individual fields from WU where weewx left a gap (null/undefined).
  // - if weewx's data is stale (the service itself looks down, not just a
  //   sensor), use the WU record wholesale instead of trying to patch a
  //   dead file field-by-field.
  // returns { data, filledFields, usedWuWholesale } so the caller can
  // optionally surface which fields (if any) came from the backup.
  function mergeWithWuBackup(primary, wu) {
    if (!wu) return { data: primary, filledFields: [], usedWuWholesale: false };
    if (!primary) return { data: wu, filledFields: [], usedWuWholesale: true };

    // both sides go through parseStationTime() so the visitor's own
    // timezone cancels out of the subtraction -- see stationNowNaive().
    const primaryAgeMs = primary.obsTimeLocal
      ? parseStationTime(stationNowNaive()).getTime() - parseStationTime(primary.obsTimeLocal).getTime()
      : Infinity;
    const primaryIsStale = !(primaryAgeMs >= 0) || primaryAgeMs > PRIMARY_STALE_MS;

    if (primaryIsStale) {
      return { data: wu, filledFields: [], usedWuWholesale: true };
    }

    const merged = { ...primary };
    const filledFields = [];
    WU_FILLABLE_FIELDS.forEach((key) => {
      if ((merged[key] === undefined || merged[key] === null) &&
          wu[key] !== undefined && wu[key] !== null) {
        merged[key] = wu[key];
        filledFields.push(key);
      }
    });
    if (filledFields.length) {
      merged.source = `${primary.source || 'local'}+wu_fill`;
    }
    return { data: merged, filledFields, usedWuWholesale: false };
  }

  function getTodayMaxRiver(values) {
    if (!values || values.length === 0) return null;
    const todayStr = new Date().toDateString();
    let best = null;
    values.forEach(entry => {
      if (new Date(entry.dateTime).toDateString() !== todayStr) return;
      const val = parseFloat(entry.value);
      if (isNaN(val)) return;
      if (!best || val > best.val) best = { val, dateTime: entry.dateTime };
    });
    return best;
  }

  const CARDINAL_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  function degreesToCardinal16(deg) {
    return CARDINAL_16[Math.round(deg / 22.5) % 16];
  }

  const WIND_COMPASS_TICKS = (() => {
    let ticks = '';
    const cx = 60, cy = 60, rOuter = 54, rInner = 47;
    for (let i = 0; i < 36; i++) {
      const angle = (i * 10) * Math.PI / 180;
      const x1 = cx + rInner * Math.sin(angle);
      const y1 = cy - rInner * Math.cos(angle);
      const x2 = cx + rOuter * Math.sin(angle);
      const y2 = cy - rOuter * Math.cos(angle);
      ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--muted-color)" stroke-width="1.5" opacity="0.5" />`;
    }
    return ticks;
  })();

  function buildWindCompassHtml(label, degrees, beaufort) {
    const labelHtml = label ? `<div class="label">${label}</div>` : '';
    const beaufortHtml = beaufort ? `<div class="wind-compass-beaufort">${beaufort}</div>` : '';
    return `
      ${labelHtml}
      <div class="wind-compass">
        <svg class="wind-compass-ring" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--accent-color)" stroke-width="2.5" />
          ${WIND_COMPASS_TICKS}
          <g class="wind-compass-arrow" style="transform: rotate(${degrees}deg); transform-origin: 60px 60px;">
            <polygon points="60,8 68,24 60,19 52,24" fill="var(--accent-color)" />
          </g>
        </svg>
        <div class="wind-compass-center">
          <div class="wind-compass-degrees">${formatVal(degrees, 0)}<span class="unit">°</span></div>
          <div class="wind-compass-cardinal">${degreesToCardinal16(degrees)}</div>
        </div>
      </div>
      ${beaufortHtml}
    `;
  }

  const PRESSURE_TREND_WINDOW_HOURS = 3;
  const PRESSURE_TREND_THRESHOLD = 0.03;

  function getPressureTrend(history, fieldKey = 'pressure') {
    if (!history || history.length < 2) return null;
    const latest = history[history.length - 1];
    if (!latest || latest[fieldKey] === undefined || latest[fieldKey] === null) return null;

    const targetTime = Date.now() - PRESSURE_TREND_WINDOW_HOURS * 60 * 60 * 1000;
    let closest = null;
    let closestDiff = Infinity;
    history.forEach(entry => {
      if (entry[fieldKey] === undefined || entry[fieldKey] === null) return;
      const diff = Math.abs(new Date(entry.time).getTime() - targetTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = entry;
      }
    });
    if (!closest) return null;

    const delta = latest[fieldKey] - closest[fieldKey];
    const deltaPerHour = delta / PRESSURE_TREND_WINDOW_HOURS;
    if (delta >= PRESSURE_TREND_THRESHOLD) return { arrow: '<img src="icons/pressure-high.svg" class="meteocon" alt="Rising">', label: 'Rising', className: 'trend-rising', delta, deltaPerHour };
    if (delta <= -PRESSURE_TREND_THRESHOLD) return { arrow: '<img src="icons/pressure-low.svg" class="meteocon" alt="Falling">', label: 'Falling', className: 'trend-falling', delta, deltaPerHour };
    return { arrow: '→', label: 'Steady', className: 'trend-steady', delta, deltaPerHour };
  }

  // CAPE's trend arrow
  const CAPE_TREND_WINDOW_HOURS = 3;
  const CAPE_TREND_THRESHOLD = 250; // J/kg change over the window

  function getCapeTrend(history) {
    if (!history || history.length < 2) return null;
    const latest = history[history.length - 1];
    if (!latest || latest.cape === undefined || latest.cape === null) return null;

    const targetTime = Date.now() - CAPE_TREND_WINDOW_HOURS * 60 * 60 * 1000;
    let closest = null;
    let closestDiff = Infinity;
    history.forEach(entry => {
      if (entry.cape === undefined || entry.cape === null) return;
      const diff = Math.abs(new Date(entry.time).getTime() - targetTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = entry;
      }
    });
    if (!closest) return null;

    const delta = latest.cape - closest.cape;
    const deltaPerHour = delta / CAPE_TREND_WINDOW_HOURS;
    if (delta >= CAPE_TREND_THRESHOLD) return { arrow: '↑', label: 'Rising', className: 'trend-rising', delta, deltaPerHour };
    if (delta <= -CAPE_TREND_THRESHOLD) return { arrow: '↓', label: 'Falling', className: 'trend-falling', delta, deltaPerHour };
    return { arrow: '→', label: 'Steady', className: 'trend-steady', delta, deltaPerHour };
  }

  // shared pressure+CAPE sparkline strip on the fronttile
  const PC_SPARK_WINDOW_HOURS = 6;

  function sparklinePoints(history, valueKey, hours) {
    if (!history || !history.length) return [];
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return history
      .filter(e => e[valueKey] !== undefined && e[valueKey] !== null && new Date(e.time).getTime() >= cutoff)
      .map(e => ({ t: new Date(e.time).getTime(), v: e[valueKey] }))
      .sort((a, b) => a.t - b.t);
  }

  function sparklinePath(points, width, height, padding) {
    if (points.length < 2) return null;
    const times = points.map(p => p.t);
    const vals = points.map(p => p.v);
    const minT = Math.min(...times), maxT = Math.max(...times);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    const spanT = (maxT - minT) || 1;
    const spanV = (maxV - minV) || 1;
    const usableH = height - padding * 2;
    return points.map(p => {
      const x = ((p.t - minT) / spanT) * width;
      const y = padding + usableH - ((p.v - minV) / spanV) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  function buildPressureCapeSparkline(pressureHistory, capeHistory) {
    const W = 300, H = 32, PAD = 3;
    const pPath = sparklinePath(sparklinePoints(pressureHistory, 'pressure', PC_SPARK_WINDOW_HOURS), W, H, PAD);
    const cPath = sparklinePath(sparklinePoints(capeHistory, 'cape', PC_SPARK_WINDOW_HOURS), W, H, PAD);
    if (!pPath && !cPath) return '';
    return `<svg class="pc-sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      (cPath ? `<polyline points="${cPath}" class="pc-spark-line pc-spark-cape"></polyline>` : '') +
      (pPath ? `<polyline points="${pPath}" class="pc-spark-line pc-spark-pressure"></polyline>` : '') +
      `</svg>`;
  }
  
  let currentRangeHours = 24; 

  function filterHistoryByRange(history, hours) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return history.filter(entry => new Date(entry.time).getTime() >= cutoff);
  }

  // sensor-card interaction
  function makeCardExpandable(cardEl, key, title, renderPanel) {
    cardEl.classList.add('card-expandable');
    cardEl.setAttribute('tabindex', '0');
    cardEl.setAttribute('role', 'button');
    cardEl.setAttribute('aria-expanded', 'false');
    cardEl.dataset.expandHint = title;

    const existingContent = Array.from(cardEl.childNodes);
    const inner = document.createElement('div');
    inner.className = 'card-flip-inner';

    const front = document.createElement('div');
    front.className = 'card-flip-front';
    existingContent.forEach(node => front.appendChild(node));

    const hint = document.createElement('div');
    hint.className = 'card-expand-hint';
    hint.textContent = `tap for ${title} ↗`;
    front.appendChild(hint);

    const back = document.createElement('div');
    back.className = 'card-flip-back';

    const panel = document.createElement('div');
    panel.className = 'card-expand-panel';
    back.append(panel);
    inner.append(front, back);
    cardEl.appendChild(inner);

    const isOpen = () => expandedCards.has(key);

    const setOpen = (open) => {
      if (open) {
        // only one ordinary card should be open at a time.
        document.querySelectorAll('.card.card-flipped').forEach(other => {
          if (other === cardEl) return;
          other.classList.remove('card-flipped');
          other.setAttribute('aria-expanded', 'false');
          const otherHint = other.querySelector('.card-expand-hint');
          if (otherHint) otherHint.textContent = `tap for ${other.dataset.expandHint || 'more data'} ↗`;
        });
        expandedCards.clear();
        expandedCards.add(key);
        renderPanel(panel);
      } else {
        expandedCards.delete(key);
      }
      cardEl.classList.toggle('card-flipped', open);
      cardEl.setAttribute('aria-expanded', String(open));
      hint.textContent = open ? 'tap card to return ↩' : `tap for ${title} ↗`;
    };

    cardEl.addEventListener('click', (e) => {
      if (e.target.closest('a, button, details, summary')) return;
      setOpen(!isOpen());
    });

    cardEl.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(!isOpen());
      }
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });

    if (isOpen()) setOpen(true);
  }

  function closeOpenSensorCards() {
    expandedCards.clear();
    document.querySelectorAll('.card.card-flipped').forEach(card => {
      card.classList.remove('card-flipped');
      card.setAttribute('aria-expanded', 'false');
      const hint = card.querySelector('.card-expand-hint');
      if (hint) hint.textContent = `tap for ${card.dataset.expandHint || 'more data'} ↗`;
    });
    document.querySelectorAll('.lightning-card.lightning-map-open').forEach(card => {
      card.classList.remove('lightning-map-open');
      card.setAttribute('aria-expanded', 'false');
    });
  }

  let sensorDismissTimer = null;
  document.addEventListener('click', (event) => {
    if (event.target.closest('#grid .card.card-expandable, #grid .lightning-card')) return;
    closeOpenSensorCards();
  });
  window.addEventListener('scroll', () => {
    if (sensorDismissTimer) cancelAnimationFrame(sensorDismissTimer);
    sensorDismissTimer = requestAnimationFrame(closeOpenSensorCards);
  }, { passive: true });

  function renderChart(history) {
    const labels = history.map(entry => entry.time);
    const tempData = history.map(entry => entry.temp);
    const humidityData = history.map(entry => entry.humidity);
    const ctx = document.getElementById('historyChart').getContext('2d');
    if (historyChart) {
      historyChart.data.labels = labels;
      historyChart.data.datasets[0].data = tempData;
      historyChart.data.datasets[1].data = humidityData;
      historyChart.update();
      return;
    }
    historyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Temperature (°F)', data: tempData, borderColor: '#4fb0ff', backgroundColor: 'rgba(79, 176, 255, 0.1)', yAxisID: 'yTemp', tension: 0.25, pointRadius: 0, borderWidth: 2 },
          { label: 'Humidity (%)', data: humidityData, borderColor: '#ffb84f', backgroundColor: 'rgba(255, 184, 79, 0.1)', yAxisID: 'yHumidity', tension: 0.25, pointRadius: 0, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#93a1b5', maxTicksLimit: 10, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.05)' } },
          yTemp: { position: 'left', ticks: { color: '#4fb0ff' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '°F', color: '#4fb0ff' } },
          yHumidity: { position: 'right', ticks: { color: '#ffb84f' }, grid: { display: false }, title: { display: true, text: '%', color: '#ffb84f' }, min: 0, max: 100 },
        },
        plugins: { legend: { labels: { color: '#4c4f4f' } } },
      },
    });

    setTimeout(() => historyChart.resize(), 50);
  }

  function renderWindChart(history) {
    const labels = history.map(entry => entry.time);
    const speedData = history.map(entry => entry.windSpeed);
    const gustData = history.map(entry => entry.windGust);
    const ctx = document.getElementById('windChart').getContext('2d');
    if (windChart) {
      windChart.data.labels = labels;
      windChart.data.datasets[0].data = speedData;
      windChart.data.datasets[1].data = gustData;
      windChart.update();
      return;
    }
    windChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Sustained (mph)', data: speedData, borderColor: '#7fe0c0', backgroundColor: 'rgba(127, 224, 192, 0.1)', tension: 0.25, pointRadius: 0, borderWidth: 2 },
          { label: 'Gust (mph)', data: gustData, borderColor: '#ff8f6b', backgroundColor: 'rgba(255, 143, 107, 0.08)', tension: 0.25, pointRadius: 0, borderWidth: 2, borderDash: [4, 3] },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#93a1b5', maxTicksLimit: 10, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { beginAtZero: true, ticks: { color: '#93a1b5' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'mph', color: '#93a1b5' } },
        },
        plugins: { legend: { labels: { color: '#4c4f4f' } } },
      },
    });
  }

  const COMPASS_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  function computeWindRose(history) {
    const sums = new Array(8).fill(0);
    const counts = new Array(8).fill(0);
    history.forEach(entry => {
      if (entry.winddir === undefined || entry.winddir === null) return;
      const idx = Math.round((entry.winddir % 360) / 45) % 8;
      sums[idx] += entry.windSpeed || 0;
      counts[idx] += 1;
    });
    return sums.map((sum, i) => (counts[i] ? Math.round((sum / counts[i]) * 10) / 10 : 0));
  }

  function renderWindRose(history) {
    const data = computeWindRose(history);
    const ctx = document.getElementById('windRoseChart').getContext('2d');
    if (windRoseChart) {
      windRoseChart.data.datasets[0].data = data;
      windRoseChart.update();
      return;
    }
    windRoseChart = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: COMPASS_LABELS,
        datasets: [{ label: 'Avg wind speed (mph)', data: data, borderColor: '#7fe0c0', backgroundColor: 'rgba(127, 224, 192, 0.2)', pointBackgroundColor: '#7fe0c0' }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          r: { beginAtZero: true, ticks: { color: '#93a1b5', backdropColor: 'transparent' }, grid: { color: 'rgba(255,255,255,0.08)' }, angleLines: { color: 'rgba(255,255,255,0.08)' }, pointLabels: { color: '#4c4f4f' } },
        },
        plugins: { legend: { labels: { color: '#4c4f4f' } } },
      },
    });
  }

  function renderPressureChart(history) {
    const labels = history.map(entry => entry.time);
    const pressureData = history.map(entry => entry.pressure);
    const ctx = document.getElementById('pressureChart').getContext('2d');
    if (pressureChart) {
      pressureChart.data.labels = labels;
      pressureChart.data.datasets[0].data = pressureData;
      pressureChart.update();
      return;
    }
    pressureChart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: [{ label: 'Pressure (inHg)', data: pressureData, borderColor: '#c79bff', backgroundColor: 'rgba(199, 155, 255, 0.1)', tension: 0.25, pointRadius: 0, borderWidth: 2, fill: true }] },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#93a1b5', maxTicksLimit: 10, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#93a1b5' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'inHg', color: '#93a1b5' } },
        },
        plugins: { legend: { labels: { color: '#4c4f4f' } } },
      },
    });
  }

  function renderSolarChart(history) {
    const labels = history.map(entry => entry.time);
    const solarData = history.map(entry => entry.solarRadiation);
    const ctx = document.getElementById('solarChart').getContext('2d');
    if (solarChart) {
      solarChart.data.labels = labels;
      solarChart.data.datasets[0].data = solarData;
      solarChart.update();
      return;
    }
    solarChart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: [{ label: 'Solar Radiation (W/m²)', data: solarData, borderColor: '#ffcc4d', backgroundColor: 'rgba(255, 204, 77, 0.15)', tension: 0.25, pointRadius: 0, borderWidth: 2, fill: true }] },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#93a1b5', maxTicksLimit: 10, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { beginAtZero: true, ticks: { color: '#93a1b5' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'W/m²', color: '#93a1b5' } },
        },
        plugins: { legend: { labels: { color: '#4c4f4f' } } },
      },
    });
  }

  function renderRiverChart(values) {
    const labels = values.map(entry => entry.dateTime);
    const heightData = values.map(entry => parseFloat(entry.value));
    const ctx = document.getElementById('riverChart').getContext('2d');
    if (riverChart) {
      riverChart.data.labels = labels;
      riverChart.data.datasets[0].data = heightData;
      riverChart.update();
      return;
    }
    riverChart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: [{ label: 'Gage Height (ft)', data: heightData, borderColor: '#4fc3f7', backgroundColor: 'rgba(79, 195, 247, 0.15)', tension: 0.25, pointRadius: 0, borderWidth: 2, fill: true }] },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#93a1b5', maxTicksLimit: 10, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#93a1b5' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'ft', color: '#93a1b5' } },
        },
        plugins: { legend: { labels: { color: '#4c4f4f' } } },
      },
    });
  }

  function updateChartTitles(rangeLabel) {
    const baseNames = { 'historyChart-title': 'Temperature & Humidity', 'windChart-title': 'Wind Speed & Gusts', 'windRoseChart-title': 'Wind Direction', 'pressureChart-title': 'Barometric Pressure', 'solarChart-title': 'Solar Illumination', 'riverChart-title': 'River Gauge' };
    Object.keys(baseNames).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = `${baseNames[id]} — Last ${rangeLabel}`;
    });
  }

  function renderAllCharts() {
    const filtered = filterHistoryByRange(fullHistory, currentRangeHours);
    if (filtered.length > 0) {
      renderChart(filtered);
      renderWindChart(filtered);
      renderWindRose(filtered);
      renderPressureChart(filtered);
      renderSolarChart(filtered);
    }
    const filteredRiver = (usgsHistory || []).filter(entry => new Date(entry.dateTime).getTime() >= (Date.now() - currentRangeHours * 60 * 60 * 1000));
    if (filteredRiver.length > 0) renderRiverChart(filteredRiver);
  }

  function initChartTabs() {
    const tabs = document.querySelectorAll('.chart-tab');
    const cards = document.querySelectorAll('.charts-dropdown .chart-card');
    const chartsByTarget = {
      'chart-card-temp': () => historyChart,
      'chart-card-wind': () => windChart,
      'chart-card-windrose': () => windRoseChart,
      'chart-card-pressure': () => pressureChart,
      'chart-card-river': () => riverChart,
      'chart-card-solar': () => solarChart,
    };
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.classList.contains('active')) return;
        tabs.forEach(t => t.classList.toggle('active', t === tab));
        cards.forEach(c => c.classList.toggle('active', c.id === tab.dataset.target));
        const chart = chartsByTarget[tab.dataset.target]?.();
        if (chart) setTimeout(() => chart.resize(), 50);
      });
    });
  }

  function initRangeButtons() {
    const buttons = document.querySelectorAll('.range-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        currentRangeHours = parseInt(btn.dataset.hours, 10);
        buttons.forEach(b => b.classList.toggle('active', b === btn));
        updateChartTitles(btn.textContent);
        renderAllCharts();
      });
    });
  }

  async function loadHistory(forceRefresh = false) {
    try {
      const url = `${HISTORY_URL}?t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const history = await res.json();
      if (Array.isArray(history) && history.length > 0) {
        fullHistory = history;
        renderAllCharts();
        // fullHistory just went from empty to populated -- re-render the grid
        // so anything derived from it (pressure/CAPE trend, extremes) reflects
        // real data on this same load instead of waiting for the next
        // periodic loadData() tick. Same pattern loadCapeHistory() uses below.
        if (lastWeatherData) renderCards(lastWeatherData);
      }
    } catch (err) {
      console.warn('Could not load history data:', err.message);
    }
  }

  // rolling CAPE history (written by fetch_cape.py each workflow run)
  async function loadCapeHistory() {
    try {
      const url = `data/cape_history.json?t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const history = await res.json();
      if (Array.isArray(history) && history.length > 0) {
        capeHistory = history;
        if (lastWeatherData) renderCards(lastWeatherData);
      }
    } catch (err) {
      console.warn('Could not load CAPE history:', err.message);
    }
  }

  // maps an NWS shortForecast string (+ day/night) to a Meteocons filename.
  // more specific/severe conditions are checked first
  function forecastMeteocon(shortForecast, isDaytime) {
    const s = (shortForecast || '').toLowerCase();
    const dn = isDaytime === false ? 'night' : 'day';
    if (s.includes('tornado')) return 'tornado.svg';
    if (s.includes('thunderstorm') || s.includes('t-storm')) return `thunderstorms-${dn}.svg`;
    if (s.includes('snow') || s.includes('flurries') || s.includes('blizzard')) return 'snow.svg';
    if (s.includes('sleet') || s.includes('freezing rain') || s.includes('ice')) return 'sleet.svg';
    if (s.includes('rain') || s.includes('shower') || s.includes('drizzle')) return 'rain.svg';
    if (s.includes('fog') || s.includes('haze') || s.includes('mist')) return `fog-${dn}.svg`;
    if (s.includes('wind')) return 'wind.svg';
    if (s.includes('overcast') || s.includes('mostly cloudy')) return `overcast-${dn}.svg`;
    if (s.includes('partly') || s.includes('cloudy')) return `partly-cloudy-${dn}.svg`;
    if (s.includes('clear') || s.includes('sunny')) return dn === 'day' ? 'clear-day.svg' : 'clear-night.svg';
    return `partly-cloudy-${dn}.svg`; // sensible default for anything unmatched
  }
  
  // e.g. "2026-08-22T14:00:00-04:00" -> "2PM". Used for the hourly strip labels.
  function formatHourLabel(isoString) {
    const d = new Date(isoString);
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}${ampm}`;
  }

  async function loadForecast(forceRefresh = false) {
    const periodsContainer = document.getElementById('forecast-periods');
    const hourlyContainer = document.getElementById('forecast-hourly-strip');
    try {
      const url = `data/forecast.json?t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const forecastData = await res.json();
      // backwards-compatible with the old bare-array shape, in case a
      // stale data/forecast.json is still lying around on first deploy.
      const periods = Array.isArray(forecastData) ? forecastData : (forecastData.periods || []);
      const hourly = Array.isArray(forecastData) ? [] : (forecastData.hourly || []);
      currentForecastPeriods = periods;
      currentForecastHourly = hourly;
      updateSkyBadges();

      periodsContainer.innerHTML = '';
      periods.forEach(period => {
        const card = document.createElement('div');
        card.className = 'forecast-period';
        const iconFile = forecastMeteocon(period.shortForecast, period.isDaytime);
        const pop = period.probabilityOfPrecipitation;
        card.innerHTML = `
          <div class="period-name">${period.name}</div>
          <div class="period-temp-row">
            <span class="period-temp">${period.temperature}°${period.temperatureUnit}</span>
            <span class="card-icon"><img src="icons/${iconFile}" alt="${period.shortForecast}" onerror="this.parentElement.style.display='none'"></span>
          </div>
          ${pop != null ? `<div class="period-pop"><img class="pop-icon" src="icons/raindrop-measure.svg" alt="">${pop}% chance</div>` : ''}
          <div class="period-short">${period.shortForecast}</div>
          <div class="period-wind">${period.windSpeed} ${period.windDirection}</div>
        `;
        periodsContainer.appendChild(card);
      });

      if (hourlyContainer) {
        hourlyContainer.innerHTML = '';
        if (!hourly.length) {
          hourlyContainer.innerHTML = '<div class="forecast-hour">Hourly unavailable</div>';
        } else {
          hourly.slice(0, 24).forEach((hour, idx) => {
            const cell = document.createElement('div');
            cell.className = 'forecast-hour';
            const iconFile = forecastMeteocon(hour.shortForecast, hour.isDaytime);
            const pop = hour.probabilityOfPrecipitation;
            const showPop = pop != null && pop > 0;
            cell.innerHTML = `
              <div class="hour-label">${idx === 0 ? 'Now' : formatHourLabel(hour.startTime)}</div>
              <span class="card-icon"><img src="icons/${iconFile}" alt="${hour.shortForecast || ''}" onerror="this.parentElement.style.display='none'"></span>
              <div class="hour-temp">${hour.temperature}°</div>
              <div class="hour-pop${showPop ? ' has-pop' : ''}">${showPop ? pop + '%' : ''}</div>
            `;
            hourlyContainer.appendChild(cell);
          });
        }
      }
    } catch (err) {
      console.warn('Could not load forecast data:', err.message);
      if (periodsContainer) periodsContainer.innerHTML = '<div class="forecast-period">Forecast unavailable</div>';
      if (hourlyContainer) hourlyContainer.innerHTML = '<div class="forecast-hour">Forecast unavailable</div>';
    }
  }

  // ---------- push notifications for severe alerts ----------
  // not operational yet
  const PUSH_WORKER_URL = 'REPLACE_WITH_YOUR_DEPLOYED_WORKER_URL'; // e.g. https://clover-weather-push.<you>.workers.dev
  const VAPID_PUBLIC_KEY = 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  function initPushAlerts() {
    const btn = document.getElementById('push-alerts-btn');
    if (!btn) return;

    const notSupported = !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined';
    const notConfigured = PUSH_WORKER_URL.startsWith('REPLACE_') || VAPID_PUBLIC_KEY.startsWith('REPLACE_');
    if (notSupported || notConfigured) {
      btn.style.display = 'none';
      if (notConfigured) console.warn('Push alerts: set PUSH_WORKER_URL and VAPID_PUBLIC_KEY before enabling the button.');
      return;
    }

    async function refreshButtonState() {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        btn.textContent = existing ? 'Alerts On' : 'Enable Alerts';
        btn.setAttribute('aria-pressed', String(!!existing));
      } catch (e) {
        // service worker not ready yet -- leave the default label
      }
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();

        if (existing) {
          await fetch(`${PUSH_WORKER_URL}/unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          }).catch(() => {});
          await existing.unsubscribe();
          await refreshButtonState();
          return;
        }

        if (Notification.permission === 'denied') {
          alert('Notifications are blocked for this site in your browser settings. Enable them there, then try again.');
          return;
        }

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });

        await fetch(`${PUSH_WORKER_URL}/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });

        await refreshButtonState();
      } catch (err) {
        console.warn('Push subscribe/unsubscribe failed:', err);
      } finally {
        btn.disabled = false;
      }
    });

    refreshButtonState();
  }

  // tap-to-flip between the hourly strip (front) and the 4-day outlook
  // (back), same interaction pattern as makeCardExpandable() above, but
  // standalone since this card lives outside #grid.
  function initForecastCardFlip() {
    const card = document.getElementById('forecast-card');
    const hint = document.getElementById('forecast-flip-hint');
    if (!card) return;
    card.classList.add('forecast-expandable');
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-expanded', 'false');

    const setOpen = (open) => {
      card.classList.toggle('forecast-flipped', open);
      card.setAttribute('aria-expanded', String(open));
      if (hint) hint.textContent = open ? 'tap to return to hourly ↩' : 'tap for 48 hour forecast summary ↗';
    };

    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button, details, summary')) return;
      setOpen(!card.classList.contains('forecast-flipped'));
    });
    card.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(!card.classList.contains('forecast-flipped'));
      }
      if (e.key === 'Escape' && card.classList.contains('forecast-flipped')) setOpen(false);
    });
  }

  async function refreshOutlookImages() {
    const t = Date.now();
    const files = [
      ['outlook-img-day1', `data/outlook-day1.png?t=${t}`],
      ['outlook-img-day2', `data/outlook-day2.png?t=${t}`],
      ['outlook-img-day3', `data/outlook-day3.png?t=${t}`],
    ];
    files.forEach(([id, src]) => {
      const img = document.getElementById(id);
      if (img) img.src = src;
    });

    const day48 = document.getElementById('outlook-img-day48');
    if (day48) {
      day48.onerror = () => {
        day48.onerror = null;
        day48.src = `data/outlook-day4-8.png?t=${t}`;
      };
      day48.src = `data/outlook-day4-8.gif?t=${t}`;
    }

    // keep the compact preview drawer synchronized with the live images.
    document.querySelectorAll('#outlook-thumbnails img').forEach(img => {
      const src = img.getAttribute('src') || '';
      img.src = src.split('?')[0] + `?t=${t}`;
    });

    await loadThunderstormOutlooks(t);
  }

  function getCurrentUtcHour() {
    return new Date().getUTCHours();
  }

  function thunderstormPeriodIsCurrent(period) {
    const hour = getCurrentUtcHour();
    const start = Number(period.start_hour);
    const end = Number(period.end_hour);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
  }

  function scrollOutlookToSlide(scroller, slide, smooth = true) {
    if (!scroller || !slide) return;
    scroller.scrollTo({
      left: slide.offsetLeft,
      behavior: smooth ? 'smooth' : 'auto'
    });
  }

  function initOutlookViewer({ scrollerId, thumbSelector, slideSelector, currentIndex = 0, currentLabelId = null, labelPrefix = 'Viewing' }) {
    const scroller = document.getElementById(scrollerId);
    const thumbs = Array.from(document.querySelectorAll(thumbSelector));
    const slides = Array.from(document.querySelectorAll(slideSelector));
    if (!scroller || !slides.length) return;

    let activeIndex = Math.max(0, Math.min(currentIndex, slides.length - 1));
    let scrollTimer = null;

    const syncThumbs = () => {
      thumbs.forEach((thumb, i) => {
        const isActive = i === activeIndex;
        thumb.classList.toggle('active', isActive);
        thumb.setAttribute('aria-current', isActive ? 'true' : 'false');
        thumb.hidden = isActive;
      });
    };

    const setActive = (index, smooth = true) => {
      if (!slides.length) return;
      activeIndex = Math.max(0, Math.min(index, slides.length - 1));
      syncThumbs();
      const slideLabel = slides[activeIndex]?.getAttribute('aria-label') || '';
      if (currentLabelId) {
        const label = document.getElementById(currentLabelId);
        if (label) {
          label.textContent = activeIndex === 0 ? `Right now · ${slideLabel}` : `${labelPrefix} · ${slideLabel}`;
        }
      }
      // thunderstorm slides carry their own compact period label.
      slides.forEach((slide, i) => {
        const periodLabel = slide.querySelector('.thunderstorm-period-label');
        if (!periodLabel) return;
        const base = slide.getAttribute('aria-label') || '';
        const original = periodLabel.dataset.periodLabel || base;
        periodLabel.dataset.periodLabel = original;
        periodLabel.textContent = i === activeIndex
          ? (i === currentIndex ? `Right now · ${original}` : `${labelPrefix} · ${original}`)
          : original;
      });
      scrollOutlookToSlide(scroller, slides[activeIndex], smooth);
    };

    thumbs.forEach((thumb, index) => {
      thumb.addEventListener('click', () => setActive(index, true));
    });

    scroller.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const distances = slides.map(slide => Math.abs(slide.offsetLeft - scroller.scrollLeft));
        const nearest = distances.indexOf(Math.min(...distances));
        if (nearest >= 0 && nearest !== activeIndex) setActive(nearest, false);
      }, 80);
    }, { passive: true });

    setActive(activeIndex, false);
  }

  async function loadThunderstormOutlooks(cacheBust = Date.now()) {
    const grid = document.getElementById('thunderstorm-period-grid');
    const note = document.getElementById('thunderstorm-outlook-note');
    if (!grid) return;

    try {
      const response = await fetch(`data/outlook-thunderstorm.json?t=${cacheBust}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      const periods = Array.isArray(manifest.periods) ? manifest.periods : [];

      grid.innerHTML = '';
      if (!periods.length) {
        grid.innerHTML = '<div class="thunderstorm-empty">No current Thunderstorm Outlook periods are available.</div>';
        if (note) note.textContent = '';
        return;
      }

      // prefer the period valid right now. if the current clock falls between
      // SPC blocks, fall back to the first live period in the manifest.
      let currentIndex = periods.findIndex(thunderstormPeriodIsCurrent);
      if (currentIndex < 0) currentIndex = 0;

      const scroller = document.createElement('div');
      scroller.className = 'outlook-scroll thunderstorm-primary-scroll';
      scroller.id = 'thunderstorm-primary-scroll';
      scroller.setAttribute('aria-label', 'SPC Thunderstorm Outlook periods');

      const thumbs = document.createElement('div');
      thumbs.className = 'thunderstorm-thumb-grid';
      thumbs.id = 'thunderstorm-thumb-grid';
      thumbs.setAttribute('aria-label', 'Choose thunderstorm outlook period');

      periods.forEach((period, index) => {
        const labelText = period.label || `${period.start_hour}Z–${period.end_hour}Z`;
        const isCurrent = index === currentIndex;
        const cacheFile = `${period.file}?t=${cacheBust}`;

        const slide = document.createElement('div');
        slide.className = 'outlook-slide thunderstorm-primary-slide';
        slide.id = `thunderstorm-slide-${index}`;
        slide.setAttribute('role', 'group');
        slide.setAttribute('aria-label', labelText);

        const label = document.createElement('div');
        label.className = 'thunderstorm-period-label';
        label.textContent = labelText;
        label.dataset.periodLabel = labelText;

        const viewport = document.createElement('div');
        viewport.className = 'outlook-viewport';

        const img = document.createElement('img');
        img.src = cacheFile;
        img.alt = `SPC Thunderstorm Outlook ${labelText}`;
        img.decoding = 'async';
        img.loading = index === currentIndex ? 'eager' : 'lazy';
        img.addEventListener('error', () => {
          slide.remove();
          thumb.remove();
        });

        viewport.appendChild(img);
        slide.append(label, viewport);

        const thumb = document.createElement('button');
        thumb.className = `thunderstorm-thumb${isCurrent ? ' active current' : ''}`;
        thumb.type = 'button';
        thumb.setAttribute('aria-label', `Open Thunderstorm Outlook ${labelText}`);
        thumb.setAttribute('aria-current', isCurrent ? 'true' : 'false');
        thumb.dataset.index = String(index);

        const thumbImg = document.createElement('img');
        thumbImg.src = cacheFile;
        thumbImg.alt = '';
        thumbImg.loading = 'lazy';
        const thumbLabel = document.createElement('span');
        thumbLabel.className = 'thunderstorm-thumb-label';
        thumbLabel.textContent = labelText;
        thumb.append(thumbImg, thumbLabel);

        thumb.addEventListener('click', () => {
          const target = document.getElementById(`thunderstorm-slide-${index}`);
          scrollOutlookToSlide(scroller, target, true);
        });

        scroller.appendChild(slide);
        thumbs.appendChild(thumb);
      });

      grid.append(scroller, thumbs);

      initOutlookViewer({
        scrollerId: 'thunderstorm-primary-scroll',
        thumbSelector: '#thunderstorm-thumb-grid .thunderstorm-thumb',
        slideSelector: '#thunderstorm-primary-scroll .thunderstorm-primary-slide',
        currentIndex
      });

      if (note) {
        const updated = manifest.updated_at_utc
          ? new Date(manifest.updated_at_utc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
          : '';
        note.textContent = updated ? `Updated ${updated}` : '';
      }
    } catch (err) {
      console.warn('Could not load Thunderstorm Outlook manifest:', err);
      grid.innerHTML = '<div class="thunderstorm-empty">Thunderstorm Outlook data is temporarily unavailable.</div>';
      if (note) note.textContent = '';
    }
  }

  function initOutlookCategoryTabs() {
     const tabs = document.querySelectorAll('#outlook-category-tabs .outlook-category-tab');
     tabs.forEach(tab => {
       tab.addEventListener('click', () => {
         tabs.forEach(t => {
           t.classList.remove('active');
           t.setAttribute('aria-selected', 'false');
         });
         tab.classList.add('active');
         tab.setAttribute('aria-selected', 'true');
         document.querySelectorAll('.outlook-category-panel').forEach(p => p.classList.remove('active'));
         document.getElementById(tab.dataset.target).classList.add('active');
       });
     });
  }

  function initOutlookCarousel() {
     initOutlookViewer({
       scrollerId: 'outlook-scroll',
       thumbSelector: '#outlook-thumbnails .outlook-thumb',
       slideSelector: '#outlook-scroll .outlook-slide',
       currentIndex: 0,
       currentLabelId: 'outlook-current-label' 
     });
  }

  // ---------- maps card ----------
  const RADAR_LAT = 40.616;
  const RADAR_LON = -80.274;
  // KPBZ NEXRAD tower's own coordinates (Moon Twp/Pittsburgh) -- distinct
  // from RADAR_LAT/RADAR_LON above, which is the station's location used
  // to center the map view, not the radar site itself.
  const RADAR_SITE_LAT = 40.5317;
  const RADAR_SITE_LON = -80.2180;
  const RADAR_SITE_ID = 'PBZ'; // IEM/ridge site id -- drops the leading "K"
  const RADAR_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

  let RADAR_FRAME_MS = 700;
  let radarLayerOpacity = 0.75;

  let radarMap = null;
  let radarLayers = [];      // animated RainViewer reflectivity frames
  let radarFrames = [];
  let radarFrameIndex = 0;
  let radarTimer = null;
  let radarScrubbing = false;        // true while the user drags the scrubber -- pauses the auto-loop
  let radarProduct = 'reflectivity'; // 'reflectivity' | 'velocity'

  function activeRadarFrames() {
    return radarProduct === 'velocity' ? radarVelocityFrames : radarFrames;
  }
  function activeRadarLayers() {
    return radarProduct === 'velocity' ? radarVelocityLayers : radarLayers;
  }

  function updateScrubberBounds() {
    const scrubber = document.getElementById('radar-scrubber');
    if (scrubber) scrubber.max = Math.max(activeRadarFrames().length - 1, 0);
  }

  function showRadarFrame(index) {
    activeRadarLayers().forEach((layer, i) => layer.setOpacity(i === index ? radarLayerOpacity : 0));
    const frame = activeRadarFrames()[index];
    const label = document.getElementById('radar-frame-time');
    if (frame && label) {
      const time = new Date(frame.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (radarProduct === 'velocity') {
        label.textContent = `Base Velocity — Observed: ${time}`;
      } else {
        const isForecast = frame.time > Date.now();
        label.textContent = `${isForecast ? 'Forecast' : 'Observed'}: ${time}`;
      }
    }
    const scrubber = document.getElementById('radar-scrubber');
    if (scrubber && !radarScrubbing) scrubber.value = index;
  }

  function startRadarLoop() {
    clearInterval(radarTimer);
    const frameCount = activeRadarFrames().length;
    if (!frameCount) return;
    radarTimer = setInterval(() => {
      if (radarScrubbing) return;
      radarFrameIndex = (radarFrameIndex + 1) % activeRadarFrames().length;
      showRadarFrame(radarFrameIndex);
    }, RADAR_FRAME_MS);
  }

  async function loadRadarFrames() {
    try {
      const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const past = (data.radar && data.radar.past) || [];
      const nowcast = (data.radar && data.radar.nowcast) || [];
      const frames = [...past, ...nowcast];
      if (!frames.length) throw new Error('No radar frames returned');

      radarLayers.forEach(layer => radarMap.removeLayer(layer));
      radarFrames = frames.map(f => ({ time: f.time * 1000 }));
      radarLayers = frames.map(frame =>
        L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`, {
          tileSize: 256,
          opacity: 0,
          zIndex: 10,
          // rainViewer's free tile API tops out at zoom 7, this adds support for further (blurry) zooming
          maxNativeZoom: 7,
        }).addTo(radarMap)
      );

      radarFrameIndex = past.length > 0 ? past.length - 1 : 0;
      if (radarProduct === 'reflectivity') {
        updateScrubberBounds();
        showRadarFrame(radarFrameIndex);
        startRadarLoop();
      }
    } catch (err) {
      console.warn('Could not load RainViewer radar frames:', err.message);
      if (radarProduct === 'reflectivity') {
        const label = document.getElementById('radar-frame-time');
        if (label) label.textContent = 'Radar unavailable';
      }
    }
  }

  // animated single-site base velocity (N0U) loop from Iowa Environmental
  // Mesonet's RIDGE archive, for the KPBZ radar 
  const RADAR_VELOCITY_LOOKBACK_MIN = 90;
  let radarVelocityFrames = []; // [{ time (ms) }], oldest first
  let radarVelocityLayers = [];
  let radarVelocityLoaded = false;
  let radarVelocityTimer = null;

  function isoToRidgeTimestamp(iso) {
    // "2026-08-17T02:07Z" -> "202608170207"
    return iso.replace(/[-:TZ]/g, '');
  }

  async function loadRadarVelocityFrames() {
    if (!radarMap) return;
    try {
      const end = new Date();
      const start = new Date(end.getTime() - RADAR_VELOCITY_LOOKBACK_MIN * 60000);
      const fmt = (d) => `${d.toISOString().slice(0, 16)}Z`; // YYYY-mm-ddTHH:MMZ
      const url = `https://mesonet.agron.iastate.edu/json/radar.py?operation=list&radar=${RADAR_SITE_ID}&product=N0U&start=${fmt(start)}&end=${fmt(end)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const scans = data.scans || [];
      if (!scans.length) throw new Error('No velocity scans returned');

      radarVelocityLayers.forEach(layer => radarMap.removeLayer(layer));
      radarVelocityFrames = scans.map(s => ({ time: new Date(s.ts).getTime() }));
      radarVelocityLayers = scans.map(s =>
        L.tileLayer(
          `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::${RADAR_SITE_ID}-N0U-${isoToRidgeTimestamp(s.ts)}/{z}/{x}/{y}.png`,
          { tileSize: 256, opacity: 0, zIndex: 10, maxZoom: 10 } // see the maxNativeZoom note on the reflectivity layers above if this needs the same fix
        ).addTo(radarMap)
      );
      radarVelocityLoaded = true;

      if (!radarVelocityTimer) {
        radarVelocityTimer = setInterval(loadRadarVelocityFrames, RADAR_REFRESH_INTERVAL_MS);
      }

      if (radarProduct === 'velocity') {
        radarFrameIndex = radarVelocityFrames.length - 1;
        updateScrubberBounds();
        showRadarFrame(radarFrameIndex);
        startRadarLoop();
      }
    } catch (err) {
      console.warn('Could not load IEM velocity frames:', err.message);
      if (radarProduct === 'velocity') {
        const label = document.getElementById('radar-frame-time');
        if (label) label.textContent = 'Velocity unavailable';
      }
    }
  }

  function setRadarProduct(product) {
    if (!radarMap || radarProduct === product) return;
    radarProduct = product;

    document.querySelectorAll('.radar-product-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.product === product);
    });

    clearInterval(radarTimer);
    radarLayers.forEach(layer => layer.setOpacity(0));
    radarVelocityLayers.forEach(layer => layer.setOpacity(0));

    if (product === 'velocity' && !radarVelocityLoaded) {
      const label = document.getElementById('radar-frame-time');
      if (label) label.textContent = 'Loading velocity scans…';
      loadRadarVelocityFrames(); // async -- shows the first frame and starts the loop itself once loaded
      return;
    }

    radarFrameIndex = Math.min(radarFrameIndex, activeRadarFrames().length - 1);
    updateScrubberBounds();
    showRadarFrame(radarFrameIndex);
    startRadarLoop();
  }

  // ---------- radar overlay: active NWS warnings/watches polygons ----------
  const RADAR_WARNINGS_STATES = ['PA', 'OH', 'WV', 'MD', 'NY'];
  const RADAR_WARNINGS_REFRESH_MS = 5 * 60 * 1000;

  let radarWarningsLayer = null;
  let radarWarningsOn = false;
  let radarWarningsTimer = null;

  function hazardColorFor(eventText) {
    const badge = getNwsHazardVisual(eventText).badge;
    const colors = {
      'nws-badge-tor': '#ff5b5b',
      'nws-badge-severe': '#ffb347',
      'nws-badge-flood': '#5ba8ff',
      'nws-badge-winter': '#cfe8ff',
      'nws-badge-other': '#9aa5ad',
    };
    return colors[badge] || colors['nws-badge-other'];
  }

  async function loadRadarWarnings() {
    if (!radarMap) return;
    try {
      const query = RADAR_WARNINGS_STATES.map(s => `area=${s}`).join('&');
      const res = await fetch(`https://api.weather.gov/alerts/active?${query}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const features = (data.features || []).filter(f => f.geometry);

      if (radarWarningsLayer) radarMap.removeLayer(radarWarningsLayer);
      radarWarningsLayer = L.geoJSON(features, {
        style: (feature) => {
          const color = hazardColorFor(feature.properties.event);
          return { color, weight: 2, fillColor: color, fillOpacity: 0.15 };
        },
        onEachFeature: (feature, layer) => {
          const p = feature.properties || {};
          layer.bindPopup(
            `<div class="radar-warning-popup"><strong>${escapeNwsHtml(p.event || 'Alert')}</strong>${escapeNwsHtml(p.headline || '')}</div>`
          );
        },
      });
      if (radarWarningsOn) radarWarningsLayer.addTo(radarMap);
    } catch (err) {
      console.warn('Could not load radar warnings overlay:', err.message);
    }
  }

  function setRadarWarningsOn(on) {
    radarWarningsOn = on;
    const btn = document.getElementById('radar-toggle-warnings');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    clearInterval(radarWarningsTimer);
    if (on) {
      loadRadarWarnings();
      radarWarningsTimer = setInterval(loadRadarWarnings, RADAR_WARNINGS_REFRESH_MS);
    } else if (radarWarningsLayer && radarMap.hasLayer(radarWarningsLayer)) {
      radarMap.removeLayer(radarWarningsLayer);
    }
  }

  // ---------- radar overlay: recent lightning ----------
  let radarLightningOverlayLayer = null;
  let radarLightningOverlayOn = false;
  let radarLightningOverlayTimer = null;

  async function loadRadarLightningOverlay() {
    if (!radarMap) return;
    try {
      const res = await fetch(`${LIGHTNING_GLM_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const flashes = Array.isArray(data.flashes) ? data.flashes : [];

      if (radarLightningOverlayLayer) radarMap.removeLayer(radarLightningOverlayLayer);
      radarLightningOverlayLayer = L.layerGroup(flashes.map(f => L.circleMarker([f.lat, f.lon], {
        radius: 4,
        color: '#ffcc33',
        weight: 1,
        fillColor: '#ffcc33',
        fillOpacity: 0.7,
      }).bindTooltip(formatShortTime(f.time), { direction: 'top' })));
      if (radarLightningOverlayOn) radarLightningOverlayLayer.addTo(radarMap);
    } catch (err) {
      console.warn('Could not load radar lightning overlay:', err.message);
    }
  }

  function setRadarLightningOverlayOn(on) {
    radarLightningOverlayOn = on;
    const btn = document.getElementById('radar-toggle-lightning');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    clearInterval(radarLightningOverlayTimer);
    if (on) {
      loadRadarLightningOverlay();
      radarLightningOverlayTimer = setInterval(loadRadarLightningOverlay, LIGHTNING_GLM_REFRESH_INTERVAL_MS);
    } else if (radarLightningOverlayLayer && radarMap.hasLayer(radarLightningOverlayLayer)) {
      radarMap.removeLayer(radarLightningOverlayLayer);
    }
  }

  // ---------- radar controls wiring -------------------------
  // (product toggle, overlay toggles, settings panel, scrubber)
  function initRadarControls() {
    document.querySelectorAll('.radar-product-btn').forEach(btn => {
      btn.addEventListener('click', () => setRadarProduct(btn.dataset.product));
    });

    const warningsBtn = document.getElementById('radar-toggle-warnings');
    if (warningsBtn) {
      warningsBtn.addEventListener('click', () => setRadarWarningsOn(warningsBtn.getAttribute('aria-pressed') !== 'true'));
    }

    const lightningBtn = document.getElementById('radar-toggle-lightning');
    if (lightningBtn) {
      lightningBtn.addEventListener('click', () => setRadarLightningOverlayOn(lightningBtn.getAttribute('aria-pressed') !== 'true'));
    }

    const settingsBtn = document.getElementById('radar-toggle-settings');
    const settingsPanel = document.getElementById('radar-settings-panel');
    if (settingsBtn && settingsPanel) {
      settingsBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = settingsPanel.classList.toggle('open');
        settingsBtn.setAttribute('aria-pressed', String(open));
      });
      document.addEventListener('click', (event) => {
        if (settingsPanel.classList.contains('open') && !settingsPanel.contains(event.target) && event.target !== settingsBtn) {
          settingsPanel.classList.remove('open');
          settingsBtn.setAttribute('aria-pressed', 'false');
        }
      });
    }

    const speedSlider = document.getElementById('radar-speed-slider');
    if (speedSlider) {
      speedSlider.addEventListener('input', () => {
        RADAR_FRAME_MS = Number(speedSlider.value);
        startRadarLoop();
      });
    }

    const opacitySlider = document.getElementById('radar-opacity-slider');
    if (opacitySlider) {
      opacitySlider.addEventListener('input', () => {
        radarLayerOpacity = Number(opacitySlider.value) / 100;
        showRadarFrame(radarFrameIndex);
      });
    }

    const scrubber = document.getElementById('radar-scrubber');
    if (scrubber) {
      scrubber.addEventListener('input', () => {
        radarScrubbing = true;
        radarFrameIndex = Number(scrubber.value);
        showRadarFrame(radarFrameIndex);
      });
      scrubber.addEventListener('change', () => {
        radarScrubbing = false; // resumes the auto-loop from wherever the user left it
      });
    }
  }

  let radarBaseDark = null;
  let radarBaseLight = null;
  let radarIsNight = null; 

  function setRadarBaseLayer(isNight) {
    if (!radarMap || radarIsNight === isNight) return;
    radarIsNight = isNight;
    if (isNight) {
      if (radarMap.hasLayer(radarBaseLight)) radarMap.removeLayer(radarBaseLight);
      if (!radarMap.hasLayer(radarBaseDark)) radarBaseDark.addTo(radarMap);
    } else {
      if (radarMap.hasLayer(radarBaseDark)) radarMap.removeLayer(radarBaseDark);
      if (!radarMap.hasLayer(radarBaseLight)) radarBaseLight.addTo(radarMap);
    }
  }

  function initRadarMap() {
    if (radarMap) return; 
    radarMap = L.map('rainviewer-map', {
      zoomControl: true,
      attributionControl: false,
    }).setView([RADAR_LAT, RADAR_LON], 7);
    radarBaseDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, zIndex: 1 });
    radarBaseLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, zIndex: 1 });
    setRadarBaseLayer(false); 
    L.marker([RADAR_LAT, RADAR_LON]).addTo(radarMap);

    // KPBZ radar tower marker + a rough range ring for context
    const radarTowerIcon = L.divIcon({
      className: 'radar-site-marker-icon',
      html: '📡',
      iconSize: [20, 20],
    });
    L.marker([RADAR_SITE_LAT, RADAR_SITE_LON], { icon: radarTowerIcon })
      .bindTooltip('KPBZ — Pittsburgh/Moon Twp NEXRAD', { direction: 'top' })
      .addTo(radarMap);
    L.circle([RADAR_SITE_LAT, RADAR_SITE_LON], {
      radius: 80 * 1609.34, // ~80mi in meters -- roughly the useful range for base velocity
      color: '#9aa5ad',
      weight: 1,
      dashArray: '4 6',
      fill: false,
      opacity: 0.5,
    }).addTo(radarMap);

    loadRadarFrames();
    setInterval(loadRadarFrames, RADAR_REFRESH_INTERVAL_MS);
    initRadarControls();
  }

  // ---------- earthquakes tab: USGS GeoJSON summary feeds, no API key ----------
  // https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php — these feeds
  // are regenerated by USGS every 1-5 minutes depending on which one, so polling
  // more often than a few minutes wouldn't actually see new data.
  const QUAKE_FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
  const QUAKE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  let quakeMap = null;
  let quakeLayer = null;
  let quakeTimer = null;
  let quakeFeedKey = '2.5_day';

  function quakeDepthColor(depthKm) {
    if (depthKm < 33) return '#ff8a3d';
    if (depthKm < 150) return '#ff5f3d';
    return '#3ddbff';
  }

  function quakeMagRadius(mag) {
    const m = Math.max(mag || 0.5, 0.5);
    return Math.max(4, Math.pow(m, 1.9) * 1.3);
  }

  async function loadQuakeFeed() {
    const caption = document.getElementById('quake-caption');
    if (!quakeMap) return;
    try {
      const res = await fetch(`${QUAKE_FEED_BASE}${quakeFeedKey}.geojson`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const features = Array.isArray(data.features) ? data.features : [];

      if (quakeLayer) quakeMap.removeLayer(quakeLayer);
      quakeLayer = L.layerGroup(features.map(f => {
        const [lon, lat, depth] = f.geometry.coordinates;
        const mag = f.properties.mag ?? 0;
        const color = quakeDepthColor(depth);
        return L.circleMarker([lat, lon], {
          radius: quakeMagRadius(mag),
          color,
          weight: 1.5,
          fillColor: color,
          fillOpacity: 0.55,
        }).bindPopup(`
          <div class="quake-popup-mag">M ${mag.toFixed(1)}</div>
          <div class="quake-popup-place">${f.properties.place || 'Unknown location'}</div>
          <div class="quake-popup-meta">
            Depth ${depth.toFixed(1)} km · ${formatShortTime(new Date(f.properties.time).toISOString())}<br>
            <a href="${f.properties.url}" target="_blank" rel="noopener">USGS event page &rarr;</a>
          </div>
        `);
      })).addTo(quakeMap);

      if (caption) {
        if (features.length) {
          const maxF = features.reduce((a, b) => (b.properties.mag ?? -Infinity) > (a.properties.mag ?? -Infinity) ? b : a);
          caption.textContent = `${features.length} event${features.length === 1 ? '' : 's'} · largest M${(maxF.properties.mag ?? 0).toFixed(1)} · USGS`;
        } else {
          caption.textContent = 'No events in this window · USGS';
        }
      }
    } catch (err) {
      console.warn('Could not load USGS earthquake feed:', err.message);
      if (caption) caption.textContent = 'Earthquake feed unavailable';
    }
  }

  function setQuakeFeed(key) {
    if (quakeFeedKey === key) return;
    quakeFeedKey = key;
    document.querySelectorAll('.quake-range-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.feed === key);
    });
    loadQuakeFeed();
  }

  function initQuakeMap() {
    if (quakeMap) return;
    const el = document.getElementById('quake-map');
    if (!el) return;
    quakeMap = L.map('quake-map', {
      zoomControl: true,
      attributionControl: false,
      worldCopyJump: true,
      minZoom: 2,
    }).setView([RADAR_LAT, RADAR_LON], 3);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19 }).addTo(quakeMap);
    L.marker([RADAR_LAT, RADAR_LON]).addTo(quakeMap);
    document.querySelectorAll('.quake-range-btn').forEach(btn => {
      btn.addEventListener('click', () => setQuakeFeed(btn.dataset.feed));
    });
    loadQuakeFeed();
    if (!quakeTimer) quakeTimer = setInterval(loadQuakeFeed, QUAKE_REFRESH_INTERVAL_MS);
  }

  // ---------- lightning card: our own GLM map + Blitzortung, tabbed ----------
  // fetch_lightning_glm.py runs in update-weather.yml alongside
  // fetch_aurora.py / fetch_alerts.py / fetch_nws_products.py
  const LIGHTNING_GLM_URL = 'data/lightning_glm.json';
  const LIGHTNING_GLM_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  let lightningGlmMap = null;
  let lightningGlmLayer = null;
  let lightningGlmTimer = null;

  async function loadLightningGlm() {
    const caption = document.getElementById('lightning-glm-caption');
    if (!lightningGlmMap) return;
    try {
      const res = await fetch(`${LIGHTNING_GLM_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const flashes = Array.isArray(data.flashes) ? data.flashes : [];
      if (lightningGlmLayer) lightningGlmMap.removeLayer(lightningGlmLayer);
      lightningGlmLayer = L.layerGroup(flashes.map(f => L.circleMarker([f.lat, f.lon], {
        radius: 5,
        color: '#ffcc33',
        weight: 1,
        fillColor: '#ffcc33',
        fillOpacity: 0.7,
      }).bindTooltip(formatShortTime(f.time), { direction: 'top' }))).addTo(lightningGlmMap);
      if (caption) {
        const n = flashes.length;
        const windowMin = data.window_minutes || 15;
        caption.textContent = n
          ? `${n} flash${n === 1 ? '' : 'es'} · last ${windowMin} min · NOAA GOES-19 GLM`
          : `No flashes detected nearby · last ${windowMin} min · NOAA GOES-19 GLM`;
      }
    } catch (err) {
      if (caption) caption.textContent = 'GLM data not available yet';
    }
  }

  function initLightningGlmMap() {
    if (lightningGlmMap) return;
    const el = document.getElementById('lightning-glm-map');
    if (!el) return;
    lightningGlmMap = L.map('lightning-glm-map', {
      zoomControl: true,
      attributionControl: false,
    }).setView([RADAR_LAT, RADAR_LON], 7);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19 }).addTo(lightningGlmMap);
    L.marker([RADAR_LAT, RADAR_LON]).addTo(lightningGlmMap);
    loadLightningGlm();
    if (!lightningGlmTimer) lightningGlmTimer = setInterval(loadLightningGlm, LIGHTNING_GLM_REFRESH_INTERVAL_MS);
  }

  // the lightning card's enlarged view has its own small two-tab switcher
  function initLightningMapTabs(lightningCard) {
    const tabs = lightningCard.querySelectorAll('.lightning-map-tab');
    const views = lightningCard.querySelectorAll('.lightning-map-view');
    const order = Array.from(views).map(v => v.id);

    const activate = (target) => {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.target === target));
      views.forEach(v => v.classList.toggle('active', v.id === target));
      if (target === 'lightning-map-panel-glm') {
        initLightningGlmMap();
        setTimeout(() => lightningGlmMap && lightningGlmMap.invalidateSize(), 50);
      } else {
        const iframe = lightningCard.querySelector('.lightning-map-frame[data-src]');
        if (iframe) { iframe.src = iframe.dataset.src; iframe.removeAttribute('data-src'); }
      }
    };

    tabs.forEach(tab => tab.addEventListener('click', (e) => { e.stopPropagation(); activate(tab.dataset.target); }));

    const viewsWrap = lightningCard.querySelector('.lightning-map-views');
    if (viewsWrap) {
      let touchStartX = null;
      viewsWrap.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
      viewsWrap.addEventListener('touchend', (e) => {
        if (touchStartX === null) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        touchStartX = null;
        if (Math.abs(dx) < 40) return; // ignore taps/vertical scroll
        const current = lightningCard.querySelector('.lightning-map-tab.active')?.dataset.target;
        const idx = order.indexOf(current);
        if (idx === -1) return;
        const nextIdx = dx < 0 ? Math.min(idx + 1, order.length - 1) : Math.max(idx - 1, 0);
        if (nextIdx !== idx) activate(order[nextIdx]);
      }, { passive: true });
    }

    // GLM is the default tab -- it's already marked active in the markup,
    // so just make sure its map actually exists.
    initLightningGlmMap();
  }

  function initMapTabs() {
    const tabs = document.querySelectorAll('.map-tab');
    const panels = document.querySelectorAll('.map-panel');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.toggle('active', t === tab));
        panels.forEach(p => p.classList.toggle('active', p.id === tab.dataset.target));
        const activePanel = document.getElementById(tab.dataset.target);
        const lazyIframe = activePanel && activePanel.querySelector('iframe[data-src]');
        if (lazyIframe) {
          lazyIframe.src = lazyIframe.dataset.src;
          lazyIframe.removeAttribute('data-src');
        }
        if (tab.dataset.target === 'map-panel-radar') {
          setTimeout(() => radarMap && radarMap.invalidateSize(), 50);
        }
        if (tab.dataset.target === 'map-panel-quakes') {
          initQuakeMap();
          setTimeout(() => quakeMap && quakeMap.invalidateSize(), 50);
        }
      });
    });
  }

  // builds the footer easter-egg row from THEMES itself, so it stays in
  // sync automatically if themes are ever added/removed/renamed. Each
  // badge uses the theme's curated meteocon (theme.meteocon -- see the
  // THEMES table a few hundred lines down), but in its static (non-
  // animated) form -- staticOnly: true -- since a dozen animated icons
  // all moving at once was hard to look at. See the comment on
  // loadMeteoconOrFallback() for what that requires and how it degrades
  // gracefully if the static asset isn't there yet.
  function populateThemePreviewRow() {
    const row = document.getElementById('theme-preview-row');
    if (!row) return;
    Object.entries(THEMES).forEach(([key, theme]) => {
      const span = document.createElement('span');
      span.className = 'theme-preview-icon';
      loadMeteoconOrFallback(theme, span, { staticOnly: true });
      span.addEventListener('click', () => previewTheme(key));
      row.appendChild(span);
    });
  }

  // hidden 🌈 corner button that reveals/hides the theme
  // preview panel. click-outside and the trigger itself both toggle it;
  // aria-expanded kept in sync for screen reader users even though the
  // button is visually near-invisible at rest.
  function initThemeEasterEgg() {
    const trigger = document.getElementById('theme-egg-trigger');
    const panel = document.getElementById('theme-preview-panel');
    if (!trigger || !panel) return;

    function setOpen(open) {
      panel.classList.toggle('open', open);
      panel.setAttribute('aria-hidden', String(!open));
      trigger.classList.toggle('egg-open', open);
      trigger.setAttribute('aria-expanded', String(open));
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!panel.classList.contains('open'));
    });

    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || trigger.contains(e.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
    });
  }

  function initWeatherFx() {
    const rainContainer = document.getElementById('fx-rain');
    const cloudContainer = document.getElementById('fx-clouds');

    for (let i = 0; i < 28; i++) {
      const drop = document.createElement('div');
      drop.className = 'raindrop';
      drop.style.left = `${Math.random() * 100}%`;
      drop.style.animationDuration = `${0.6 + Math.random() * 0.6}s`;
      drop.style.animationDelay = `${Math.random() * 2}s`;
      rainContainer.appendChild(drop);
    }
    for (let i = 0; i < 20; i++) {
      const drop = document.createElement('div');
      drop.className = 'raindrop raindrop-extra';
      drop.style.left = `${Math.random() * 100}%`;
      drop.style.animationDuration = `${0.5 + Math.random() * 0.5}s`;
      drop.style.animationDelay = `${Math.random() * 2}s`;
      rainContainer.appendChild(drop);
    }

    // a handful of organic lobe shapes puffs are randomly assigned, so
    // clouds read as piled-up cumulus rather than uniform blurred ovals.
    const CLOUD_PUFF_SHAPES = [
      '42% 46% 40% 44% / 58% 54% 62% 56%',
      '48% 40% 46% 42% / 54% 60% 50% 58%',
      '40% 48% 44% 40% / 60% 52% 58% 54%',
      '46% 42% 48% 44% / 56% 58% 52% 60%',
    ];

    for (let i = 0; i < 5; i++) {
      const cloud = document.createElement('div');
      cloud.className = 'cloud-shape';
      // roughly 2 in 5 clouds get the soft iridescent treatment, mixed in
      // among the plain ones rather than replacing them entirely.
      const isIridescent = Math.random() < 0.4;
      cloud.style.top = `${Math.random() * 50}%`;
      cloud.style.animationDuration = `${70 + Math.random() * 40}s`;
      cloud.style.animationDelay = `${Math.random() * -60}s`;
      const scale = 0.7 + Math.random() * 0.8;
      const depthOpacity = 0.3 + Math.random() * 0.4;
      cloud.style.transform = `scale(${scale})`;
      cloud.style.opacity = depthOpacity;

      // flat-bottomed base layer first, so the rounded top puffs pile up
      // on top of it -- this is what actually sells "cumulus" over a
      // generic drifting blob.
      const base = document.createElement('div');
      base.className = 'cloud-puff cloud-base' + (isIridescent ? ' iridescent' : '');
      base.style.width = `${140 + Math.random() * 50}px`;
      base.style.height = '34px';
      base.style.left = `${10 + Math.random() * 20}px`;
      base.style.top = `${44 + Math.random() * 10}px`;
      base.style.opacity = 0.4 + Math.random() * 0.2;
      if (isIridescent) base.style.animationDelay = `${Math.random() * -16}s`;
      cloud.appendChild(base);

      const puffCount = 5 + Math.floor(Math.random() * 3);
      for (let p = 0; p < puffCount; p++) {
        const puff = document.createElement('div');
        puff.className = 'cloud-puff' + (isIridescent ? ' iridescent' : '');
        const size = 40 + Math.random() * 60;
        puff.style.width = `${size}px`;
        puff.style.height = `${size * (0.6 + Math.random() * 0.3)}px`;
        puff.style.left = `${(p / puffCount) * 180 + Math.random() * 20}px`;
        puff.style.top = `${Math.random() * 25}px`;
        puff.style.opacity = 0.5 + Math.random() * 0.4;
        puff.style.borderRadius = CLOUD_PUFF_SHAPES[Math.floor(Math.random() * CLOUD_PUFF_SHAPES.length)];
        if (isIridescent) puff.style.animationDelay = `${Math.random() * -16}s`;
        cloud.appendChild(puff);
      }
      cloudContainer.appendChild(cloud);
    }

    const starContainer = document.getElementById('fx-stars');
    for (let i = 0; i < 60; i++) {
      const star = document.createElement('div');
      star.className = 'star';
      const size = 1 + Math.random() * 1.8; 
      star.style.width = `${size}px`;
      star.style.height = `${size}px`;
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 70}%`; 
      star.style.animationDuration = `${3 + Math.random() * 5}s`;
      star.style.animationDelay = `${Math.random() * -8}s`;
      star.style.setProperty('--star-min-opacity', (0.1 + Math.random() * 0.2).toFixed(2));
      star.style.setProperty('--star-max-opacity', (0.6 + Math.random() * 0.4).toFixed(2));
      starContainer.appendChild(star);
    }

    const starExtraContainer = document.getElementById('fx-stars-extra');
    for (let i = 0; i < 70; i++) {
      const star = document.createElement('div');
      star.className = 'star';
      const size = 0.8 + Math.random() * 1.6;
      star.style.width = `${size}px`;
      star.style.height = `${size}px`;
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 70}%`;
      star.style.animationDuration = `${3 + Math.random() * 5}s`;
      star.style.animationDelay = `${Math.random() * -8}s`;
      star.style.setProperty('--star-min-opacity', (0.1 + Math.random() * 0.2).toFixed(2));
      star.style.setProperty('--star-max-opacity', (0.6 + Math.random() * 0.4).toFixed(2));
      starExtraContainer.appendChild(star);
    }

    const AURORA_GRADIENTS = [
      'linear-gradient(180deg, rgba(255,90,160,0) 0%, rgba(255,90,160,.4) 12%, rgba(70,255,150,.65) 42%, rgba(70,255,150,.3) 68%, rgba(120,80,255,.35) 100%)',
      'linear-gradient(180deg, rgba(190,110,255,0) 0%, rgba(190,110,255,.3) 8%, rgba(90,255,175,.6) 40%, rgba(60,200,255,.4) 72%, rgba(190,110,255,.25) 100%)',
      'linear-gradient(180deg, rgba(255,130,190,0) 0%, rgba(255,130,190,.35) 14%, rgba(110,255,140,.6) 44%, rgba(90,255,195,.3) 70%, rgba(140,90,255,.3) 100%)',
      'linear-gradient(180deg, rgba(120,90,255,0) 0%, rgba(120,90,255,.3) 10%, rgba(80,255,160,.55) 38%, rgba(255,110,175,.3) 66%, rgba(90,190,255,.25) 100%)',
    ];
    const auroraContainer = document.getElementById('fx-aurora');
    for (let i = 0; i < 4; i++) {
      const band = document.createElement('div');
      band.className = 'aurora-band';
      band.style.background = AURORA_GRADIENTS[i % AURORA_GRADIENTS.length];
      band.style.top = `${-10 + i * 4}%`;
      band.style.height = `${55 + Math.random() * 20}%`;
      band.style.left = `${-30 + Math.random() * 20}%`;
      band.style.opacity = (0.5 + Math.random() * 0.3).toFixed(2);
      const waveDuration = 14 + Math.random() * 10;
      const shimmerDuration = 5 + Math.random() * 4;
      band.style.animation = `aurora-wave ${waveDuration}s ease-in-out infinite, aurora-shimmer ${shimmerDuration}s ease-in-out infinite`;
      band.style.animationDelay = `${(-Math.random() * waveDuration).toFixed(2)}s, ${(-Math.random() * shimmerDuration).toFixed(2)}s`;
      auroraContainer.appendChild(band);
    }

    const smokeContainer = document.getElementById('fx-smoke');
    for (let i = 0; i < 5; i++) {
      const puff = document.createElement('div');
      puff.className = 'smoke-puff';
      const size = 220 + Math.random() * 200;
      puff.style.width = `${size}px`;
      puff.style.height = `${size * 0.6}px`;
      puff.style.top = `${Math.random() * 90}%`;
      puff.style.animationDuration = `${150 + Math.random() * 100}s`;
      puff.style.animationDelay = `${Math.random() * -120}s`;
      puff.style.opacity = 0.4 + Math.random() * 0.3;
      smokeContainer.appendChild(puff);
    }

    const snowContainer = document.getElementById('fx-snow');
    for (let i = 0; i < 40; i++) {
      const flake = document.createElement('div');
      flake.className = 'snowflake';
      const size = 3 + Math.random() * 4;
      flake.style.width = `${size}px`;
      flake.style.height = `${size}px`;
      flake.style.left = `${Math.random() * 100}%`;
      flake.style.opacity = 0.5 + Math.random() * 0.5;
      flake.style.animationDuration = `${8 + Math.random() * 8}s`;
      flake.style.animationDelay = `${Math.random() * -10}s`;
      snowContainer.appendChild(flake);
    }
  }

  // ---------- sun & moon tracker ----------
  const SUNMOON_LAT = 40.604;
  const SUNMOON_LON = -80.286;

  const MOON_PHASE_IMAGES = [
    null,
    'https://svs.gsfc.nasa.gov/vis/a000000/a004300/a004310/ph1_waxing_crescent_2k_print.jpg',
    'https://svs.gsfc.nasa.gov/vis/a000000/a004300/a004310/ph2_first_quarter_2k_print.jpg',
    'https://svs.gsfc.nasa.gov/vis/a000000/a004300/a004310/ph3_waxing_gibbous_2k_print.jpg',
    'https://svs.gsfc.nasa.gov/vis/a000000/a004300/a004310/ph4_full_moon_2k_print.jpg',
    'https://svs.gsfc.nasa.gov/vis/a000000/a004300/a004310/ph5_waning_gibbous_2k_print.jpg',
    'https://svs.gsfc.nasa.gov/vis/a000000/a004300/a004310/ph6_third_quarter_2k_print.jpg',
    'https://svs.gsfc.nasa.gov/vis/a000000/a004300/a004310/ph7_waning_crescent_2k_print.jpg',
  ];

  // shared by every moon-phase consumer below (sky tracker image, its
  // label, and the title icon) so the 8-bucket rounding rule only lives
  // in one place.
  function getMoonPhaseIndex(phase) {
    return Math.round(phase * 8) % 8;
  }

  function getMoonPhaseImageUrl(phase) {
    return MOON_PHASE_IMAGES[getMoonPhaseIndex(phase)];
  }

  function renderMoonPhaseImage(el, phase) {
    const imageUrl = getMoonPhaseImageUrl(phase);
    if (imageUrl) {
      el.innerHTML = `<div class="sky-body-frame"><img class="moon-body-img" src="${imageUrl}" alt="Moon phase"></div>`;
    } else {
      el.innerHTML = `<div class="sky-body-frame"><div class="moon-body-newmoon"></div></div>`;
    }
  }

  function getMoonPhaseName(phase) {
    const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
    return names[getMoonPhaseIndex(phase)];
  }

  let currentForecastPeriods = [];
  let currentForecastHourly = [];
  let currentAurora = null;
  const AURORA_KP_THRESHOLD = 7;
  
  function getStargazingScore(periods, moonFraction) {
    const nightPeriod = periods.find(p => p.isDaytime === false) || periods[0];
    const sky = (nightPeriod?.shortForecast || '').toLowerCase();
    let cloudScore;
    if (/(rain|snow|storm|shower|drizzle)/.test(sky)) cloudScore = 2;
    else if (/(overcast)/.test(sky) || (/cloudy/.test(sky) && !/partly|mostly clear|mostly sunny/.test(sky))) cloudScore = 2;
    else if (/(partly|mostly cloudy)/.test(sky)) cloudScore = 1;
    else cloudScore = 0;
    const moonPct = Math.round(moonFraction * 100);

    if (cloudScore === 2) return { label: 'Poor', className: 'sky-badge-poor' };
    if (cloudScore === 1) return moonPct > 60 ? { label: 'Poor', className: 'sky-badge-poor' } : { label: 'Fair', className: 'sky-badge-fair' };
    if (moonPct < 25) return { label: 'Excellent', className: 'sky-badge-excellent' };
    if (moonPct < 60) return { label: 'Good', className: 'sky-badge-good' };
    if (moonPct < 85) return { label: 'Fair', className: 'sky-badge-fair' };
    return { label: 'Poor', className: 'sky-badge-poor' };
  }

  function getAuroraBadgeClass(chance) {
    if (chance === 'Likely!' || chance === 'Possible!') return 'sky-badge-active';
    if (chance === 'Elevated') return 'sky-badge-elevated';
    return 'sky-badge-poor';
  }

  function updateSkyBadges() {
    const container = document.getElementById('sky-badges');
    if (!container) return;
    const moonIllum = SunCalc.getMoonIllumination(new Date());
    const stars = getStargazingScore(currentForecastPeriods, moonIllum.fraction);

    let badgesHtml = `
      <div class="sky-badge ${stars.className}">
        🔭 <span class="sky-badge-label">Stargazing:</span> ${stars.label}
      </div>
    `;
    if (currentAurora) {
      const auroraClass = getAuroraBadgeClass(currentAurora.auroraChance);
      badgesHtml += `
        <div class="sky-badge ${auroraClass}">
          🌌 <span class="sky-badge-label">Aurora:</span> ${currentAurora.auroraChance} (Kp ${currentAurora.kp})
        </div>
      `;
    }
    container.innerHTML = badgesHtml;
    updateStarBoost(stars.label);
  }

  function updateStarBoost(stargazingLabel) {
    const sunPos = SunCalc.getPosition(new Date(), SUNMOON_LAT, SUNMOON_LON);
    const isNight = sunPos.altitude < 0;
    const auroraActive = !!(currentAurora && currentAurora.kp >= AURORA_KP_THRESHOLD);
    const clearAndGood = stargazingLabel === 'Excellent' || stargazingLabel === 'Good';
    document.body.classList.toggle('fx-stars-boost', isNight && clearAndGood && !auroraActive);
  }

  function positionSkyBody(el, altitudeRad, azimuthRad) {
    const altDeg = altitudeRad * 180 / Math.PI;
    const azDeg = azimuthRad * 180 / Math.PI;
    const leftPercent = ((azDeg + 180) / 360) * 100;
    const clampedAlt = Math.max(-15, Math.min(90, altDeg));
    const topPercent = 88 - ((clampedAlt + 15) / 105) * 74;
    const opacity = altDeg <= -15 ? 0 : Math.min(1, (altDeg + 15) / 15);
    el.style.left = `${leftPercent}%`;
    el.style.top = `${topPercent}%`;
    el.style.opacity = opacity;
  }

  function updateSunMoonTracker() {
    const now = new Date();
    const sunPos = SunCalc.getPosition(now, SUNMOON_LAT, SUNMOON_LON);
    const sunTimes = SunCalc.getTimes(now, SUNMOON_LAT, SUNMOON_LON);
    const moonPos = SunCalc.getMoonPosition(now, SUNMOON_LAT, SUNMOON_LON);
    const moonIllum = SunCalc.getMoonIllumination(now);
    const moonTimes = SunCalc.getMoonTimes(now, SUNMOON_LAT, SUNMOON_LON);

    positionSkyBody(document.getElementById('sun-body'), sunPos.altitude, sunPos.azimuth);
    positionSkyBody(document.getElementById('moon-body'), moonPos.altitude, moonPos.azimuth);
    renderMoonPhaseImage(document.getElementById('moon-body'), moonIllum.phase);

    const fmt = (d) => d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
    let moonRiseSetText;
    if (moonTimes.alwaysUp) moonRiseSetText = 'Up all day';
    else if (moonTimes.alwaysDown) moonRiseSetText = 'Down all day';
    else moonRiseSetText = `${fmt(moonTimes.rise)} / ${fmt(moonTimes.set)}`;

    document.getElementById('sunmoon-details').innerHTML = `
      <div><strong>Sunrise</strong><br>${fmt(sunTimes.sunrise)}</div>
      <div><strong>Solar Noon</strong><br>${fmt(sunTimes.solarNoon)}</div>
      <div><strong>Sunset</strong><br>${fmt(sunTimes.sunset)}</div>
      <div><strong>Moonrise / Moonset</strong><br>${moonRiseSetText}</div>
      <div><strong>Moon Phase</strong><br>${getMoonPhaseName(moonIllum.phase)} (${Math.round(moonIllum.fraction * 100)}%)</div>
    `;
    updateSkyBadges();
  }

  function initSunMoonTracker() {
    updateSunMoonTracker();
    setInterval(updateSunMoonTracker, 60 * 1000); 
  }


  //* 🌈☀️☔💜🌩️🌪️🌧️ ~~~ WEATHER TRIGGERED THEMES ~~~ 🌈⛅️☀️⛈️❄️🍀💜🌙 *//

  
  const WINDY_WIND_MPH = 11;           
  const THUNDERSTORM_WIND_MPH = 15;    
  const RAIN_PRECIP_INHR = 0.01;
  const EXTREME_HEAT_TEMP_F = 90;      
  const AQI_SMOKE_THRESHOLD = 150;
  const LIGHTNING_NEARBY_MI = 15;      // our own sensor's typical CG detection range
  const LIGHTNING_RECENT_MIN = 15;     // how fresh a strike has to be to count as "active" nearby

function getAqiColor(aqi) {
  if (aqi === undefined || aqi === null) return null;
  if (aqi <= 50) return '#54ab7c';   // good
  if (aqi <= 100) return '#ffeb3b';  // moderate
  if (aqi <= 150) return '#ff7e00';  // unhealthy for sensitive groups
  if (aqi <= 200) return '#ff4136';  // unhealthy
  if (aqi <= 300) return '#8f3f97';  // very unhealthy
  return '#7e0023';                  // hazardous
}

const FONT_ROLES = {
  title:       { cssVar: '--font-page-title',   fallback: "Macondo, Palatino, serif" },
  cardHeading: { cssVar: '--font-card-heading', fallback: "Figtree, Tahoma, serif" },
  body:        { cssVar: '--font-body',         fallback: "Figtree, Tahoma, sans-serif" },
  details:     { cssVar: '--font-details',      fallback: "Figtree, Tahoma, sans-serif" },
  gridLabel:   { cssVar: '--font-grid-label',   fallback: "Figtree, Yahoma, sans-serif" },
  gridValue:   { cssVar: '--font-grid-value',   fallback: "Figtree, Tahoma, sans-serif" },
};

// * ☀️ ------- THEME COLORS, TEXT STYLES, AND ICONS HERE ------- 🌙 * //
  
const THEMES = {
    sunny:             { bg: '#FBBF24', card: '#FFFFFF', accent: '#D97706', muted: '#B45309', text: '#78350F', title: '#ffffff', icon: '☀️', meteocon: 'clear-day.svg', iconImg: 'icons/themes/sunny.png', lightCard: true, fonts: { title: "Monas, Papyrus, serif", cardHeading: "Monas" } },
    extremeHeat:       { bg: '#351a13', card: '#5f2d1d', accent: '#e9895d', muted: '#d7a07e', text: '#fff4ec', title: '#fff8f2', icon: '🔥☀️', meteocon: 'thermometer-sun.svg', iconImg: 'icons/themes/extremeHeat.png', fonts: { title: "Monas, Papyrus, serif", cardHeading: "Monas" } },
    extremeHeatNight:  { bg: '#201416', card: '#3d2522', accent: '#dc8977', muted: '#d2a095', text: '#fff2ed', title: '#fff8f5', icon: '🔥🌙', meteocon: 'thermometer-moon.svg', iconImg: 'icons/themes/extremeHeatNight.png', fonts: { title: "NightWindSent, Papyrus, serif", cardHeading: "Monas" } },
    cloudy:            { bg: 'linear-gradient(180deg, #8FC0E8 0%, #A9CBE7 30%, #C9CEE3 58%, #E7D5D0 82%, #F3E3D3 100%)', card: '#F5F3F7', accent: '#3E6E9E', muted: '#5F6E96', text: '#3A3B5A', title: '#ffffff', icon: '⛅️', meteocon: 'partly-cloudy-day.svg', iconImg: 'icons/themes/cloudy.png', lightCard: true, fonts: { title: "Groovy Clouds, Tahoma", cardHeading: "Figtree" } },
    rainy:             { bg: '#143A52', card: '#0E2939', accent: '#C6E0F1', muted: '#EAF4FA', text: '#ffffff', title: '#ffffff', icon: '🌧️', meteocon: 'rain.svg', iconImg: 'icons/themes/rainy.png', fonts: { title: "Letter Magic, Tahoma" } },
    rainyNight:        { bg: '#0E2939', card: '#143A52', accent: '#C6E0F1', muted: '#EAF4FA', text: '#ffffff', title: '#ffffff', icon: '🌧️🌙', meteocon: 'mostly-clear-night-rain.svg', iconImg: 'icons/themes/rainyNight.png', fonts: { title: "Lavishly Yours, cursive" } },
    snowy:             { bg: "#ABE9FF", card: "#EBF9FF", accent: "#9EA9FF", muted: "#73B0FF", text: "#537499", title: "#E3F4FF", icon: '❄️', meteocon: 'snow.svg', iconImg: 'icons/themes/snowy.png', fonts: { title: "Snowby, sans-serif" } },
    snowyNight:        { bg: '#0f151c', card: '#182530', accent: '#a8d8f0', muted: '#dcf0f7', text: '#ffffff', title: '#ffffff', icon: '❄️🌙', meteocon: 'partly-cloudy-night-snow.svg', iconImg: 'icons/themes/snowyNight.png', fonts: { title: "Snowby, sans-serif" } },
    night:             { bg: '#14112F', card: '#41406a', accent: '#9F86C0', muted: '#f0eff6', text: '#ffffff', title: '#ffffff', icon: '🌙', meteocon: 'starry-night.svg', iconImg: 'icons/themes/night.png', fonts: { title: "Lavishly Yours, cursive", details: "Figtree" } },
    auroraNight:       { bg: '#05060f', card: '#141a33', accent: '#7CFFB2', muted: '#eae6ff', text: '#ffffff', title: '#ffffff', icon: '🌌', meteocon: 'aurora.svg', iconImg: 'icons/themes/auroraNight.png',  fonts: { title: "Lavishly Yours, cursive" } },
    windy:             { bg: '#1c2b28', card: '#25372f', accent: '#7fe0c0', muted: '#dcf0f7', text: '#ffffff', title: '#ffffff', icon: '🌬️', meteocon: 'wind.svg', iconImg: 'icons/themes/windy.png', fonts: { title: "Lavishly Yours, cursive" } },
    windyNight:        { bg: '#111d1a', card: '#1a2c26', accent: '#5fc7a3', muted: '#dcf0f7', text: '#ffffff', title: '#ffffff', icon: '🌬️🌙', meteocon: 'wind-night.svg', iconImg: 'icons/themes/windyNight.png', fonts: { title: "NightWindSent, cursive" } },
    thunderstorm:      { bg: '#181022', card: '#241a33', accent: '#c79bff', muted: '#ffcc4d', text: '#ffffff', title: '#ffffff', icon: '⛈️', meteocon: 'thunderstorms.svg', iconImg: 'icons/themes/thunderstorm.png', fonts: { title: "Tornado, cursive" } },
    thunderstormNight: { bg: '#0d0a17', card: '#191228', accent: '#9b7dff', muted: '#ffcc4d', text: '#ffffff', title: '#ffffff', icon: '⛈️🌙', meteocon: 'thunderstorms-night.svg', iconImg: 'icons/themes/thunderstormNight.png', fonts: { title: "NightWindSent, cursive" } },
    flood:             { bg: '#1a2e28', card: '#12211c', accent: '#5ba88f', muted: '#cfe8df', text: '#ffffff', title: '#ffffff', icon: '🌊', meteocon: 'water-alert.svg', iconImg: 'icons/themes/flood.png', fonts: { title: "Eagle Lake" } },
    floodNight:        { bg: '#0d1c17', card: '#16261f', accent: '#4a8f78', muted: '#cfe8df', text: '#ffffff', title: '#ffffff', icon: '🌊🌙', meteocon: 'water-alert-night.svg', iconImg: 'icons/themes/floodNight.png', fonts: { title: "NightWindSent, serif" } },
    tornado:           { bg: '#2b3a1f', card: '#1c2814', accent: '#a8c95a', muted: '#d4e8a8', text: '#ffffff', title: '#ffffff', icon: '🌪️', meteocon: 'tornado-alert.svg', iconImg: 'icons/themes/tornado.png', fonts: { title: "Tornado" } },
    tornadoNight:      { bg: '#141d0d', card: '#1c2814', accent: '#8fae4a', muted: '#d4e8a8', text: '#ffffff', title: '#ffffff', icon: '🌪️🌙', meteocon: 'tornado-alert-night.svg', iconImg: 'icons/themes/tornadoNight.png', fonts: { title: "Tornado" } },
  };

  // reads the hour directly out of the station's own obsTimeLocal string
  // (via parseStationTime) -- NOT the visitor's browser clock. don't
  // "simplify" this to Date.now() or a browser-local Date -- 
  // the day/night theme reflects conditions at the station,
  // not wherever the page happens to be open.
  function isNightTime(data) {
    const hour = parseStationTime(data.obsTimeLocal).getHours();
    return hour < 6 || hour >= 20;
  }

  function getAlertOverride(alerts, isNight) {
    if (!alerts || alerts.length === 0) return null;
    const events = alerts.map(a => (a.event || '').toLowerCase());
    if (events.some(e => e.includes('tornado warning'))) return { theme: isNight ? 'tornadoNight' : 'tornado', extraRain: true, lightning: true, tornadoVignette: true };
    if (events.some(e => e.includes('severe thunderstorm warning'))) return { theme: isNight ? 'thunderstormNight' : 'thunderstorm', extraRain: true, lightning: true };
    if (events.some(e => e.includes('flood warning') || e.includes('flash flood warning'))) return { theme: isNight ? 'floodNight' : 'flood', extraRain: false, lightning: false };
    if (events.some(e => e.includes('winter storm warning') || e.includes('blizzard warning'))) return { theme: isNight ? 'snowyNight' : 'snowy', snow: true };
    if (events.some(e => e.includes('high wind warning'))) return { theme: isNight ? 'windyNight' : 'windy' };
    if (events.some(e => e.includes('excessive heat warning'))) return { theme: isNight ? 'extremeHeatNight' : 'extremeHeat' };
    return null;
  }

  function getAuroraOverride(isNight) {
    if (!isNight) return null;
    if (!currentAurora || currentAurora.kp === undefined || currentAurora.kp === null) return null;
    if (currentAurora.kp < AURORA_KP_THRESHOLD) return null;
    return { theme: 'auroraNight', aurora: true };
  }

  let lightningActive = false;
  let lightningTimer = null;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function scheduleLightning() {
    if (!lightningActive || prefersReducedMotion) return;
    const delay = 8000 + Math.random() * 12000;
    lightningTimer = setTimeout(() => {
      const el = document.getElementById('fx-lightning');
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 200);
      scheduleLightning();
    }, delay);
  }

  function setLightningActive(active) {
    if (active === lightningActive) return;
    lightningActive = active;
    if (active) scheduleLightning();
    else clearTimeout(lightningTimer);
  }

  // "nearby" lightning for theme purposes = our own sensor's most recent
  // strike is both close (within LIGHTNING_NEARBY_MI) and fresh (within
  // LIGHTNING_RECENT_MIN) -- lightningStrikeCount is a today-so-far total
  // and isn't useful on its own for "is it happening right now".
  function isLightningNearby(data) {
    if (data.lightningDistance == null || data.lightningDistance > LIGHTNING_NEARBY_MI) return false;
    if (!data.lightningLastStrike) return false;
    const lastStrikeMs = new Date(data.lightningLastStrike).getTime();
    if (!Number.isFinite(lastStrikeMs)) return false;
    const ageMin = (Date.now() - lastStrikeMs) / 60000;
    return ageMin >= 0 && ageMin <= LIGHTNING_RECENT_MIN;
  }

  function classifyWeather(data) {
    const isNight = isNightTime(data);
    const precip = data.precipRate || 0;
    const wind = Math.max(data.windSpeed || 0, data.windGust || 0);
    const feelsLike = Math.max(data.temp || 0, data.heatIndex || 0);
    const isRaining = precip > RAIN_PRECIP_INHR;
    let condition = null;
    // thunderstorm = raining AND (windy OR lightning nearby) -- rain alone,
    // even heavy rain, never triggers it on its own.
    if (isRaining && (wind >= THUNDERSTORM_WIND_MPH || isLightningNearby(data))) condition = 'thunderstorm';
    else if (isRaining && data.temp <= 32) condition = 'snowy';
    else if (isRaining) condition = 'rainy';
    else if (wind >= WINDY_WIND_MPH) condition = 'windy';
    else if (feelsLike >= EXTREME_HEAT_TEMP_F) condition = 'extremeHeat';
    if (condition) return isNight ? `${condition}Night` : condition;
    if (isNight) return 'night';
    if ((data.solarRadiation || 0) > 850) return 'sunny';
    return 'cloudy';
  }

  //  🌈☀️💜 title-bar weather icon 💜🍀🌪️ 
  // title-bar icon next to the page heading scoped to the
  // plain 'night' theme only (clear sky, nothing else going on)
  // diff night variants (rainyNight, snowyNight, extremeHeatNight, ...)
  function setThemeIcon(theme, themeKey) {
    const el = document.getElementById('weather-icon');
    el.innerHTML = '';
    if (themeKey === 'night') {
      const phase = SunCalc.getMoonIllumination(new Date()).phase;
      const imageUrl = getMoonPhaseImageUrl(phase);
      if (imageUrl) {
        const frame = document.createElement('span');
        frame.className = 'weather-icon-moon-frame';
        const img = document.createElement('img');
        img.src = `${imageUrl}?v=2`;
        img.alt = 'Tonight\u2019s moon phase';
        img.className = 'weather-icon-moon-img';
        img.loading = 'eager';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => loadMeteoconOrFallback(theme, el);
        frame.appendChild(img);
        el.appendChild(frame);
        return;
      }
    }
    loadMeteoconOrFallback(theme, el);
  }
// static icons for use in busy areas
  function loadMeteoconOrFallback(theme, el, options = {}) {
    if (options.staticOnly && theme.meteocon) {
      const img = document.createElement('img');
      img.src = `icons/static/${theme.meteocon}`;
      img.alt = theme.icon;
      img.className = 'weather-icon-img meteocon';
      img.onerror = () => {
        el.innerHTML = '';
        if (theme.iconImg) {
          const fallbackImg = document.createElement('img');
          fallbackImg.src = theme.iconImg;
          fallbackImg.alt = theme.icon;
          fallbackImg.className = 'weather-icon-img';
          fallbackImg.onerror = () => { el.textContent = theme.icon; };
          el.appendChild(fallbackImg);
        } else {
          el.textContent = theme.icon;
        }
      };
      el.appendChild(img);
      return;
    }
    if (theme.meteocon) {
      const img = document.createElement('img');
      img.src = `icons/${theme.meteocon}`;
      img.alt = theme.icon;
      img.className = 'weather-icon-img meteocon';
      img.onerror = () => { el.textContent = theme.icon; };
      el.appendChild(img);
    } else if (theme.iconImg) {
      const img = document.createElement('img');
      img.src = theme.iconImg;
      img.alt = theme.icon;
      img.className = 'weather-icon-img';
      img.onerror = () => { el.textContent = theme.icon; };
      el.appendChild(img);
    } else {
      el.textContent = theme.icon;
    }
  }

  let previousIsNightState = null;
  function triggerDayNightTransition() {
    const overlay = document.getElementById('day-night-overlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    void overlay.offsetWidth; 
    overlay.classList.add('active');
  }

  // last theme actually driven by real data -- tracked so preview() can
  // restore it afterward without needing to re-run classifyWeather().
  let lastRealTheme = { key: 'cloudy', aqi: null, alertFx: null };

  function applyTheme(themeKey, aqi, alertFx, options = {}) {
    const isPreview = !!options.preview;
    const isNightNow = themeKey === 'night' || themeKey.endsWith('Night');
    if (!isPreview) {
      if (previousIsNightState === false && isNightNow === true) {
        triggerDayNightTransition();
      }
      previousIsNightState = isNightNow;
      lastRealTheme = { key: themeKey, aqi, alertFx };
    }
    const theme = THEMES[themeKey] || THEMES.cloudy;
    const root = document.documentElement.style;
    root.setProperty('--bg-color', theme.bg);
    root.setProperty('--card-color', theme.card);
    root.setProperty('--title-color', theme.title);
    root.setProperty('--accent-color', theme.accent);
    root.setProperty('--muted-color', theme.muted);
    root.setProperty('--text-color', theme.text);
    const appliedFonts = {};
    Object.entries(FONT_ROLES).forEach(([role, { cssVar, fallback }]) => {
      const value = (theme.fonts && theme.fonts[role]) || fallback;
      root.setProperty(cssVar, value);
      appliedFonts[cssVar] = value;
    });
    setThemeIcon(theme, themeKey);

    const rainThemes = ['rainy', 'rainyNight', 'thunderstorm', 'thunderstormNight', 'flood', 'floodNight', 'tornado', 'tornadoNight'];
    document.body.classList.toggle('theme-light-card', !!theme.lightCard);
    document.body.classList.toggle('theme-extreme-heat', themeKey === 'extremeHeat');
    document.body.classList.toggle('theme-extreme-heat-night', themeKey === 'extremeHeatNight');
    document.body.classList.toggle('fx-active-rain', rainThemes.includes(themeKey));
    document.body.classList.toggle('fx-active-cloudy', themeKey === 'cloudy');
    document.body.classList.toggle('fx-active-stars', themeKey === 'night' || themeKey === 'auroraNight');
    document.body.classList.toggle('fx-active-heatshimmer', themeKey === 'extremeHeat');
    document.body.classList.toggle('fx-active-sunrays', themeKey === 'sunny');
    // 'auroraNight' is only ever reached via the aurora override (see
    // getAuroraOverride, which always pairs it with alertFx.aurora), so
    // gating on the theme key lets the footer preview row show the curtain bands.
    // previewTheme() calls this with alertFx = null.
    document.body.classList.toggle('fx-active-aurora', !!(alertFx && alertFx.aurora) || themeKey === 'auroraNight');
    document.body.classList.toggle('fx-active-smoke', aqi !== undefined && aqi !== null && aqi >= AQI_SMOKE_THRESHOLD);
    document.body.classList.toggle('fx-alert-heavy-rain', !!(alertFx && alertFx.extraRain));
    // 'snowy'/'snowyNight' can be reached two ways: via a winter storm/
    // blizzard warning (alertFx.snow = true) or just from locally-observed
    // snow with no active alert (classifyWeather() picks the theme
    // directly, alertFx is null) 
    document.body.classList.toggle('fx-active-snow', !!(alertFx && alertFx.snow) || themeKey === 'snowy' || themeKey === 'snowyNight');
    // 'tornado'/'tornadoNight' are only ever reached via the tornado-warning
    // override (see getAlertOverride), which always sets tornadoVignette,
    // extraRain, and lightning together, so theyre gated like above
    document.body.classList.toggle('fx-alert-tornado', !!(alertFx && alertFx.tornadoVignette) || themeKey === 'tornado' || themeKey === 'tornadoNight');
    // lightning: 'thunderstorm'/'thunderstormNight' can also
    // be reached from locally-observed heavy rain + wind with no NWS
    // warning active (classifyWeather(), alertFx null) and a
    // thunderstorm theme with no lightning looked broken, alert or not.
    // tornado always implies lightning too.
    const lightningThemes = ['thunderstorm', 'thunderstormNight', 'tornado', 'tornadoNight'];
    setLightningActive(!!(alertFx && alertFx.lightning) || lightningThemes.includes(themeKey));

    if (!isPreview) {
      try {
        localStorage.setItem('cloverWeatherThemeCache', JSON.stringify({
          vars: { '--bg-color': theme.bg, '--card-color': theme.card, '--title-color': theme.title, '--accent-color': theme.accent, '--muted-color': theme.muted, '--text-color': theme.text, ...appliedFonts },
          isNight: themeKey === 'night' || themeKey.endsWith('Night'),
          savedAt: Date.now(),
          iconHtml: document.getElementById('weather-icon').innerHTML
        }));
      } catch (e) {}
      hideLoadingOverlay();
    }
  }

  // shows a quick theme preview (colors/fonts/icon + its matching fx)
  // then reverts to whatever the real weather data last produced.
  // controlled by the easter-egg preview row in the footer. 🥚☔
  let previewRevertTimer = null;
  function previewTheme(themeKey, durationMs = 8000) {
    if (previewRevertTimer) clearTimeout(previewRevertTimer);
    applyTheme(themeKey, null, null, { preview: true });
    previewRevertTimer = setTimeout(() => {
      applyTheme(lastRealTheme.key, lastRealTheme.aqi, lastRealTheme.alertFx, { preview: true });
      previewRevertTimer = null;
    }, durationMs);
  }

  function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (!overlay || overlay.classList.contains('hide')) return;
    Promise.race([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 400)),
    ]).then(() => {
      overlay.classList.add('hide');
      setTimeout(() => overlay.remove(), 800);
    });
  }

  
  //*  ------------🌪️ !! HTML FOR ⛅️ECOWITT WEATHER STATION CARDS + 💨PURPLEAIR AQI + 💧USGS FLOOD GAUGE 🌪️----------- *//
  
  function renderCards(data) {
    // on desktop the live camera tile moves into #grid.
    // saves existing DOM node across the weather-card rebuild so
    // a refresh won't remove the camera from the desktop layout.
    const desktopCameraTile = grid.querySelector('.desktop-camera-tile');

    // prevent lightning map from refreshing with page 
    const openLightningCard = grid.querySelector('.lightning-card.lightning-map-open');
    const preservedLightningPanel = openLightningCard?.querySelector('.lightning-map-panel') || null;
    const preservedLightningBackdrop = openLightningCard?.querySelector('.lightning-map-backdrop') || null;
    if (preservedLightningPanel) document.body.appendChild(preservedLightningPanel);
    if (preservedLightningBackdrop) document.body.appendChild(preservedLightningBackdrop);

    grid.innerHTML = `
      <div class="grid-column" id="grid-column-left"></div>
      <div class="grid-column" id="grid-column-right"></div>
    `;
    const gridLeft = document.getElementById('grid-column-left');
    const gridRight = document.getElementById('grid-column-right');
    const extSafe = (key) => getExtremesSafe(fullHistory, cachedTodaysExtremes, data, key);
    
    // 1. temperature & humidity card
    const tExt = extSafe('temp');
    const hExt = extSafe('humidity');
    const vpd = calculateVPD(data.temp, data.humidity);
    
    let feelsLike = data.temp;
    if (data.temp >= 80 && data.heatIndex) feelsLike = data.heatIndex;
    else if (data.temp <= 50 && data.windChill) feelsLike = data.windChill;
    const dewptComfort = getDewpointComfort(data.dewpt);

    const tempHumCard = document.createElement('div');
    tempHumCard.className = 'card combo-card temp-card';
    tempHumCard.innerHTML = `
      <div class="priority-card-head">
        <div class="priority-icon"><img src="icons/thermometer-fahrenheit.svg" alt=""></div>
        <div class="priority-heading">Temperature</div>
      </div>
      <div class="glance-row priority-glance-row temp-glance-row">
         <div class="glance-col glance-primary">
            <div class="label">Feels Like</div>
            <div class="value priority-value">${formatVal(feelsLike, 1)}<span class="unit">°F</span></div>
            <span class="glance-sub"><span class="glance-sub-label">actual</span> ${formatVal(data.temp, 1)}°F</span>
         </div>
         <div class="glance-col">
            <div class="label">Dew Point</div>
            <div class="value priority-value">${formatVal(data.dewpt, 1)}<span class="unit">°F</span></div>
            <span class="glance-sub">${dewptComfort}</span>
         </div>
      </div>
      <div class="priority-context">RH ${formatVal(data.humidity, 0)}% <span>·</span> ${vpd} kPa VPD</div>
    `;
    gridLeft.appendChild(tempHumCard);
    makeCardExpandable(tempHumCard, 'tempHum', 'more temperature & humidity data', (panel) => {
      const vpdNum = parseFloat(vpd);
      const vpdColor = isNaN(vpdNum) ? 'var(--muted-color)' : (vpdNum < 0.4 ? '#7ab8ff' : vpdNum > 1.6 ? '#e2a355' : '#6fbf8f');
      const vpdGauge = gaugeBarHtml({
        label: 'Vapor Pressure Deficit',
        valueText: `${vpd} kPa${dewptComfort ? ' · ' + dewptComfort : ''}`,
        value: isNaN(vpdNum) ? null : vpdNum, min: 0, max: 2.4,
        zones: [
          { from: 0, to: 0.4, color: '#5b8fd9' },
          { from: 0.4, to: 1.6, color: '#54ab7c' },
          { from: 1.6, to: 2.4, color: '#c98a3d' }
        ],
        scaleLeft: 'Muggy', scaleRight: 'Dry',
        markerColor: vpdColor
      });
      const humGauge = gaugeBarHtml({
        label: 'Humidity Today',
        valueText: `${formatVal(data.humidity, 0)}%`,
        value: data.humidity, min: 0, max: 100,
        zones: [{ from: 0, to: 100, color: '#3d6b8f' }],
        scaleLeft: `Low ${formatVal(hExt.min.val, 0)}%`,
        scaleRight: `High ${formatVal(hExt.max.val, 0)}%`
      });
      panel.innerHTML = `
        <div class="detail-panel">
          ${vpdGauge}
          <div class="stat-chip-row">
            ${statChip('Heat Index', data.heatIndex != null ? formatVal(data.heatIndex, 1) + '°F' : '--')}
            ${statChip('Wind Chill', data.windChill != null ? formatVal(data.windChill, 1) + '°F' : '--')}
            ${statChip('Dew Pt. Depr.', (data.temp != null && data.dewpt != null) ? formatVal(data.temp - data.dewpt, 1) + '°F' : '--')}
          </div>
          ${humGauge}
          <div class="extra-data-note">VPD below ~0.4 kPa tends to feel muggy/stagnant; above ~1.6 kPa the air is pulling moisture quickly and feels drier.</div>
        </div>`;
    });


  
    // horizontal range gauge
    function gaugeBarHtml({ label, valueText, value, min, max, zones, scaleLeft, scaleRight, markerColor }) {
      const pct = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
      const stops = zones.map(z => `${z.color} ${pct(z.from)}%, ${z.color} ${pct(z.to)}%`).join(', ');
      const markerPct = (value === undefined || value === null || isNaN(value)) ? null : pct(value);
      return `
        <div class="gauge-bar">
          <div class="gauge-bar-head">
            <span class="gauge-bar-label">${label}</span>
            <span class="gauge-bar-value"${markerColor ? ` style="color:${markerColor};"` : ''}>${valueText}</span>
          </div>
          <div class="gauge-bar-track" style="background: linear-gradient(90deg, ${stops});">
            ${markerPct !== null ? `<div class="gauge-bar-marker" style="left:${markerPct}%;"></div>` : ''}
          </div>
          ${(scaleLeft || scaleRight) ? `<div class="gauge-bar-scale"><span>${scaleLeft || ''}</span><span>${scaleRight || ''}</span></div>` : ''}
        </div>`;
    }

    // one row of a small comparison bar chart
    function barCompareRow(label, value, maxValue, unit, color, dec = 2) {
      const v = (value === undefined || value === null || isNaN(value)) ? 0 : value;
      const pct = maxValue > 0 ? Math.max(3, Math.min(100, (v / maxValue) * 100)) : 3;
      return `
        <div class="bar-compare-row">
          <span class="bar-compare-label">${label}</span>
          <div class="bar-compare-track"><div class="bar-compare-fill" style="width:${pct}%; background:${color};"></div></div>
          <span class="bar-compare-value">${formatVal(value, dec)} ${unit}</span>
        </div>`;
    }

    // a single reference stat as a small bordered chip
    function statChip(label, value, dotColor) {
      return `
        <div class="stat-chip">
          ${dotColor ? `<span class="stat-chip-dot" style="background:${dotColor};"></span>` : ''}
          <span class="stat-chip-text"><span class="stat-chip-label">${label}</span><span class="stat-chip-value">${value}</span></span>
        </div>`;
    }

    function detailPanelHtml(groups, note = '') {
      const groupsHtml = groups.map(group => `
        <details class="detail-section" open>
          <summary>${group.title}</summary>
          <div class="detail-section-body">
            <div class="extra-data-list">
              ${group.rows.join('')}
            </div>
          </div>
        </details>
      `).join('');
      return `
        <div class="detail-panel">
          ${groupsHtml}
          ${note ? `<div class="extra-data-note">${note}</div>` : ''}
        </div>
      `;
    }

  // 2. wind card
    const wsExt = extSafe('windSpeed');
    const wgExt = extSafe('windGust');
    const windCard = document.createElement('div');
    windCard.className = 'card combo-card wind-card';
    windCard.innerHTML = `
      <div class="priority-card-head">
        <div class="priority-icon"><img src="icons/windmill.svg" alt=""></div>
        <div class="priority-heading">Wind</div>
      </div>
      <div class="wind-priority-row">
        <div class="wind-priority-metric">
          <div class="value priority-value">${formatVal(data.windSpeed, 1)}<span class="unit">mph</span></div>
          <span class="wind-metric-label">Sustained</span>
          <div class="wind-metric-peak"><span class="wind-metric-peak-label">Peak</span><span class="wind-metric-peak-value">${formatVal(wsExt.max.val, 1)}<span class="unit">mph</span></span></div>
        </div>
        <div class="wind-priority-metric">
          <div class="value priority-value">${formatVal(data.windGust, 1)}<span class="unit">mph</span></div>
          <span class="wind-metric-label">Gust</span>
          <div class="wind-metric-peak"><span class="wind-metric-peak-label">Peak</span><span class="wind-metric-peak-value">${formatVal(wgExt.max.val, 1)}<span class="unit">mph</span></span></div>
        </div>
      </div>
      <div class="priority-context">${degreesToCardinal16(data.winddir || 0)} · ${getBeaufortLabel(data.windSpeed)}</div>
    `;
    gridRight.appendChild(windCard);
    makeCardExpandable(windCard, 'wind', 'more wind data', (panel) => {
      const gustFactor = (data.windSpeed && data.windGust) ? (data.windGust / Math.max(data.windSpeed, 0.1)) : null;
      const gustGauge = gaugeBarHtml({
        label: 'Gust Factor',
        valueText: gustFactor ? `${gustFactor.toFixed(2)}×` : '--',
        value: gustFactor, min: 1, max: 2.2,
        zones: [
          { from: 1, to: 1.3, color: '#54ab7c' },
          { from: 1.3, to: 1.6, color: '#d9c34a' },
          { from: 1.6, to: 2.0, color: '#e2913f' },
          { from: 2.0, to: 2.2, color: '#e2593f' }
        ],
        scaleLeft: 'Steady', scaleRight: 'Extreme'
      });
      panel.innerHTML = `
        <div class="detail-panel">
          <div class="wind-back-layout">
            <div class="wind-back-compass">${buildWindCompassHtml(false, data.winddir || 0)}</div>
          </div>
          ${gustGauge}
          <div class="extra-data-note">A gust factor above ~1.5× indicates increasingly gusty flow; elevated ratios during storms can be a useful downburst clue.</div>
        </div>`;
    });



    // 3. pressure/cape card -- relative (elevation-corrected) pressure only
    const pExt = extSafe('pressure');
    const pTrend = getPressureTrend(fullHistory, 'pressure');

    const primaryTrend = pTrend;
    const trendRateHtml = (primaryTrend && primaryTrend.deltaPerHour !== undefined)
      ? `${primaryTrend.deltaPerHour >= 0 ? '+' : ''}${primaryTrend.deltaPerHour.toFixed(3)} inHg/hr`
      : 'trend building…';

    function getPressureLevelNote(val) {
      if (val === undefined || val === null || isNaN(val)) return null;
      if (val >= 30.20) return 'High';
      if (val >= 29.80) return 'Normal range';
      return 'Low';
    }
    const pLevel = getPressureLevelNote(data.pressure);

    const pressureCard = document.createElement('div');
    pressureCard.className = 'card combo-card pressure-card';
    const capeTrend = getCapeTrend(capeHistory);
    const sparklineHtml = buildPressureCapeSparkline(fullHistory, capeHistory);
    pressureCard.innerHTML = `
      <div class="priority-card-head">
        <div class="priority-icon"><img src="icons/barometer.svg" alt=""></div>
        <div class="priority-heading">STORM POTENTIAL</div>
      </div>
      <div class="glance-row priority-glance-row pressure-glance-row">
         <div class="glance-col glance-primary">
            <div class="label">Pressure</div>
            <div class="value priority-value">${formatVal(data.pressure, 2)}<span class="unit">inHg</span>${primaryTrend ? `<span class="pressure-trend ${primaryTrend.className}">${primaryTrend.arrow}</span>` : ''}</div>
         </div>
         <div class="glance-col">
            <div class="label">CAPE</div>
            <div class="value priority-value">${data.cape != null ? formatVal(data.cape, 0) : '--'}<span class="unit">J/kg</span>${capeTrend ? `<span class="pressure-trend ${capeTrend.className}">${capeTrend.arrow}</span>` : ''}</div>
         </div>
      </div>
      ${sparklineHtml ? `<div class="pressure-cape-spark">${sparklineHtml}</div>` : ''}
      <div class="storm-note compact-storm-note">${getStormPotentialNote(primaryTrend, trendRateHtml, data.cape)}</div>
    `;
    gridLeft.appendChild(pressureCard);
    makeCardExpandable(pressureCard, 'pressure', 'more pressure data', (panel) => {
      const pressGauge = gaugeBarHtml({
        label: 'Barometer',
        valueText: `${formatVal(data.pressure, 2)} inHg${pLevel ? ' · ' + pLevel : ''}`,
        value: data.pressure, min: 29.5, max: 30.5,
        zones: [
          { from: 29.5, to: 29.8, color: '#e2593f' },
          { from: 29.8, to: 30.0, color: '#d9c34a' },
          { from: 30.0, to: 30.2, color: '#54ab7c' },
          { from: 30.2, to: 30.5, color: '#5b8fd9' }
        ],
        scaleLeft: 'Low', scaleRight: 'High'
      });
      const capeVal = data.cape;
      const capeColor = (capeVal == null) ? 'var(--muted-color)'
        : capeVal < 100 ? 'var(--muted-color)'
        : capeVal < 1000 ? '#54ab7c'
        : capeVal < 2500 ? '#d9c34a'
        : capeVal < 4000 ? '#e2913f' : '#e2593f';
      const capeGauge = gaugeBarHtml({
        label: 'CAPE (Instability)',
        valueText: `${capeVal != null ? formatVal(capeVal, 0) + ' J/kg' : '--'}`,
        value: capeVal, min: 0, max: 4200,
        zones: [
          { from: 0, to: 100, color: 'rgba(255,255,255,0.12)' },
          { from: 100, to: 1000, color: '#54ab7c' },
          { from: 1000, to: 2500, color: '#d9c34a' },
          { from: 2500, to: 4000, color: '#e2913f' },
          { from: 4000, to: 4200, color: '#e2593f' }
        ],
        scaleLeft: 'Stable', scaleRight: 'Extreme',
        markerColor: capeColor
      });
      panel.innerHTML = `
        <div class="detail-panel">
          ${pressGauge}
          <div class="stat-chip-row">
            ${statChip('High', `${formatVal(pExt.max.val, 2)}`)}
            ${statChip('Low', `${formatVal(pExt.min.val, 2)}`)}
            ${statChip('Δ3h', pTrend && pTrend.delta !== undefined ? (pTrend.delta >= 0 ? '+' : '') + pTrend.delta.toFixed(3) : '--')}
          </div>
          ${capeGauge}
          <div class="extra-data-note">CAPE is modeled (HRRR, hourly), not sensor-measured — it's storm fuel available, not a forecast that one will occur.</div>
        </div>`;
    });


    // 4. precipitation card
    const prExt = extSafe('precipRate');
    const isCurrentlyRaining = data.precipRate !== undefined && data.precipRate !== null && data.precipRate > 0;
    const likelyFrozen = data.temp !== null && data.temp !== undefined && data.temp <= 34;
    const precipCard = document.createElement('div');
    precipCard.className = 'card combo-card precip-card';
    const precipLabelHtml = `<div class="label" style="margin-bottom: 10px;"><span class="card-icon"><img src="icons/raindrop-measure.svg" alt=""></span>Precipitation</div>`;
    if (isCurrentlyRaining) {
      precipCard.innerHTML = `
        ${precipLabelHtml}
        <div class="priority-single-value">
          <div class="value priority-value">${formatVal(data.precipRate, 2)}<span class="unit">in/hr</span></div>
          <span class="glance-sub">current rate</span>
        </div>
        <div class="priority-context">${formatVal(data.precipTotal, 2)} in today · peak ${formatVal(prExt.max.val, 2)} in/hr${likelyFrozen ? ' · likely frozen/mixed' : ''}</div>
      `;
    } else {
      precipCard.innerHTML = `
        ${precipLabelHtml}
        <div class="priority-single-value">
          <div class="value priority-value">${formatVal(data.precipTotal, 2)}<span class="unit">in</span></div>
          <span class="glance-sub">today</span>
        </div>
        <div class="priority-context">peak ${formatVal(prExt.max.val, 2)} in/hr today${likelyFrozen ? ' · likely frozen/mixed' : ''}</div>
      `;
    }
    gridRight.appendChild(precipCard);
    makeCardExpandable(precipCard, 'precip', 'more precipitation data', (panel) => {
      const totals = [
        { label: 'Today', val: data.precipTotal },
        { label: 'Week', val: data.precipTotalWeek },
        { label: 'Month', val: data.precipTotalMonth },
        { label: 'Year', val: data.precipTotalYear }
      ];
      const maxTotal = Math.max(...totals.map(t => (typeof t.val === 'number' ? t.val : 0)), 0.01);
      const hourPop = currentForecastHourly && currentForecastHourly[0] && currentForecastHourly[0].probabilityOfPrecipitation != null
        ? `${currentForecastHourly[0].probabilityOfPrecipitation}%`
        : '--';
      panel.innerHTML = `
        <div class="detail-panel">
          <div class="bar-compare-list">
            ${totals.map(t => barCompareRow(t.label, t.val, maxTotal, 'in', '#5b9fd9')).join('')}
          </div>
          <div class="stat-chip-row">
            ${statChip('Current Rate', data.precipRate != null ? formatVal(data.precipRate, 2) + ' in/hr' : '--')}
            ${statChip('Peak Rate Today', `${formatVal(prExt.max.val, 2)} in/hr`)}
            ${statChip('Rain Chance (this hr)', hourPop, '#5b9fd9')}
          </div>
          ${likelyFrozen ? `<div class="extra-data-note">Temps at/below ~34°F — today's precipitation may be frozen or mixed.</div>` : ''}
        </div>`;
    });

    // 4.5 lightning card 
    // the live maps are created when the card is expanded
    const lightningHasData = data.lightningStrikeCount !== undefined && data.lightningStrikeCount !== null;
    const lastStrikeMs = data.lightningLastStrike ? new Date(data.lightningLastStrike).getTime() : null;
    const lightningCard = document.createElement('div');
    lightningCard.className = 'card combo-card lightning-card';
    lightningCard.innerHTML = `
      <div class="priority-card-head">
        <div class="priority-icon"><img src="icons/lightning-bolt.svg" alt=""></div>
        <div class="priority-heading">Lightning</div>
      </div>
      <div class="lightning-priority-row">
        <div class="priority-single-value">
          <div class="value priority-value">${formatVal(data.lightningStrikeCount, 0)}</div>
          <span class="glance-sub">strikes today</span>
        </div>
        <div class="priority-single-value">
          <div class="value priority-value">${data.lightningDistance != null ? formatVal(data.lightningDistance, 1) : '--'}<span class="unit">mi</span></div>
          <span class="glance-sub">nearest</span>
        </div>
      </div>
      <div class="priority-context">${lastStrikeMs ? `last strike ${formatShortTime(data.lightningLastStrike)}` : (lightningHasData ? 'no recent strike detected' : 'sensor data unavailable')}</div>
    `;
    gridLeft.appendChild(lightningCard);
    lightningCard.classList.add('lightning-map-trigger');
    lightningCard.setAttribute('tabindex', '0');
    lightningCard.setAttribute('role', 'button');
    lightningCard.setAttribute('aria-expanded', 'false');

    const attachLightningMapListeners = () => {
      lightningCard.querySelector('.lightning-map-close')?.addEventListener('click', (e) => { e.stopPropagation(); toggleLightningMap(false); });
      lightningCard.querySelector('.lightning-map-backdrop')?.addEventListener('click', (e) => { e.stopPropagation(); toggleLightningMap(false); });
    };

    const toggleLightningMap = (open) => {
      const current = lightningCard.querySelector('.lightning-map-panel');
      if (open) {
        closeOpenSensorCards();
        if (!current) {
          lightningCard.insertAdjacentHTML('beforeend', `
            <div class="lightning-map-backdrop"></div>
            <div class="lightning-map-panel">
              <div class="lightning-map-tabs">
                <button type="button" class="lightning-map-tab active" data-target="lightning-map-panel-glm">Our Data (GLM)</button>
                <button type="button" class="lightning-map-tab" data-target="lightning-map-panel-bo">Blitzortung</button>
              </div>
              <div class="lightning-map-views">
                <div class="lightning-map-view active" id="lightning-map-panel-glm">
                  <div class="lightning-glm-map" id="lightning-glm-map"></div>
                  <div class="lightning-map-caption" id="lightning-glm-caption">Loading recent flashes…</div>
                </div>
                <div class="lightning-map-view" id="lightning-map-panel-bo">
                  <iframe class="lightning-map-frame" data-src="https://map.blitzortung.org/#3.7/40.616/-80.274" title="Live lightning map" loading="lazy" frameborder="0" scrolling="no" allowtransparency="true" sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe>
                  <div class="lightning-map-caption">Live lightning activity · Blitzortung.org</div>
                </div>
              </div>
              <button type="button" class="lightning-map-close">close map ×</button>
            </div>`);
          attachLightningMapListeners();
          initLightningMapTabs(lightningCard);
        }
      
        lightningCard.classList.add('lightning-map-open');
        lightningCard.setAttribute('aria-expanded', 'true');
        setTimeout(() => lightningGlmMap && lightningGlmMap.invalidateSize(), 50);
      } else {
        lightningCard.classList.remove('lightning-map-open');
        lightningCard.setAttribute('aria-expanded', 'false');
      }
    };

    if (preservedLightningPanel) {
      if (preservedLightningBackdrop) lightningCard.appendChild(preservedLightningBackdrop);
      lightningCard.appendChild(preservedLightningPanel);
      attachLightningMapListeners();
      initLightningMapTabs(lightningCard);
      setTimeout(() => lightningGlmMap && lightningGlmMap.invalidateSize(), 50);
      lightningCard.classList.add('lightning-map-open');
      lightningCard.setAttribute('aria-expanded', 'true');
    }

    lightningCard.addEventListener('click', (e) => {
      if (e.target.closest('button, a, iframe')) return;
      toggleLightningMap(!lightningCard.classList.contains('lightning-map-open'));
    });
    lightningCard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLightningMap(!lightningCard.classList.contains('lightning-map-open')); }
      if (e.key === 'Escape') toggleLightningMap(false);
    });

    // 5. solar & UV card
    const sExt = extSafe('solarRadiation');
    const uExt = extSafe('uv');
    const uvCat = getUvRiskCategory(data.uv);
    const solarUvCard = document.createElement('div');
    solarUvCard.className = 'card combo-card solar-card';
    solarUvCard.innerHTML = `
      <div class="priority-card-head">
        <div class="priority-icon"><img src="icons/solarrad.svg" alt=""></div>
        <div class="priority-heading">Solar &amp; UV</div>
      </div>
      <div class="combo-row priority-dual-row">
        <div class="combo-col">
          <div class="value priority-value">${formatVal(data.solarRadiation, 0)}<span class="unit">W/m²</span></div>
          <span class="glance-sub">solar</span>
        </div>
        <div class="combo-col">
          <div class="value priority-value">${formatVal(data.uv, 1)}</div>
          <span class="glance-sub">UV index</span>
        </div>
      </div>
      <div class="priority-context">Risk <span style="color: ${uvCat.color};">${uvCat.label}</span></div>
    `;
    gridRight.appendChild(solarUvCard);
    makeCardExpandable(solarUvCard, 'solarUv', 'more solar & UV data', (panel) => {
      const uvGauge = gaugeBarHtml({
        label: 'UV Index',
        valueText: `${formatVal(data.uv, 1)} · ${uvCat.label}`,
        value: data.uv, min: 0, max: 12,
        zones: [
          { from: 0, to: 3, color: '#8fd6a8' },
          { from: 3, to: 6, color: '#ffe27a' },
          { from: 6, to: 8, color: '#ffb347' },
          { from: 8, to: 11, color: '#ff7e67' },
          { from: 11, to: 12, color: '#c792ff' }
        ],
        scaleLeft: 'Low', scaleRight: 'Extreme',
        markerColor: uvCat.color
      });
      panel.innerHTML = `
        <div class="detail-panel">
          ${uvGauge}
          <div class="stat-chip-row">
            ${statChip('Peak UV Today', `${formatVal(uExt.max.val, 1)} · ${formatShortTime(uExt.max.time)}`)}
            ${statChip('Peak Radiation', `${formatVal(sExt.max.val, 0)} W/m² · ${formatShortTime(sExt.max.time)}`)}
          </div>
        </div>`;
    });

    // 6. AQI card
    if (data.aqiDisplay) {
        const aqiColor = getAqiColor(data.aqi);
        const styledAqi = data.aqiDisplay.replace(/(\([^)]*\))/, '<span class="aqi-category" style="font-size:0.44em; display:block; margin-top:5px;">$1</span>');
        const aqiDesc = getAqiDescription(data.aqi);
        const aqiCard = document.createElement('div');
        aqiCard.className = 'card combo-card aqi-card';
        aqiCard.innerHTML = `
          <div class="priority-card-head">
            <div class="priority-icon"><img src="icons/air-quality.svg" alt="" onerror="this.parentElement.style.display='none'"></div>
            <div class="priority-heading">Air Quality</div>
          </div>
          <div class="priority-single-value">
            <div class="value priority-value" style="color: ${aqiColor || 'inherit'};">${styledAqi}</div>
            <div class="aqi-summary">${aqiDesc}</div>
          </div>
        `;
        gridLeft.appendChild(aqiCard);
        makeCardExpandable(aqiCard, 'aqi', 'more air quality data', (panel) => {
          const aqiScaleRows = [
            ['0–50', 'Good', '#54ab7c'],
            ['51–100', 'Moderate', '#c9a800'],
            ['101–150', 'Unhealthy (Sensitive)', '#ff7e00'],
            ['151–200', 'Unhealthy', '#ff4136'],
            ['201–300', 'Very Unhealthy', '#8f3f97'],
            ['301+', 'Hazardous', '#7e0023'],
          ];
          const aqiGauge = gaugeBarHtml({
            label: 'Air Quality Index',
            valueText: data.aqiDisplay,
            value: data.aqi, min: 0, max: 310,
            zones: [
              { from: 0, to: 50, color: '#54ab7c' },
              { from: 50, to: 100, color: '#c9a800' },
              { from: 100, to: 150, color: '#ff7e00' },
              { from: 150, to: 200, color: '#ff4136' },
              { from: 200, to: 300, color: '#8f3f97' },
              { from: 300, to: 310, color: '#7e0023' }
            ],
            scaleLeft: 'Good', scaleRight: 'Hazardous',
            markerColor: aqiColor
          });
          const pmVals = [
            { label: 'PM1.0', val: data.pm1 },
            { label: 'PM2.5', val: data.pm25 },
            { label: 'PM10.0', val: data.pm10 }
          ];
          const pmMax = Math.max(...pmVals.map(p => (typeof p.val === 'number' ? p.val : 0)), 1);
          const aqiLegendHtml = `<div class="aqi-scale-compact aqi-scale-legend">${
            aqiScaleRows.map(([range, label, color]) => `
              <span class="aqi-legend-chip"><span class="aqi-scale-dot" style="background:${color};"></span>${label}</span>
            `).join('')
          }</div>`;
          panel.innerHTML = `
            <div class="detail-panel">
              ${aqiGauge}
              <div class="bar-compare-list">
                ${pmVals.map(p => barCompareRow(p.label, p.val, pmMax, 'µg/m³', aqiColor || '#8fa6bf', 1)).join('')}
              </div>
              ${aqiLegendHtml}
              <div class="extra-data-note">AQI here is calculated from PM2.5 only — PM1.0/PM10.0 shown for reference.</div>
            </div>`;
        });
    }

        // 7. USGS river gauge
    if (currentUsgs) {
       const usgsCard = document.createElement('div');
       usgsCard.className = 'card combo-card river-card';
       usgsCard.title = `${currentUsgs.siteName} — USGS ${USGS_SITE_ID}`;
       const rTrendHtml = currentUsgs.trend ? `<span class="pressure-trend ${currentUsgs.trend.className}" title="${currentUsgs.trend.label} over 3h">${currentUsgs.trend.arrow}</span>` : '';
       
       const riverMax = getTodayMaxRiver(usgsHistory) || cachedRiverMax;
       const peakStageText = riverMax ? `${riverMax.val.toFixed(2)} ft` : '--';
       const cfsText = currentUsgs.dischargeCfs != null ? `${currentUsgs.dischargeCfs.toLocaleString()} cfs` : '-- cfs';

       usgsCard.innerHTML = `
          <div class="priority-card-head">
            <div class="priority-icon"><img src="icons/water-alert.svg" alt="" onerror="this.parentElement.style.display='none'"></div>
            <div class="priority-heading">River Gauge</div>
          </div>
          <div class="pressure-priority-row">
            <div class="value priority-value">${currentUsgs.gageHeight.toFixed(2)}<span class="unit">ft</span></div>
            ${rTrendHtml}
          </div>
          <div class="priority-context">Dashields · ${currentUsgs.trend ? currentUsgs.trend.label : 'trend unavailable'}</div>
          <div class="priority-context">peak ${peakStageText} · ${cfsText}</div>
       `;
       gridRight.appendChild(usgsCard);
       makeCardExpandable(usgsCard, 'river', 'more river gauge data', (panel) => {
         const stageNote = getDashieldsStageNote(currentUsgs.gageHeight);
         const gh = currentUsgs.gageHeight;
         const gaugeMax = DASHIELDS_STAGES[DASHIELDS_STAGES.length - 1].ft + 4;
         const zones = [{ from: 0, to: DASHIELDS_STAGES[0].ft, color: '#3d6b8f' }];
         DASHIELDS_STAGES.forEach((s, i) => {
           const next = DASHIELDS_STAGES[i + 1] ? DASHIELDS_STAGES[i + 1].ft : gaugeMax;
           zones.push({ from: s.ft, to: next, color: s.color });
         });
         const riverGauge = gaugeBarHtml({
           label: 'Gage Height vs. Flood Stages',
           valueText: `${gh.toFixed(2)} ft`,
           value: gh, min: 0, max: gaugeMax,
           zones,
           scaleLeft: '0 ft', scaleRight: `${gaugeMax.toFixed(0)} ft`,
           markerColor: stageNote ? stageNote.color : undefined
         });
         panel.innerHTML = `
           <div class="detail-panel">
             ${riverGauge}
             <div class="stat-chip-row">
               ${DASHIELDS_STAGES.map(s => statChip(s.label, `${s.ft.toFixed(1)} ft`, s.color)).join('')}
             </div>
             ${stageNote ? `<div class="extra-data-note">Current: ${gh.toFixed(2)} ft — <span style="color:${stageNote.color};">${stageNote.text}</span></div>` : ''}
           </div>`;
       });
    }

    // protect camera from grid reload 
    if (desktopCameraTile && window.matchMedia('(min-width: 851px)').matches) {
      desktopCameraTile.classList.add('desktop-camera-tile');
      grid.appendChild(desktopCameraTile);
    }
  }

  //*  ------------ 🌪️ NWS / SPC ISSUANCES (watches, mesoscale discussions, statements) 🌪️ ----------- *//
  //
  let nwsProducts = { watches: [], mesoscaleDiscussions: [], statements: [] };
  // tracks the previous render's tornado-watch state so to avoid repeat switching
  let nwsPrevHasTornadoWatch = false;

  // the raw point-alert feed (data/alerts.json)
  let currentPointAlerts = [];
  // only auto-switch Storm Center to the closest/most-severe item once per load
  let primaryAlertAutoSelected = false;

  // maps a product's hazard type to a meteocon + a left-border color class
  function escapeNwsHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  function nwsRemainingInfo(issuedIso, expiresIso) {
    if (!expiresIso) return null;
    const now = Date.now();
    const expires = new Date(expiresIso).getTime();
    if (!Number.isFinite(expires)) return null;
    const msLeft = expires - now;
    if (msLeft <= 0) return { text: 'Expired', pct: 100, urgency: 'urgent' };
    const minsLeft = Math.round(msLeft / 60000);
    const text = minsLeft < 60 ? `${minsLeft}m left` : `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left`;
    let pct = 0;
    const issued = issuedIso ? new Date(issuedIso).getTime() : NaN;
    if (Number.isFinite(issued) && expires > issued) {
      pct = Math.min(100, Math.max(0, ((now - issued) / (expires - issued)) * 100));
    }
    const urgency = minsLeft <= 20 ? 'urgent' : (minsLeft <= 60 ? 'soon' : '');
    return { text, pct, urgency };
  }

  function nwsAgeLabel(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function getNwsHazardVisual(typeText) {
    const t = (typeText || '').toLowerCase();
    if (t.includes('tornado')) return { icon: 'tornado-alert.svg', badge: 'nws-badge-tor' };
    if (t.includes('severe') || t.includes('thunderstorm')) return { icon: 'thunderstorms.svg', badge: 'nws-badge-severe' };
    if (t.includes('flood') || t.includes('flash flood')) return { icon: 'water-alert.svg', badge: 'nws-badge-flood' };
    if (t.includes('winter') || t.includes('snow') || t.includes('ice')) return { icon: 'snow.svg', badge: 'nws-badge-winter' };
    if (t.includes('wind')) return { icon: 'wind.svg', badge: 'nws-badge-other' };
    return { icon: 'code-yellow.svg', badge: 'nws-badge-other' };
  }

  function cleanNwsDetailText(text) {
    const lines = String(text || '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean);

    const boilerplate = /^(?:weather service|national weather service|spc mesoscale discussion|storm prediction center|home|products|mesoscale discussions|storm prediction center norman ok|open official product)/i;
    const seen = new Set();
    const useful = [];

    for (const line of lines) {
      if (boilerplate.test(line)) continue;
      const normalized = line.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      useful.push(line);
    }

    return useful.join('\n').replace(/\n{2,}/g, '\n').trim();
  }

  function getNwsDetails(item) {
    if (Array.isArray(item.details) && item.details.length) {
      const seen = new Set();
      return item.details
        .filter(d => d && d.text)
        .map(d => ({ label: d.label || 'Detail', text: cleanNwsDetailText(d.text) }))
        .filter(d => {
          const key = d.text.toLowerCase().replace(/\s+/g, ' ').trim();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }
    // older feeds sometimes expose one large fullText field. split into
    // readable blocks, remove repeated page chrome, and cap each block
    const raw = cleanNwsDetailText(item.fullText || '');
    if (!raw) return [];
    const chunks = raw.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    const seen = new Set();
    return chunks.filter(text => {
      const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4).map((text, i) => ({
      label: i === 0 ? 'Product detail' : 'Additional detail',
      text: text.slice(0, 1800)
    }));
  }

  function buildNwsItemHtml(item, typeLabel, isPrimary) {
    const visual = getNwsHazardVisual(item.type || typeLabel);
    const issuedStr = item.issued ? formatShortTime(item.issued) : '';
    const expiresStr = item.expires ? formatShortTime(item.expires) : '';
    const location = item.location || item.areas || item.areaDesc || '';
    const hazard = item.hazard || item.concerning || item.event || item.product || item.type || typeLabel || '';
    const hasDistance = Number.isFinite(Number(item.distanceMiles));
    const distance = hasDistance ? `≈ ${Number(item.distanceMiles).toFixed(0)} mi` : '';
    const age = escapeNwsHtml(nwsAgeLabel(item.issued));
    const probBadge = item.watchProbability ? escapeNwsHtml(item.watchProbability) : '';
    const titleBase = item.type || typeLabel || 'Weather product';
    const title = `${escapeNwsHtml(titleBase)}${item.number ? ` #${escapeNwsHtml(item.number)}` : ''}`;
    const remaining = nwsRemainingInfo(item.issued, item.expires);
    const metaParts = [];
    if (distance) metaParts.push(`<span class="nws-meta-item">${escapeNwsHtml(distance)} away</span>`);
    if (issuedStr) metaParts.push(`<span class="nws-meta-item">Issued <strong>${escapeNwsHtml(issuedStr)}</strong></span>`);
    if (expiresStr) {
      const remainingChip = remaining ? ` <span class="nws-meta-remaining ${remaining.urgency}">(<strong>${escapeNwsHtml(remaining.text)}</strong>)</span>` : '';
      metaParts.push(`<span class="nws-meta-item">Until <strong>${escapeNwsHtml(expiresStr)}</strong>${remainingChip}</span>`);
    }
    const metaHtml = metaParts.join('<span class="nws-meta-dot">•</span>');
    const timeBarHtml = (remaining && Number.isFinite(remaining.pct))
      ? `<div class="nws-time-bar"><div class="nws-time-bar-fill" style="width:${remaining.pct.toFixed(1)}%"></div></div>`
      : '';

    const details = getNwsDetails(item);
    const detailsHtml = details.map(d => `
      <div class="nws-detail-block">
        <div class="nws-detail-label">${escapeNwsHtml(d.label)}</div>
        <div class="nws-detail-text">${escapeNwsHtml(d.text)}</div>
      </div>
    `).join('');

    return `
      <div class="nws-item ${visual.badge}${isPrimary ? ' primary-alert' : ''}" data-id="${escapeNwsHtml(item.id || '')}">
        <div class="nws-item-header">
          <span class="nws-item-icon"><img src="icons/${visual.icon}" alt="" onerror="this.parentElement.style.display='none'"></span>
          <div class="nws-item-body">
            <div class="nws-item-title-row">
              <div class="nws-item-title">${title}</div>
              <div class="nws-item-title-tags">
                ${isPrimary ? `<span class="nws-primary-chip">Closest active</span>` : ''}
                ${probBadge ? `<span class="nws-prob-badge" title="SPC probability of watch issuance">${probBadge} watch prob</span>` : ''}
                ${age ? `<div class="nws-item-age">${age}</div>` : ''}
              </div>
            </div>

            <div class="nws-headline">
              <div class="nws-headline-label">Hazard</div>
              <div class="nws-headline-value">${escapeNwsHtml(hazard || 'Hazard not available')}</div>
            </div>

            ${metaHtml ? `<div class="nws-meta-strip">${metaHtml}</div>` : ''}
            ${timeBarHtml}

            <div class="nws-location">
              <div class="nws-location-label">Location</div>
              <div class="nws-location-text">${escapeNwsHtml(location || 'Location not available')}</div>
            </div>

            ${detailsHtml ? `<div class="nws-item-hint">view discussion</div><div class="nws-item-details">${detailsHtml}</div>` : ''}
            ${item.url ? `<a class="nws-item-link" href="${escapeNwsHtml(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation();">Open official product ↗</a>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  function isNwsItemLive(item, kind) {
    const now = Date.now();
    const issued = item.issued ? new Date(item.issued).getTime() : 0;
    const expires = item.expires ? new Date(item.expires).getTime() : 0;
    if (kind === 'watch') return !expires || expires >= now;
    if (kind === 'md') return (expires && expires >= now) || (issued && now - issued <= 8 * 3600000);
    return issued ? now - issued <= 18 * 3600000 : true;
  }

  function renderNwsList(containerId, items, emptyText, typeLabel, kind, primary) {
    const container = document.getElementById(containerId);
    const liveItems = (items || []).filter(item => isNwsItemLive(item, kind));
    if (!liveItems.length) {
      container.innerHTML = `<div class="nws-empty">${escapeNwsHtml(emptyText)}</div>`;
      return liveItems;
    }
    const sortedItems = [...liveItems].sort((a, b) => new Date(b.issued || 0) - new Date(a.issued || 0));
    container.innerHTML = sortedItems.map(item => buildNwsItemHtml(item, typeLabel, primary && item.id === primary.id)).join('');
    container.querySelectorAll('.nws-item').forEach(el => {
      el.addEventListener('click', (event) => {
        if (event.target.closest('a')) return;
        if (!el.querySelector('.nws-item-details')) return;
        el.classList.toggle('expanded');
      });
    });
    return sortedItems;
  }

  // data/alerts.json and nws_products.json's "watches" section both query
  // the same NWS point-alerts endpoint for the station's exact coordinates
  // -- so anything in either one is already guaranteed to cover the
  // station (that's what a point query means). Any item with "watch" in
  // its event name can legitimately show up in *both* feeds with the same
  // id; this adapts + dedupes them into one list for the Storm Center tab.
  const ALERT_KIND_RANK = { warning: 0, watch: 1, advisory: 2, statement: 3 };
  const ALERT_SEVERITY_RANK = { extreme: 0, severe: 1, moderate: 2, minor: 3, unknown: 4 };

  function getAlertKind(eventText) {
    const e = (eventText || '').toLowerCase();
    if (e.includes('warning')) return 'warning';
    if (e.includes('watch')) return 'watch';
    if (e.includes('advisory')) return 'advisory';
    return 'statement';
  }

  // reshapes a raw data/alerts.json entry into the same shape
  // buildNwsItemHtml() already knows how to render.
  function adaptPointAlert(alert) {
    return {
      id: alert.id,
      type: alert.event,
      issued: alert.effective,
      expires: alert.expires,
      location: alert.areaDesc || null,
      hazard: alert.headline || alert.event,
      distanceMiles: null, // point-queried -- always local to the station, not a "distance away"
      details: alert.details || [],
      url: alert.url || null,
      office: alert.senderName,
      _severity: alert.severity,
    };
  }

  function buildCombinedWatchesList() {
    const byId = new Map();
    (currentPointAlerts || []).forEach(a => { if (a && a.id) byId.set(a.id, adaptPointAlert(a)); });
    (nwsProducts.watches || []).forEach(w => { if (w && w.id && !byId.has(w.id)) byId.set(w.id, w); });
    const combined = [...byId.values()];
    combined.sort((a, b) => {
      const kindDiff = (ALERT_KIND_RANK[getAlertKind(a.type)] ?? 4) - (ALERT_KIND_RANK[getAlertKind(b.type)] ?? 4);
      if (kindDiff !== 0) return kindDiff;
      const sevDiff = (ALERT_SEVERITY_RANK[(a._severity || '').toLowerCase()] ?? 4) - (ALERT_SEVERITY_RANK[(b._severity || '').toLowerCase()] ?? 4);
      if (sevDiff !== 0) return sevDiff;
      return new Date(b.issued || 0) - new Date(a.issued || 0);
    });
    return combined;
  }

  // the single closest + most severe thing worth a user's attention right
  // now: a local warning/watch/advisory always wins (guaranteed to cover
  // the station), falling back to the nearest still-live Mesoscale
  // Discussion (which is NOT point-queried and can be states away) only
  // when there's no local alert at all.
  function computePrimaryAlert(watches, mds) {
    if (watches.length) return { id: watches[0].id, tab: 'nws-panel-watches' };
    const liveMds = (mds || []).filter(m => isNwsItemLive(m, 'md'));
    if (liveMds.length) {
      const closest = [...liveMds].sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity))[0];
      return { id: closest.id, tab: 'nws-panel-md' };
    }
    return null;
  }

  function renderNwsProducts() {
    const combinedWatches = buildCombinedWatchesList();
    const mdsRaw = nwsProducts.mesoscaleDiscussions || [];
    const primary = computePrimaryAlert(combinedWatches.filter(w => isNwsItemLive(w, 'watch')), mdsRaw);

    const watches = renderNwsList('nws-list-watches', combinedWatches, 'No active watches or warnings.', 'Watch', 'watch', primary);
    const mds = renderNwsList('nws-list-md', mdsRaw, 'No active or very recent mesoscale discussions.', 'Mesoscale Discussion', 'md', primary);
    const statements = renderNwsList('nws-list-statements', nwsProducts.statements || [], 'No recent NWS updates.', 'NWS Update', 'statement', primary);

    const countWatches = document.getElementById('nws-count-watches');
    const countMd = document.getElementById('nws-count-md');
    const countStatements = document.getElementById('nws-count-statements');
    if (countWatches) countWatches.textContent = watches.length;
    if (countMd) countMd.textContent = mds.length;
    if (countStatements) countStatements.textContent = statements.length;

    // local-area focus: with nothing active for the KPBZ forecast area
    // across any of the three feeds, the tabs/panels are just empty chrome
    // -- collapse the whole top section (and its divider) so the card
    // shows only the SPC Convective/Thunderstorm outlooks below.
    const hasStormTopContent = (watches.length + mds.length + statements.length) > 0;
    const stormTop = document.getElementById('storm-top');
    const stormDivider = document.getElementById('storm-desk-divider');
    if (stormTop) stormTop.classList.toggle('storm-top-hidden', !hasStormTopContent);
    if (stormDivider) stormDivider.classList.toggle('storm-top-hidden', !hasStormTopContent);

    // a tornado watch/warning deserves to be seen without opening a tab:
    // pulse the watches tab for as long as one is live, and jump to it
    // automatically the moment one appears (only on that transition -- see
    // nwsPrevHasTornadoWatch above -- so it doesn't fight the user later).
    const hasTornadoWatch = watches.some(w => (w.type || '').toLowerCase().includes('tornado'));
    const watchTab = document.querySelector('#nws-tabs .nws-tab[data-target="nws-panel-watches"]');
    if (watchTab) {
      watchTab.classList.toggle('urgent', hasTornadoWatch);
      if (hasTornadoWatch && !nwsPrevHasTornadoWatch && !watchTab.classList.contains('active')) {
        watchTab.click();
      }
    }
    nwsPrevHasTornadoWatch = hasTornadoWatch;

    // on first load only, make sure the closest + most severe item's own
    // tab is the one showing -- after that, leave tab navigation to the
    // user (matches the tornado-watch precedent above).
    if (primary && !primaryAlertAutoSelected) {
      const primaryTab = document.querySelector(`#nws-tabs .nws-tab[data-target="${primary.tab}"]`);
      if (primaryTab && !primaryTab.classList.contains('active')) primaryTab.click();
      primaryAlertAutoSelected = true;
    }

    const updated = document.getElementById('storm-desk-updated');
    const generated = nwsProducts.generatedAt ? formatShortTime(nwsProducts.generatedAt) : '';
    if (updated) updated.textContent = generated ? `updated ${generated}` : 'awaiting update';
  }

  function initNwsTabs() {
     const tabs = document.querySelectorAll('#nws-tabs .nws-tab');
     tabs.forEach(tab => {
       tab.addEventListener('click', () => {
         tabs.forEach(t => {
           t.classList.remove('active');
           t.setAttribute('aria-selected', 'false');
         });
         tab.classList.add('active');
         tab.setAttribute('aria-selected', 'true');
         document.querySelectorAll('.nws-panel').forEach(p => p.classList.remove('active'));
         document.getElementById(tab.dataset.target).classList.add('active');
       });
     });
   }

  // fetches the compact SPC/NWS product feed generated by GitHub Actions.
  async function loadNwsProducts() {
    try {
      const res = await fetch(`data/nws_products.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      nwsProducts = {
        generatedAt: json.generatedAt || null,
        watches: json.watches || [],
        mesoscaleDiscussions: json.mesoscaleDiscussions || [],
        statements: json.statements || [],
      };
      renderNwsProducts();
    } catch (err) {
      console.warn('SPC / NWS feed temporarily unavailable', err);
    }
  }

  // plain-text-registers without relying on hue, and
  // pairs with the structural filled-vs-outlined treatment in CSS so
  // warning vs watch/advisory/statement reads as two diff types of urgency
  const ALERT_KIND_LABELS = {
    warning:   'Warning \u2014 act now',
    watch:     'Watch \u2014 conditions possible',
    advisory:  'Advisory',
    statement: 'Statement',
  };

  // clicking an alert brings you to storm center
  function goToStormCenterAlert(alertId) {
    const stormCard = document.querySelector('.outlook-card');
    let targetEl = document.querySelector(`.nws-item[data-id="${CSS.escape(alertId)}"]`);
    let targetTab = null;
    if (targetEl) {
      const panel = targetEl.closest('.nws-panel');
      if (panel) targetTab = document.querySelector(`#nws-tabs .nws-tab[data-target="${panel.id}"]`);
    }
    if (targetTab && !targetTab.classList.contains('active')) targetTab.click();
    if (stormCard) stormCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (targetEl) {
      setTimeout(() => {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetEl.classList.remove('flash-once');
        void targetEl.offsetWidth; // restart the animation if it's already mid-flash
        targetEl.classList.add('flash-once');
        targetEl.addEventListener('animationend', () => targetEl.classList.remove('flash-once'), { once: true });
      }, targetTab ? 350 : 0);
    }
  }

  function renderAlertBanners(alerts) {
    const container = document.getElementById('alert-banners');
    container.innerHTML = '';
    (alerts || []).forEach(alert => {
      const kind = getAlertKind(alert.event);
      const visual = getNwsHazardVisual(alert.event);
      const banner = document.createElement('button');
      banner.type = 'button';
      banner.className = `alert-banner kind-${kind} ${visual.badge}`;
      banner.innerHTML = `
        <span class="alert-banner-icon"><img src="icons/${visual.icon}" alt="" onerror="this.style.display='none'"></span>
        <span class="alert-banner-body">
          <span class="alert-label">${escapeNwsHtml(ALERT_KIND_LABELS[kind] || kind)}</span>
          <span class="alert-event">${escapeNwsHtml(alert.event || 'Weather Alert')}</span>
          <span class="alert-headline">${escapeNwsHtml(alert.headline || '')}</span>
        </span>
      `;
      banner.addEventListener('click', () => goToStormCenterAlert(alert.id));
      container.appendChild(banner);
    });
  }

  async function loadData(forceRefresh = false) {
  try {
    const url = `${DATA_URL}?t=${Date.now()}`;
    const aqUrl = `data/air_quality.json?t=${Date.now()}`;
    const alertUrl = `data/alerts.json?t=${Date.now()}`;
    const auroraUrl = `data/aurora.json?t=${Date.now()}`;
    const capeUrl = `data/cape.json?t=${Date.now()}`;
    const wuUrl = `${WU_BACKUP_URL}?t=${Date.now()}`;

    const [res, aqRes, alertRes, auroraRes, capeRes, wuRes] = await Promise.all([
      fetch(url, { cache: 'no-store' }),
      fetch(aqUrl, { cache: 'no-store' }).catch(() => null),
      fetch(alertUrl, { cache: 'no-store' }).catch(() => null),
      fetch(auroraUrl, { cache: 'no-store' }).catch(() => null),
      fetch(capeUrl, { cache: 'no-store' }).catch(() => null),
      fetch(wuUrl, { cache: 'no-store' }).catch(() => null),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const primaryData = await res.json();

    let wuData = null;
    if (wuRes && wuRes.ok) {
      try { wuData = await wuRes.json(); } catch (e) { wuData = null; }
    }
    const { data, filledFields, usedWuWholesale } = mergeWithWuBackup(primaryData, wuData);
    if (usedWuWholesale) {
      console.warn('Primary (weewx) feed is stale — showing WU backup data instead.');
    } else if (filledFields.length) {
      console.info('Filled from WU backup:', filledFields.join(', '));
    }

    if (aqRes && aqRes.ok) {
      const aqData = await aqRes.json();
      // only pull in the specific AQI fields the UI actually uses, so inaccurate purpleair
      // sensor array values dont end up replacing the weather station's real data
      if (aqData.aqi !== undefined) data.aqi = aqData.aqi;
      if (aqData.aqiDisplay !== undefined) data.aqiDisplay = aqData.aqiDisplay;
      if (aqData.pm1 !== undefined) data.pm1 = aqData.pm1;
      if (aqData.pm25 !== undefined) data.pm25 = aqData.pm25;
      if (aqData.pm10 !== undefined) data.pm10 = aqData.pm10;
    }
    if (auroraRes && auroraRes.ok) {
      currentAurora = await auroraRes.json();
      updateSkyBadges();
    }
    if (capeRes && capeRes.ok) {
      try {
        const capeData = await capeRes.json();
        if (capeData.cape !== undefined) data.cape = capeData.cape;
      } catch (e) { /* leave data.cape unset -- card falls back to '--' */ }
    }
    let alerts = [];
    if (alertRes && alertRes.ok) {
      alerts = await alertRes.json();
    }
    
    renderAlertBanners(alerts);
    currentPointAlerts = alerts;
    renderNwsProducts(); // recompute the merged watches/warnings list. alerts.json refreshes on a different schedule than nws_products.json
    lastWeatherData = data;
    renderCards(data);
    const isNight = isNightTime(data);
    const alertOverride = getAlertOverride(alerts, isNight);
    const auroraOverride = alertOverride ? null : getAuroraOverride(isNight);
    const activeOverride = alertOverride || auroraOverride;
    const themeKey = activeOverride ? activeOverride.theme : classifyWeather(data);
    
    applyTheme(themeKey, data.aqi, activeOverride);
    setRadarBaseLayer(isNight);
    subtitle.textContent = `${STATION_CALLSIGN} — ${STATION_CITY}`;

    errorBanner.style.display = 'none';
    lastSuccessfulLoadTime = Date.now();
    updateStatusLine();

    try {
      localStorage.setItem('cloverWeatherDataCache', JSON.stringify({
        data,
        alerts,
        // renderCards() (above) already ran getExtremesSafe for every field
        // this tick, so cachedTodaysExtremes holds the merged/live-extended
        // peaks, persist that directly. recomputing from fullHistory here
        // would silently throw away any live-value extension and write a
        // weaker snapshot, which then gets replayed by hydrateFromCache()
        // on the next reload (like a backgrounded mobile tab getting
        // reclaimed and reloaded), undoing the accumulated peak.
        todaysExtremes: cachedTodaysExtremes,
        usgs: currentUsgs,
        riverMax: getTodayMaxRiver(usgsHistory),
        savedAt: Date.now(),
      }));
    } catch (e) {}

    const cameraImg = document.getElementById('camera-img');
    if (cameraImg) {
      cameraImg.src = `https://clover-wx-camera-1028879236258.us-central1.run.app/camera/latest.jpg?t=${Date.now()}`;
    }
  } catch (err) {
    errorBanner.textContent = `Couldn't load weather data: ${err.message}`;
    errorBanner.style.display = 'block';
    status.textContent = `Last check attempt: ${new Date().toLocaleTimeString()}`;
  }
}

const TRIGGER_ENDPOINTS = [
  'https://weather-refresh-trigger.cloverwx4.workers.dev/',
];
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
  const COOLDOWN_STORAGE_KEY = 'weatherRefreshCooldownUntil';
  const REFRESH_BTN_DEFAULT_LABEL = 'refresh';

  function getRemainingCooldownMs() {
    const until = parseInt(localStorage.getItem(COOLDOWN_STORAGE_KEY) || '0', 10);
    return Math.max(0, until - Date.now());
  }

  function startCooldownCountdown() {
    function tick() {
      const remaining = getRemainingCooldownMs();
      if (remaining <= 0) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = REFRESH_BTN_DEFAULT_LABEL;
        return;
      }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      refreshBtn.disabled = true;
      refreshBtn.textContent = `wait ${minutes}:${seconds.toString().padStart(2, '0')}`;
      setTimeout(tick, 1000);
    }
    tick();
  }

  async function triggerWorkflow() {
  for (const url of TRIGGER_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST' });
      const result = await res.json();
      if (res.ok && result.success) {
        return true;
      }
    } catch (err) {
      console.warn(`Trigger failed via ${url}, trying next...`, err);
    }
  }
  return false;
  }

  async function handleRefreshClick() {
    if (isRefreshing || getRemainingCooldownMs() > 0) return;

    isRefreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'triggering update...';

    await loadData(true);
    await loadHistory(true);
    await loadCapeHistory();
    await loadForecast(true);
    refreshOutlookImages();

    const triggered = await triggerWorkflow();
    if (triggered) {
      status.textContent = '☀️ update triggered! new data should appear within a minute or two.';
    } else {
      status.textContent = "🌩️ couldn't update — showing latest available data instead.";
    }

    localStorage.setItem(COOLDOWN_STORAGE_KEY, (Date.now() + REFRESH_COOLDOWN_MS).toString());
    isRefreshing = false;
    startCooldownCountdown();
  }

  if (getRemainingCooldownMs() > 0) {
    startCooldownCountdown();
  }

  // desktop-only composition: move the existing live camera tile into the
  // 3x3 weather grid and move the non-urgent Sky & Space card below Forecast.
  // below 851px both cards return to their original DOM locations so the
  // mobile/tablet remains unchanged.
  (function initDesktopComposition() {
    const dashboardGrid = document.querySelector('.dashboard-grid');
    const weatherGrid = document.getElementById('grid');
    const leftRail = document.querySelector('.desktop-left-rail');
    const rightRail = document.querySelector('.desktop-right-rail');
    const forecastCard = document.querySelector('.desktop-left-rail .forecast-card');
    const cameraCard = document.getElementById('camera-img')?.closest('.camera-card');
    const skyCard = document.getElementById('sky-box')?.closest('.camera-card');
    const stormCard = document.querySelector('.dashboard-grid > .outlook-card');
    const webToolsGrid = document.querySelector('.web-tools-grid');
    const radarCard = document.querySelector('.web-tools-grid > .weather-map-card');
    const chartsDropdown = document.querySelector('.web-tools-grid > .charts-dropdown');
    if (!dashboardGrid || !weatherGrid || !leftRail || !forecastCard || !cameraCard || !skyCard || !stormCard) return;

    const desktopQuery = window.matchMedia('(min-width: 851px)');
    const originalCameraNextSibling = cameraCard.nextElementSibling;
    const originalSkyNextSibling = skyCard.nextElementSibling;
    const originalRadarNextSibling = radarCard ? radarCard.nextElementSibling : null;
    const originalChartsDropdownNextSibling = chartsDropdown ? chartsDropdown.nextElementSibling : null;

    function syncDesktopComposition() {
      if (desktopQuery.matches) {
        if (cameraCard.parentElement !== weatherGrid) {
          cameraCard.classList.add('desktop-camera-tile');
          weatherGrid.appendChild(cameraCard);
        }
        if (skyCard.parentElement !== leftRail) {
          skyCard.classList.add('desktop-sky-card');
          leftRail.insertBefore(skyCard, forecastCard.nextElementSibling);
        }
        if (radarCard && rightRail && radarCard.parentElement !== rightRail) {
          radarCard.classList.add('desktop-radar-card');
          rightRail.appendChild(radarCard);
        }
        if (chartsDropdown && chartsDropdown.parentElement !== leftRail) {
          chartsDropdown.classList.add('desktop-charts-dropdown');
          leftRail.appendChild(chartsDropdown);
        }
      } else {
        cameraCard.classList.remove('desktop-camera-tile');
        if (cameraCard.parentElement !== dashboardGrid) {
          if (originalCameraNextSibling && originalCameraNextSibling.parentElement === dashboardGrid) {
            dashboardGrid.insertBefore(cameraCard, originalCameraNextSibling);
          } else {
            dashboardGrid.insertBefore(cameraCard, dashboardGrid.firstElementChild);
          }
        }

        skyCard.classList.remove('desktop-sky-card');
        if (skyCard.parentElement !== dashboardGrid) {
          if (originalSkyNextSibling && originalSkyNextSibling.parentElement === dashboardGrid) {
            dashboardGrid.insertBefore(skyCard, originalSkyNextSibling);
          } else {
            dashboardGrid.insertBefore(skyCard, stormCard);
          }
        }

        if (radarCard && webToolsGrid) {
          radarCard.classList.remove('desktop-radar-card');
          if (radarCard.parentElement !== webToolsGrid) {
            if (originalRadarNextSibling && originalRadarNextSibling.parentElement === webToolsGrid) {
              webToolsGrid.insertBefore(radarCard, originalRadarNextSibling);
            } else {
              webToolsGrid.insertBefore(radarCard, webToolsGrid.firstElementChild);
            }
          }
        }

        if (chartsDropdown && webToolsGrid) {
          chartsDropdown.classList.remove('desktop-charts-dropdown');
          if (chartsDropdown.parentElement !== webToolsGrid) {
            if (originalChartsDropdownNextSibling && originalChartsDropdownNextSibling.parentElement === webToolsGrid) {
              webToolsGrid.insertBefore(chartsDropdown, originalChartsDropdownNextSibling);
            } else {
              webToolsGrid.appendChild(chartsDropdown);
            }
          }
        }
      }
    }

    syncDesktopComposition();
    desktopQuery.addEventListener?.('change', syncDesktopComposition);

    const lightbox = document.getElementById('camera-lightbox');
const lightboxImg = document.getElementById('camera-lightbox-img');
const lightboxVideo = document.getElementById('camera-lightbox-video');
const timelapseBtn = document.getElementById('camera-timelapse-btn');
const mobileTimelapseBtn = document.getElementById('camera-mobile-timelapse-btn');
const mobileTimelapseVideo = document.getElementById('camera-mobile-timelapse-video');
const closeBtn = document.getElementById('camera-lightbox-close');

function resetLightboxMedia() {
  if (lightboxImg) lightboxImg.style.display = '';
  if (lightboxVideo) {
    lightboxVideo.pause();
    lightboxVideo.removeAttribute('src');
    lightboxVideo.load();
    lightboxVideo.style.display = 'none';
  }
  if (timelapseBtn) timelapseBtn.style.display = '';
}

    function closeLightbox() {
  if (!lightbox) return;
  resetLightboxMedia();
  lightbox.classList.remove('open');
  lightbox.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

    function openLightbox() {
      if (!desktopQuery.matches || !lightbox || !lightboxImg) return;
      const source = document.getElementById('camera-img');
      if (!source || !source.src) return;
      lightboxImg.src = source.currentSrc || source.src;
      lightbox.classList.add('open');
      lightbox.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      closeBtn?.focus({ preventScroll: true });
    }

    function getYesterdayTimelapseUrl() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dayString =
    `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  return `https://clover-wx-camera-1028879236258.us-central1.run.app/camera/timelapse/${dayString}`;
}

function openTimelapse() {
  if (!lightbox || !lightboxVideo || !lightboxImg) return;

  lightboxImg.style.display = 'none';
  lightboxVideo.src = getYesterdayTimelapseUrl();
  lightboxVideo.style.display = 'block';
  if (timelapseBtn) timelapseBtn.style.display = 'none';
  lightbox.classList.add('open');
  lightbox.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  lightboxVideo.play().catch(() => {});
}

function toggleMobileTimelapse() {
  if (!mobileTimelapseBtn || !mobileTimelapseVideo) return;

  const showing = mobileTimelapseVideo.style.display === 'block';

  if (showing) {
    mobileTimelapseVideo.pause();
    mobileTimelapseVideo.removeAttribute('src');
    mobileTimelapseVideo.load();
    mobileTimelapseVideo.style.display = 'none';
    const source = document.getElementById('camera-img');
    if (source) source.style.display = '';
    mobileTimelapseBtn.textContent = "Yesterday's Time Lapse";
    return;
  }

  const source = document.getElementById('camera-img');
  if (source) source.style.display = 'none';
  mobileTimelapseVideo.src = getYesterdayTimelapseUrl();
  mobileTimelapseVideo.style.display = 'block';
  mobileTimelapseBtn.textContent = 'Show Live Camera';
  mobileTimelapseVideo.play().catch(() => {});
}

    timelapseBtn?.addEventListener('click', openTimelapse);
    mobileTimelapseBtn?.addEventListener('click', toggleMobileTimelapse);

    cameraCard.addEventListener('click', (event) => {
      if (desktopQuery.matches && !event.target.closest('a, button')) openLightbox();
    });
    closeBtn?.addEventListener('click', closeLightbox);
    lightbox?.addEventListener('click', (event) => {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && lightbox?.classList.contains('open')) closeLightbox();
    });
  })();

  (function hydrateFromCache() {
    try {
      const cached = JSON.parse(localStorage.getItem('cloverWeatherDataCache') || 'null');
      if (cached && cached.data) {
        lastWeatherData = cached.data;
        cachedTodaysExtremes = cached.todaysExtremes || {};
        cachedRiverMax = cached.riverMax || null;
        if (cached.usgs) currentUsgs = cached.usgs;
        renderCards(cached.data);
        renderAlertBanners(cached.alerts || []);
        currentPointAlerts = cached.alerts || [];
      }
    } catch (e) {
    }
  })();

  loadData();
  loadHistory();
  loadCapeHistory();
  loadForecast();
  loadThunderstormOutlooks();
  setInterval(loadData, REFRESH_INTERVAL_MS);
  setInterval(updateStatusLine, 15000); 
  setInterval(loadHistory, 5 * 60 * 1000);
  setInterval(loadCapeHistory, 5 * 60 * 1000);
  setInterval(loadForecast, 30 * 60 * 1000);
  setInterval(refreshOutlookImages, 30 * 60 * 1000);
  initOutlookCarousel();
  initOutlookCategoryTabs();
  initChartTabs();
  initRangeButtons();
  initWeatherFx();
  populateThemePreviewRow();
  initThemeEasterEgg();
  initSunMoonTracker();
  initForecastCardFlip();
  initMapTabs();
  initRadarMap();
  fetchUsgsGauge();
  setInterval(fetchUsgsGauge, USGS_REFRESH_INTERVAL_MS);
  loadVisitorCount();
  initNwsTabs();
  loadNwsProducts();
  setInterval(loadNwsProducts, 5 * 60 * 1000);
  
  refreshBtn.addEventListener('click', handleRefreshClick);

  const shareBtn = document.getElementById('share-btn');
  if (navigator.share) {
    shareBtn.style.display = 'inline-flex'; 
    shareBtn.addEventListener('click', () => {
      navigator.share({
        title: 'Clover Terrace Weather Station',
        text: 'Live weather, radar, and alerts for Clover Terrace, Aliquippa, PA',
        url: location.href,
      }).catch(() => {
      });
    });
  }

  initPushAlerts();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        if ('sync' in reg) {
          reg.sync.register('sync-weather-data').catch((err) => {
            console.warn('Background sync registration failed (may not be supported):', err);
          });
        }
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'background-sync-complete') {
            console.log('Background sync completed at', event.data.timestamp);
            if (event.data.weatherAvailable) {
              loadData(true);
            }
          }
        });
      }).catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
    
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SCHEDULE_SYNC' });
      }
    });
  }

  //* code: clover wx *//
  // ecowitt WS90 weather station
  // NWS, NOAA, SPC, USGS public data
  // Meteocons
  // PurpleAir
  // Rainviewer
  // Blitzortung
  // Meteoblue
  // created for the me using free public resources, not for commercial use :)
  
