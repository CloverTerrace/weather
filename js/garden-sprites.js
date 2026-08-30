/* Clover Terrace responsive DOM garden sprite engine — v2 */
(() => {
  const CATALOG = {
    spring: [
      { id:'spring-cherry', file:'flowers/cherryblossom.png', x:.07,y:.69,size:62,minWidth:0,layer:'back',motion:'sway',priority:100 },
      { id:'spring-hyacinth', file:'flowers/hyacinth.png', x:.22,y:.78,size:42,minWidth:0,layer:'front',motion:'sway',priority:100 },
      { id:'spring-forgetmenot', file:'flowers/forgetmenot.png', x:.38,y:.82,size:38,minWidth:0,layer:'front',priority:95 },
      { id:'spring-lily', file:'flowers/lily.png', x:.53,y:.78,size:40,minWidth:500,layer:'front',priority:90 },
      { id:'spring-lilypad', file:'flowers/lilypad.png', x:.67,y:.73,size:44,minWidth:700,layer:'back',priority:75 },
      { id:'spring-lotus', file:'flowers/lotus.png', x:.75,y:.80,size:46,minWidth:760,layer:'front',priority:90 },
      { id:'spring-pansy', file:'flowers/pansy.png', x:.88,y:.77,size:38,minWidth:900,layer:'front',motion:'sway',priority:85 },
      { id:'spring-peony', file:'flowers/peony.png', x:.94,y:.70,size:50,minWidth:1100,layer:'back',motion:'sway',priority:80 },
      { id:'spring-wildpansy', file:'flowers/wildpansy.png', x:.13,y:.84,size:34,minWidth:1200,layer:'front',priority:70 },
      { id:'spring-pink-edge', file:'flowers/flowers37.png', x:.03,y:.86,size:48,minWidth:1250,layer:'front',overlap:true,priority:65 }
    ],
    summer: [
      { id:'summer-blue', file:'flowers/flower-blue.png', x:.06,y:.76,size:40,minWidth:0,layer:'front',motion:'sway',priority:100 },
      { id:'summer-pink-cluster', file:'flowers/flower-cluster-pink.png', x:.19,y:.81,size:50,minWidth:0,layer:'front',motion:'sway',priority:100 },
      { id:'summer-allium', file:'flowers/bed-allium.png', x:.31,y:.84,size:50,minWidth:0,layer:'front',priority:90 },
      { id:'summer-daisy', file:'flowers/bed-daisy.png', x:.44,y:.82,size:48,minWidth:0,layer:'front',priority:90 },
      { id:'summer-purple', file:'flowers/flower-purple.png', x:.08,y:.69,size:42,minWidth:520,layer:'front',priority:85 },
      { id:'summer-orange', file:'flowers/flower-orange.png', x:.56,y:.78,size:42,minWidth:520,layer:'front',motion:'sway',priority:85 },
      { id:'summer-red', file:'flowers/flower-red.png', x:.73,y:.82,size:42,minWidth:650,layer:'front',priority:85 },
      { id:'summer-yellow', file:'flowers/flower-yellow.png', x:.92,y:.72,size:44,minWidth:760,layer:'front',motion:'sway',priority:85 },
      { id:'summer-colorful', file:'flowers/flower-cluster-colorful.png', x:.16,y:.86,size:54,minWidth:850,layer:'front',priority:75 },
      { id:'summer-big', file:'flowers/flower_big.png', x:.84,y:.85,size:62,minWidth:1000,layer:'back',motion:'sway',priority:75 },
      { id:'summer-rose', file:'flowers/flower-tall-pink.png', x:.12,y:.57,size:38,minWidth:900,layer:'back',clickable:true,interaction:'tip',tip:'A little summer bloom tucked into the garden.',priority:65 },
      { id:'summer-sunflower', file:'flowers/bed-sunflower.png', x:.88,y:.59,size:50,minWidth:1050,layer:'back',clickable:true,interaction:'tip',tip:'Sunflowers turn their faces toward the light.',priority:65 },
      { id:'summer-mushroom-red', file:'decorations/mushroom-red.png', x:.29,y:.88,size:36,minWidth:700,layer:'front',clickable:true,interaction:'spore-cloud',tip:'Tap the mushroom.',priority:80 },
      { id:'summer-mushroom-cluster', file:'decorations/mushroom-red-cluster.png', x:.78,y:.90,size:52,minWidth:1150,layer:'front',clickable:true,interaction:'spore-cloud',tip:'A tiny mushroom patch.',priority:60 },
      { id:'summer-rocks', file:'decorations/rocks.png', x:.48,y:.91,size:62,minWidth:1250,layer:'front',priority:50 },
      { id:'summer-grass-tuft', file:'plants/grass-tuft.png', x:.02,y:.91,size:64,minWidth:1200,layer:'front',overlap:true,priority:45 },
      { id:'summer-grass-tuft-right', file:'plants/grass-tuft-small.png', x:.97,y:.91,size:48,minWidth:1400,layer:'front',overlap:true,priority:40 },
      { id:'summer-bug', file:'creatures/berry-bug.png', x:.68,y:.48,size:30,minWidth:950,layer:'back',clickable:true,interaction:'scurry',motion:'hover',tip:'A tiny garden visitor.',weather:['clear','cloudy'],priority:70 }
    ],
    autumn: [
      { id:'autumn-fern-big', file:'plants/fern-big.png', x:.06,y:.76,size:72,minWidth:0,layer:'front',motion:'sway',priority:100 },
      { id:'autumn-berry-bush', file:'plants/berry-bush-1.png', x:.20,y:.81,size:62,minWidth:0,layer:'front',priority:100 },
      { id:'autumn-fern-small', file:'plants/fern-small.png', x:.82,y:.79,size:54,minWidth:520,layer:'front',motion:'sway',priority:90 },
      { id:'autumn-mossrock', file:'plants/mossrock.png', x:.93,y:.84,size:48,minWidth:700,layer:'front',priority:80 },
      { id:'autumn-mossrock2', file:'plants/mossrock2.png', x:.53,y:.89,size:50,minWidth:850,layer:'front',priority:70 },
      { id:'autumn-pitcher', file:'plants/pitcherplant.png', x:.14,y:.67,size:50,minWidth:1000,layer:'back',motion:'sway',priority:75 },
      { id:'autumn-flytrap', file:'plants/flytrap.png', x:.73,y:.82,size:48,minWidth:1150,layer:'front',clickable:true,interaction:'tip',tip:'A carnivorous little autumn oddity.',priority:65 },
      { id:'autumn-mossrock3', file:'plants/mossrock3.png', x:.35,y:.90,size:46,minWidth:1250,layer:'front',priority:55 }
    ],
    winter: [
      { id:'winter-snowflake-1', file:'flowers/snowflake.png', x:.10,y:.74,size:40,minWidth:0,layer:'front',motion:'drift',priority:100 },
      { id:'winter-snowflake-2', file:'flowers/snowflake.png', x:.34,y:.80,size:32,minWidth:0,layer:'front',motion:'drift',priority:95 },
      { id:'winter-snowflake-3', file:'flowers/snowflake.png', x:.65,y:.76,size:36,minWidth:650,layer:'front',motion:'drift',priority:90 },
      { id:'winter-snowflake-4', file:'flowers/snowflake.png', x:.90,y:.80,size:32,minWidth:900,layer:'front',motion:'drift',priority:85 },
      { id:'winter-snowflake-5', file:'flowers/snowflake.png', x:.49,y:.68,size:28,minWidth:1100,layer:'back',motion:'drift',priority:75 }
    ]
  };

  const state = { season:null, weather:null, rendered:[], resizeTimer:null, weatherTimer:null };

  const season = () => document.body?.dataset.gardenSeason || document.querySelector('.garden-world')?.dataset.gardenSeason || 'summer';
  const weather = () => document.documentElement?.dataset.gardenWeather || 'clear';
  const url = (s,file) => `assets/garden/${s}/${file}`;

  function density(width) {
    if (width < 500) return 8;
    if (width < 800) return 13;
    if (width < 1100) return 18;
    if (width < 1450) return 23;
    if (width < 1800) return 27;
    return 31;
  }

  function tip(text,x,y) {
    const world = document.querySelector('.garden-world');
    if (!world || !text) return;
    document.querySelectorAll('.garden-sprite-tip').forEach(n=>n.remove());
    const node=document.createElement('div');
    node.className='garden-sprite-tip';
    node.textContent=text;
    node.style.left=`${x*100}%`;
    node.style.top=`${Math.max(8,y*100-7)}%`;
    world.appendChild(node);
    requestAnimationFrame(()=>node.classList.add('is-visible'));
    setTimeout(()=>{node.classList.remove('is-visible');setTimeout(()=>node.remove(),180)},2800);
  }

  function spores(sprite) {
    const layer=sprite.parentElement; if(!layer) return;
    const rect=sprite.getBoundingClientRect(), parent=layer.getBoundingClientRect();
    for(let i=0;i<14;i++){
      const s=document.createElement('span'); s.className='garden-spore';
      s.style.left=`${rect.left-parent.left+rect.width*.5}px`;
      s.style.top=`${rect.top-parent.top+rect.height*.35}px`;
      const a=(Math.PI*2*i/14)+Math.random()*.35, d=18+Math.random()*38;
      s.style.setProperty('--spore-x',`${Math.cos(a)*d}px`);
      s.style.setProperty('--spore-y',`${-Math.abs(Math.sin(a)*d)-10}px`);
      layer.appendChild(s); setTimeout(()=>s.remove(),950);
    }
  }

  function handle(sprite,data){
    if(data.interaction==='tip') tip(data.tip,data.x,data.y);
    if(data.interaction==='spore-cloud'){
      sprite.classList.remove('is-pulsing'); void sprite.offsetWidth; sprite.classList.add('is-pulsing'); spores(sprite);
    }
    if(data.interaction==='scurry'){
      sprite.classList.remove('is-scurrying'); void sprite.offsetWidth; sprite.classList.add('is-scurrying');
      setTimeout(()=>sprite.classList.remove('is-scurrying'),1200);
      tip(data.tip,data.x,data.y);
    }
  }

  function bind(sprite,data){
    if(!data.clickable && !data.interaction) return;
    sprite.classList.add('is-clickable');
    sprite.setAttribute('role','button');
    sprite.setAttribute('tabindex','0');
    sprite.setAttribute('aria-label',data.tip || 'Interactive garden sprite');
    const activate=()=>handle(sprite,data);
    sprite.addEventListener('click',activate);
    sprite.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});
  }

  function renderAmbient(layer,s,w){
    if(!layer) return;
    layer.replaceChildren();
    const count = s==='autumn' ? Math.min(12,Math.floor(w/180)) : s==='spring' ? Math.min(10,Math.floor(w/220)) : 0;
    for(let i=0;i<count;i++){
      const p=document.createElement('span');
      p.className=`garden-ambient-particle garden-ambient-${s}`;
      p.style.left=`${(i*37+13)%97}%`;
      p.style.top=`${(i*29+18)%72}%`;
      p.style.setProperty('--ambient-delay',`${-((i*1.7)%9)}s`);
      p.style.setProperty('--ambient-duration',`${7+(i%5)}s`);
      layer.appendChild(p);
    }
  }

  function render(){
    const world=document.querySelector('.garden-world');
    const back=document.getElementById('garden-sprites-back');
    const front=document.getElementById('garden-sprites-front');
    const ambient=document.getElementById('garden-sprites-ambient');
    if(!world||!back||!front) return;

    const s=season(), w=window.innerWidth, wd=weather(), max=density(w);
    const all=(CATALOG[s]||[]).filter(d=>w>=(d.minWidth||0)).filter(d=>!d.weather || d.weather.includes(wd));
    all.sort((a,b)=>(b.priority||0)-(a.priority||0));
    const selected=all.slice(0,max);

    back.replaceChildren(); front.replaceChildren();
    document.querySelectorAll('.garden-sprite-tip').forEach(n=>n.remove());
    renderAmbient(ambient,s,w);
    state.rendered=[];

    for(const d of selected){
      const img=document.createElement('img');
      img.className='garden-sprite';
      if(d.motion) img.classList.add(`is-${d.motion}`);
      if(d.overlap) img.classList.add('is-overlap');
      img.src=url(s,d.file); img.alt=d.alt||''; img.decoding='async'; img.loading='eager';
      img.style.left=`${d.x*100}%`; img.style.top=`${d.y*100}%`;
      img.style.setProperty('--sprite-size',`${d.size||40}px`);
      img.style.setProperty('--sprite-delay',`${((d.x*1.9)%3).toFixed(2)}s`);
      img.dataset.spriteId=d.id;
      img.onerror=()=>img.remove();
      (d.layer==='front'?front:back).appendChild(img);
      bind(img,d);
      state.rendered.push({data:d,node:img});
    }
    state.season=s; state.weather=wd;
  }

  function init(){
    render();
    const world=document.querySelector('.garden-world');
    if(world){
      const observer=new MutationObserver(()=>{
        const s=season(),w=weather();
        if(s!==state.season || w!==state.weather) render();
      });
      observer.observe(document.body,{attributes:true,attributeFilter:['data-garden-season']});
      observer.observe(world,{attributes:true,attributeFilter:['data-garden-season']});
      observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-garden-weather']});
    }
    let lastWidth=window.innerWidth;
    window.addEventListener('resize',()=>{
      const w=window.innerWidth;
      if(Math.abs(w-lastWidth)<80) return;
      lastWidth=w; clearTimeout(state.resizeTimer); state.resizeTimer=setTimeout(render,140);
    },{passive:true});
    // Weather classification is updated asynchronously by gardening.js.
    state.weatherTimer=setInterval(()=>{
      const w=weather(); if(w!==state.weather) render();
    },4000);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
