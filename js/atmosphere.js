/* Clover Terrace — Atmosphere page
   Fetches data/atmosphere.json (written by scripts/fetch_atmosphere.py) and
   renders the headline verdict, parameter cards, sounding chart, and
   wind-by-level table. Written defensively: the backend piece of this
   feature may not have run yet (or may fail on a given cycle, same
   continue-on-error pattern as every other fetch_*.py step), so every
   render function tolerates missing/partial data rather than throwing.
*/

(function () {
  'use strict';

  var DATA_URL = 'data/atmosphere.json';

  // ---------- small formatting helpers ----------

  function fmtNum(value, digits) {
    if (value === null || value === undefined || Number.isNaN(value)) return '\u2013\u2013';
    return Number(value).toFixed(digits === undefined ? 0 : digits);
  }

  function knotsToMph(kt) {
    return kt * 1.15078;
  }

  function degToCompass(deg) {
    var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    var idx = Math.round(deg / 22.5) % 16;
    return dirs[(idx + 16) % 16];
  }

  function windDirArrowChar(deg) {
    // arrow points in the direction the wind is blowing TOWARD (visually
    // intuitive), while the label text uses the meteorological "from"
    // convention -- so rotate the arrow 180deg from the "from" direction.
    return deg; // rotation handled via inline style where used
  }

  function timeAgoLabel(isoString) {
    if (!isoString) return null;
    var then = new Date(isoString);
    if (isNaN(then.getTime())) return null;
    var mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  }

  // ---------- category thresholds (standard SPC-style breakpoints) ----------

  function capeCategory(j) {
    if (j === null || j === undefined) return null;
    if (j < 100) return { key: 'stable', label: 'Stable', score: 0 };
    if (j < 1000) return { key: 'weak', label: 'Weak', score: 1 };
    if (j < 2500) return { key: 'moderate', label: 'Moderate', score: 2 };
    if (j < 4000) return { key: 'strong', label: 'Strong', score: 3 };
    return { key: 'extreme', label: 'Extreme', score: 4 };
  }

  function shearCategory(kt) {
    if (kt === null || kt === undefined) return null;
    if (kt < 20) return { key: 'weak', label: 'Weak', score: 0 };
    if (kt < 35) return { key: 'moderate', label: 'Moderate', score: 1 };
    if (kt < 50) return { key: 'strong', label: 'Strong', score: 2 };
    return { key: 'extreme', label: 'Extreme', score: 3 };
  }

  function srhCategory(v) {
    if (v === null || v === undefined) return null;
    var abs = Math.abs(v);
    if (abs < 100) return { key: 'low', label: 'Low', score: 0 };
    if (abs < 250) return { key: 'moderate', label: 'Moderate', score: 1 };
    if (abs < 400) return { key: 'high', label: 'High', score: 2 };
    return { key: 'extreme', label: 'Extreme', score: 3 };
  }

  function lapseCategory(cKm) {
    if (cKm === null || cKm === undefined) return null;
    if (cKm < 6.0) return { key: 'modest', label: 'Modest', score: 0 };
    if (cKm < 7.0) return { key: 'steepening', label: 'Steepening', score: 1 };
    if (cKm < 8.0) return { key: 'steep', label: 'Steep', score: 2 };
    return { key: 'very-steep', label: 'Very steep', score: 3 };
  }

  // ---------- composite "storm potential" verdict ----------
  // A simple, transparent ingredients-based score -- NOT the official SPC
  // outlook, and the footer/headline text says so. Combines mixed-layer
  // CAPE, 0-6km shear, and 0-3km SRH into one 0-10 score, bucketed into
  // 5 levels that echo (but don't claim to BE) SPC's own categorical names.
  function computeVerdict(p) {
    var mlcape = capeCategory(p.mlcape_j_kg);
    var shear = shearCategory(p.shear_0_6km_kt);
    var srh = srhCategory(p.srh_0_3km_m2_s2);

    if (!mlcape && !shear && !srh) return null;

    var score = (mlcape ? mlcape.score : 0) + (shear ? shear.score : 0) + (srh ? srh.score : 0);
    // max possible: 4 (cape) + 3 (shear) + 3 (srh) = 10

    var levels = [
      { max: 1, key: 'low', label: 'Low', badge: 'LOW',
        body: 'The atmosphere is stable right now \u2014 not much fuel and not much organization for storms to work with.' },
      { max: 3, key: 'marginal', label: 'Marginal', badge: 'MRGL',
        body: 'A little instability and shear are in place. Any storms that fire would likely stay ordinary, but keep an eye on trends.' },
      { max: 5, key: 'slight', label: 'Slight', badge: 'SLGT',
        body: 'There\u2019s a real combination of fuel and organization today \u2014 an isolated stronger storm wouldn\u2019t be a surprise if one develops.' },
      { max: 7, key: 'enhanced', label: 'Enhanced', badge: 'ENH',
        body: 'Instability and wind shear are both meaningfully in play \u2014 conditions favor storms that can organize and sustain themselves if they fire.' },
      { max: 10, key: 'high', label: 'High', badge: 'HIGH',
        body: 'A potent combination of instability and shear is present \u2014 the classic ingredients for strong, organized storms are all on the table.' },
    ];

    for (var i = 0; i < levels.length; i++) {
      if (score <= levels[i].max) return levels[i];
    }
    return levels[levels.length - 1];
  }

  // ---------- rendering ----------

  function renderModelMeta(payload) {
    var el = document.getElementById('atm-model-meta');
    if (!payload || !payload.model_cycle) {
      el.textContent = 'No recent model run available yet.';
      return;
    }
    var cycle = new Date(payload.model_cycle);
    var cycleLabel = isNaN(cycle.getTime()) ? payload.model_cycle :
      cycle.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    var ago = timeAgoLabel(payload.generated_at);
    el.textContent = (payload.model || 'HRRR') + ' \u00b7 ' + cycleLabel + ' cycle' +
      (ago ? ' \u00b7 computed ' + ago : '');
  }

  function renderHeadline(payload) {
    var section = document.getElementById('atm-headline');
    var badgeEl = document.getElementById('atm-headline-badge');
    var titleEl = document.getElementById('atm-headline-title');
    var bodyEl = document.getElementById('atm-headline-body');

    section.classList.remove('atm-headline-loading');

    if (!payload || !payload.parameters) {
      titleEl.textContent = 'No data yet';
      bodyEl.textContent = 'The atmosphere fetch hasn\u2019t completed a run yet \u2014 check back after the next model cycle.';
      badgeEl.textContent = '\u2013\u2013';
      return;
    }

    var verdict = computeVerdict(payload.parameters);
    if (!verdict) {
      titleEl.textContent = 'Not enough data';
      bodyEl.textContent = 'This model run is missing the parameters needed for a summary read \u2014 the individual cards below may still have partial data.';
      badgeEl.textContent = '\u2013\u2013';
      return;
    }

    section.classList.add('cat-' + verdict.key);
    badgeEl.textContent = verdict.badge;
    titleEl.textContent = verdict.label + ' storm potential';
    bodyEl.textContent = verdict.body + ' A simplified read from this one model run \u2014 not the official forecast.';
  }

  function renderInstabilityCard(p) {
    var sbcape = capeCategory(p.sbcape_j_kg);
    var mlcape = capeCategory(p.mlcape_j_kg);

    document.getElementById('stat-sbcape').textContent = fmtNum(p.sbcape_j_kg) + ' J/kg';
    document.getElementById('stat-mlcape').textContent = fmtNum(p.mlcape_j_kg) + ' J/kg';
    document.getElementById('stat-cin').textContent = fmtNum(p.mlcin_j_kg) + ' J/kg';

    var plain = document.getElementById('instability-plain');
    if (!mlcape) {
      plain.textContent = 'No instability data available for this run.';
      return;
    }
    var lines = {
      stable: 'Very little energy available \u2014 storms would struggle to build much vertical growth today.',
      weak: 'A modest amount of energy is available \u2014 enough for showers or weak storms to develop.',
      moderate: 'A solid amount of energy is available \u2014 storms that fire could build into real thunderstorms.',
      strong: 'A large amount of energy is available \u2014 storms could grow tall and strong if they develop.',
      extreme: 'An exceptional amount of energy is available \u2014 any storm that develops has huge room to grow.',
    };
    plain.textContent = lines[mlcape.key] || '';
  }

  function renderWindProfileCard(p) {
    document.getElementById('stat-shear6').textContent = fmtNum(p.shear_0_6km_kt, 0) + ' kt (' + fmtNum(knotsToMph(p.shear_0_6km_kt), 0) + ' mph)';
    document.getElementById('stat-shear1').textContent = fmtNum(p.shear_0_1km_kt, 0) + ' kt (' + fmtNum(knotsToMph(p.shear_0_1km_kt), 0) + ' mph)';
    document.getElementById('stat-srh3').textContent = fmtNum(p.srh_0_3km_m2_s2, 0) + ' m\u00b2/s\u00b2';
    document.getElementById('stat-srh1').textContent = fmtNum(p.srh_0_1km_m2_s2, 0) + ' m\u00b2/s\u00b2';

    var shearCat = shearCategory(p.shear_0_6km_kt);
    var srhCat = srhCategory(p.srh_0_3km_m2_s2);
    var plain = document.getElementById('wind-profile-plain');
    if (!shearCat && !srhCat) {
      plain.textContent = 'No wind-shear data available for this run.';
      return;
    }
    var parts = [];
    if (shearCat) {
      var shearLines = {
        weak: 'wind doesn\u2019t change much with height',
        moderate: 'a moderate amount of directional change with height',
        strong: 'strong turning and speed increase with height',
        extreme: 'extreme turning and speed increase with height',
      };
      parts.push(shearLines[shearCat.key]);
    }
    var sentence = 'There\u2019s ' + (parts[0] || 'limited change') + ' through the lowest few miles';
    if (srhCat && (srhCat.key === 'high' || srhCat.key === 'extreme')) {
      sentence += ', with enough low-level spin available that a well-organized storm could start rotating.';
    } else {
      sentence += '.';
    }
    plain.textContent = sentence;
  }

  function renderLapseCard(p) {
    document.getElementById('stat-lapse-mid').textContent = fmtNum(p.lapse_rate_700_500mb_c_km, 1) + ' \u00b0C/km';
    document.getElementById('stat-lapse-low').textContent = fmtNum(p.lapse_rate_0_3km_c_km, 1) + ' \u00b0C/km';

    var cat = lapseCategory(p.lapse_rate_700_500mb_c_km);
    var plain = document.getElementById('lapse-plain');
    if (!cat) {
      plain.textContent = 'No lapse-rate data available for this run.';
      return;
    }
    var lines = {
      modest: 'Temperatures aloft aren\u2019t dropping off unusually fast \u2014 a fairly ordinary profile.',
      steepening: 'Temperatures aloft are dropping off a bit faster than average, giving rising air a modest extra boost.',
      steep: 'Temperatures aloft are dropping off quickly \u2014 that cold air overhead helps rising surface air keep accelerating upward.',
      'very-steep': 'Temperatures aloft are dropping off very quickly \u2014 close to the steepest this atmosphere can support, which strongly favors vigorous updrafts.',
    };
    plain.textContent = lines[cat.key] || '';
  }

  function renderParamCards(payload) {
    var p = (payload && payload.parameters) || {};
    renderInstabilityCard(p);
    renderWindProfileCard(p);
    renderLapseCard(p);
  }

  // ---------- sounding chart ----------

  var soundingChart = null;

  function renderSoundingChart(payload) {
    var canvas = document.getElementById('sounding-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    var profile = (payload && payload.profile) || [];
    if (!profile.length) {
      var ctx = canvas.getContext('2d');
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#8b96ab';
      ctx.fillText('No profile data available for this run.', 12, 24);
      return;
    }

    var tempPoints = profile.map(function (row) { return { x: row.temp_c, y: row.height_m }; });
    var dewPoints = profile.map(function (row) { return { x: row.dewpoint_c, y: row.height_m }; });

    if (soundingChart) soundingChart.destroy();

    soundingChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Temperature',
            data: tempPoints,
            borderColor: '#ef5b5b',
            backgroundColor: 'transparent',
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.15,
          },
          {
            label: 'Dew Point',
            data: dewPoints,
            borderColor: '#5fd0e0',
            backgroundColor: 'transparent',
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.15,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        scales: {
          x: {
            title: { display: true, text: 'Temperature (\u00b0C)', color: '#8b96ab' },
            ticks: { color: '#8b96ab' },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
          y: {
            title: { display: true, text: 'Altitude (m)', color: '#8b96ab' },
            ticks: { color: '#8b96ab' },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
        },
        plugins: {
          legend: { labels: { color: '#e8edf5' } },
        },
      },
    });
  }

  // ---------- wind-by-level table ----------

  var WIND_TABLE_LEVELS = [
    { label: 'Surface', target: 1000 },
    { label: '850 mb', target: 850 },
    { label: '700 mb', target: 700 },
    { label: '500 mb', target: 500 },
    { label: '300 mb', target: 300 },
  ];

  function nearestLevel(profile, targetMb) {
    var best = null, bestDiff = Infinity;
    for (var i = 0; i < profile.length; i++) {
      var diff = Math.abs(profile[i].pressure_mb - targetMb);
      if (diff < bestDiff) { bestDiff = diff; best = profile[i]; }
    }
    return best;
  }

  function renderWindTable(payload) {
    var body = document.getElementById('atm-wind-table-body');
    var profile = (payload && payload.profile) || [];
    if (!profile.length) {
      body.innerHTML = '<tr><td colspan="2" class="atm-wind-loading">No wind data available for this run.</td></tr>';
      return;
    }

    var rows = WIND_TABLE_LEVELS.map(function (lvl) {
      var row = nearestLevel(profile, lvl.target);
      if (!row) return '';
      var speedKt = Math.sqrt(row.wind_u_kt * row.wind_u_kt + row.wind_v_kt * row.wind_v_kt);
      // meteorological "from" direction
      var fromDeg = (Math.atan2(-row.wind_u_kt, -row.wind_v_kt) * 180 / Math.PI + 360) % 360;
      var arrowRotation = (fromDeg + 180) % 360; // arrow points where wind is going
      return '<tr>' +
        '<td>' + lvl.label + '</td>' +
        '<td><span class="atm-wind-dir-arrow" style="display:inline-block;transform:rotate(' + arrowRotation.toFixed(0) + 'deg)">\u2191</span>' +
        fmtNum(speedKt, 0) + ' kt from ' + degToCompass(fromDeg) +
        '</td>' +
        '</tr>';
    }).join('');

    body.innerHTML = rows || '<tr><td colspan="2" class="atm-wind-loading">No wind data available for this run.</td></tr>';
  }

  // ---------- mobile card-row paging ----------

  function initCardPaging() {
    var row = document.getElementById('atm-card-row');
    var left = document.getElementById('atm-card-arrow-left');
    var right = document.getElementById('atm-card-arrow-right');
    if (!row || !left || !right) return;

    function scrollByCard(dir) {
      var card = row.querySelector('.atm-card');
      var amount = card ? card.getBoundingClientRect().width + 14 : 280;
      row.scrollBy({ left: dir * amount, behavior: 'smooth' });
    }

    left.addEventListener('click', function () { scrollByCard(-1); });
    right.addEventListener('click', function () { scrollByCard(1); });
  }

  // ---------- boot ----------

  function loadAtmosphere() {
    fetch(DATA_URL + '?t=' + Date.now())
      .then(function (res) {
        if (!res.ok) throw new Error('atmosphere.json not available (' + res.status + ')');
        return res.json();
      })
      .then(function (payload) {
        renderModelMeta(payload);
        renderHeadline(payload);
        renderParamCards(payload);
        renderSoundingChart(payload);
        renderWindTable(payload);
      })
      .catch(function () {
        renderModelMeta(null);
        renderHeadline(null);
        renderWindTable(null);
        renderSoundingChart(null);
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initCardPaging();
    loadAtmosphere();
  });
})();
