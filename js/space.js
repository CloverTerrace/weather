document.addEventListener('DOMContentLoaded', () => {
  fetchNASAImage();
  fetchKpIndex();
  calculateMoonPhase();
  getVisibleConstellations();
});

// 1. Fetch NASA Astronomy Picture of the Day (APOD) for high-res background
async function fetchNASAImage() {
  const apiKey = 'DEMO_KEY'; // Replace with free API key from api.nasa.gov if needed
  try {
    const res = await fetch(`https://api.nasa.gov/planetary/apod?api_key=${apiKey}`);
    const data = await res.json();
    
    if (data.media_type === 'image') {
      document.body.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)), url('${data.hdurl || data.url}')`;
      document.getElementById('apod-title').textContent = `Background: ${data.title}`;
    }
  } catch (err) {
    document.getElementById('apod-title').textContent = 'Night Sky Overview';
  }
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
