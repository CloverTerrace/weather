/* Clover Terrace responsive DOM garden sprite engine */
(() => {
// ---------- responsive DOM garden sprite world ----------
// Sprite artwork lives in the repository's seasonal asset folders. Each
// sprite has a stable normalized position (0..1) so resizing the browser
// reveals more of the same garden instead of stretching a fixed scene.
// The engine is intentionally independent from the weather/data code above.
const GARDEN_SPRITE_CATALOG = {
  spring: [
    { id: 'spring-cherry', file: 'flowers/cherryblossom.png', x: .10, y: .73, size: 58, minWidth: 0, layer: 'back', motion: true },
    { id: 'spring-hyacinth', file: 'flowers/hyacinth.png', x: .28, y: .80, size: 38, minWidth: 0, layer: 'front', motion: true },
    { id: 'spring-lily', file: 'flowers/lily.png', x: .49, y: .78, size: 38, minWidth: 520, layer: 'front' },
    { id: 'spring-lotus', file: 'flowers/lotus.png', x: .72, y: .79, size: 42, minWidth: 760, layer: 'front' },
    { id: 'spring-peony', file: 'flowers/peony.png', x: .90, y: .75, size: 46, minWidth: 1050, layer: 'back', motion: true }
  ],
  summer: [
    { id: 'summer-blue', file: 'flowers/flower-blue.png', x: .08, y: .76, size: 38, minWidth: 0, layer: 'front', motion: true },
    { id: 'summer-pink-cluster', file: 'flowers/flower-cluster-pink.png', x: .24, y: .80, size: 48, minWidth: 0, layer: 'front', motion: true },
    { id: 'summer-purple', file: 'flowers/flower-purple.png', x: .08, y: .70, size: 40, minWidth: 520, layer: 'front' },
    { id: 'summer-yellow', file: 'flowers/flower-yellow.png', x: .92, y: .72, size: 42, minWidth: 760, layer: 'front', motion: true },
    { id: 'summer-colorful', file: 'flowers/flower-colorful.png', x: .15, y: .82, size: 46, minWidth: 900, layer: 'back', motion: true },
    { id: 'summer-big', file: 'flowers/flower_big.png', x: .85, y: .84, size: 58, minWidth: 1100, layer: 'back', motion: true },
    { id: 'summer-rose', file: 'flowers/icon-rose.png', x: .14, y: .55, size: 30, minWidth: 900, layer: 'back', clickable: true, interaction: 'tip', tip: 'A little rose tucked into the garden.' },
    { id: 'summer-sunflower', file: 'flowers/icon-sunflower.png', x: .84, y: .55, size: 34, minWidth: 1100, layer: 'back', clickable: true, interaction: 'tip', tip: 'Sunflowers love the sunshine.' }
  ],
  autumn: [
    { id: 'autumn-fern-big', file: 'plants/fern-big.png', x: .07, y: .76, size: 70, minWidth: 0, layer: 'front', motion: true },
    { id: 'autumn-berry-bush', file: 'plants/berry-bush-1.png', x: .20, y: .80, size: 60, minWidth: 0, layer: 'front' },
    { id: 'autumn-fern-small', file: 'plants/fern-small.png', x: .82, y: .79, size: 52, minWidth: 520, layer: 'front', motion: true },
    { id: 'autumn-mossrock', file: 'plants/mossrock.png', x: .93, y: .82, size: 46, minWidth: 800, layer: 'front' },
    { id: 'autumn-pitcher', file: 'plants/pitcherplant.png', x: .15, y: .66, size: 46, minWidth: 1100, layer: 'back', motion: true }
  ],
  winter: [
    { id: 'winter-snowflake', file: 'icon-snowflake.png', x: .12, y: .74, size: 38, minWidth: 0, layer: 'front', motion: true },
    { id: 'winter-snowflake-2', file: 'icon-snowflake.png', x: .38, y: .79, size: 30, minWidth: 0, layer: 'front' },
    { id: 'winter-snowflake-3', file: 'icon-snowflake.png', x: .67, y: .76, size: 34, minWidth: 650, layer: 'front', motion: true },
    { id: 'winter-snowflake-4', file: 'icon-snowflake.png', x: .90, y: .80, size: 30, minWidth: 950, layer: 'front' }
  ]
};

const GARDEN_OPTIONAL_SPRITES = {
  // These entries are deliberately optional. Once the corresponding
  // creature/mushroom artwork is present in the repo, the same engine can
  // activate the interaction without another rendering-system rewrite.
  summer: [
    { id: 'summer-butterfly', file: 'creatures/butterfly.png', x: .90, y: .45, size: 34, minWidth: 1050, layer: 'back', clickable: true, interaction: 'fly-away', optional: true },
    { id: 'summer-mushroom', file: 'decorations/mushroom.png', x: .06, y: .84, size: 34, minWidth: 800, layer: 'front', clickable: true, interaction: 'spore-cloud', optional: true }
  ]
};

let gardenSpriteState = { season: null, rendered: [], resizeTimer: null };

function gardenSpriteSeason() {
  return document.body?.dataset.gardenSeason || document.querySelector('.garden-world')?.dataset.gardenSeason || 'summer';
}

function gardenSpriteDensity(width) {
  if (width < 500) return 5;
  if (width < 800) return 8;
  if (width < 1100) return 11;
  if (width < 1450) return 14;
  return 17;
}

function gardenSpriteUrl(season, file) {
  return `assets/garden/${season}/${file}`;
}

function gardenSpriteCreateTip(text, x, y) {
  const world = document.querySelector('.garden-world');
  if (!world || !text) return;
  const tip = document.createElement('div');
  tip.className = 'garden-sprite-tip';
  tip.textContent = text;
  tip.style.left = `${x * 100}%`;
  tip.style.top = `${Math.max(6, y * 100 - 7)}%`;
  world.appendChild(tip);
  requestAnimationFrame(() => tip.classList.add('is-visible'));
  window.setTimeout(() => {
    tip.classList.remove('is-visible');
    window.setTimeout(() => tip.remove(), 180);
  }, 2600);
}

function gardenSpriteSporeCloud(sprite) {
  const layer = sprite.parentElement;
  if (!layer) return;
  const count = 10;
  for (let i = 0; i < count; i++) {
    const spore = document.createElement('span');
    spore.className = 'garden-spore';
    spore.style.left = `${sprite.offsetLeft + sprite.offsetWidth * .5}px`;
    spore.style.top = `${sprite.offsetTop + sprite.offsetHeight * .35}px`;
    const angle = (Math.PI * 2 * i / count) + Math.random() * .4;
    const distance = 16 + Math.random() * 28;
    spore.style.setProperty('--spore-x', `${Math.cos(angle) * distance}px`);
    spore.style.setProperty('--spore-y', `${-Math.abs(Math.sin(angle) * distance) - 8}px`);
    layer.appendChild(spore);
    window.setTimeout(() => spore.remove(), 900);
  }
}

function gardenSpriteHandleInteraction(sprite, data) {
  if (data.interaction === 'fly-away') {
    sprite.classList.remove('is-flying-away');
    void sprite.offsetWidth;
    sprite.classList.add('is-flying-away');
    sprite.addEventListener('animationend', () => {
      sprite.classList.remove('is-flying-away');
      sprite.style.opacity = '';
    }, { once: true });
    return;
  }

  if (data.interaction === 'spore-cloud') {
    sprite.classList.remove('is-pulsing');
    void sprite.offsetWidth;
    sprite.classList.add('is-pulsing');
    gardenSpriteSporeCloud(sprite);
    return;
  }

  if (data.interaction === 'tip') {
    gardenSpriteCreateTip(data.tip || 'A tiny garden secret.', data.x, data.y);
  }
}

function gardenSpriteBind(sprite, data) {
  if (!data.clickable && !data.interaction) return;
  sprite.classList.add('is-clickable');
  sprite.setAttribute('role', 'button');
  sprite.setAttribute('tabindex', '0');
  sprite.setAttribute('aria-label', data.tip || 'Interactive garden sprite');

  const activate = () => gardenSpriteHandleInteraction(sprite, data);
  sprite.addEventListener('click', activate);
  sprite.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
}

function gardenSpriteRender() {
  const world = document.querySelector('.garden-world');
  const back = document.getElementById('garden-sprites-back');
  const front = document.getElementById('garden-sprites-front');
  if (!world || !back || !front) return;

  const season = gardenSpriteSeason();
  const width = window.innerWidth;
  const density = gardenSpriteDensity(width);
  const base = GARDEN_SPRITE_CATALOG[season] || [];
  const optional = GARDEN_OPTIONAL_SPRITES[season] || [];
  const candidates = [...base, ...optional];

  back.replaceChildren();
  front.replaceChildren();
  document.querySelectorAll('.garden-sprite-tip').forEach(node => node.remove());
  gardenSpriteState.rendered = [];

  // The catalog is ordered from the most important/available objects to
  // progressively wider-screen details. This keeps mobile stable while
  // allowing desktop to reveal additional garden territory.
  const selected = candidates
    .filter(item => width >= (item.minWidth || 0))
    .slice(0, density);

  for (const data of selected) {
    const img = document.createElement('img');
    img.className = 'garden-sprite' + (data.motion ? ' is-gently-moving' : '');
    img.src = gardenSpriteUrl(season, data.file);
    img.alt = data.alt || '';
    img.decoding = 'async';
    img.loading = 'eager';
    img.style.left = `${data.x * 100}%`;
    img.style.top = `${data.y * 100}%`;
    img.style.setProperty('--sprite-size', `${data.size || 40}px`);
    img.style.setProperty('--sprite-delay', `${(data.x * 1.7).toFixed(2)}s`);
    img.dataset.spriteId = data.id;
    img.dataset.spriteInteraction = data.interaction || '';
    img.onerror = () => img.remove();

    // Keep missing optional assets completely silent; they can be added to
    // the repository later and the engine will begin using them automatically.
    if (data.optional) img.dataset.optional = 'true';

    const layer = data.layer === 'front' ? front : back;
    layer.appendChild(img);
    gardenSpriteBind(img, data);
    gardenSpriteState.rendered.push({ data, node: img });
  }

  gardenSpriteState.season = season;
}

function initGardenSprites() {
  gardenSpriteRender();

  const world = document.querySelector('.garden-world');
  if (world) {
    const observer = new MutationObserver(() => {
      const season = gardenSpriteSeason();
      if (season !== gardenSpriteState.season) gardenSpriteRender();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-garden-season'] });
    observer.observe(world, { attributes: true, attributeFilter: ['data-garden-season'] });
  }

  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    if (Math.abs(width - lastWidth) < 80) return;
    lastWidth = width;
    window.clearTimeout(gardenSpriteState.resizeTimer);
    gardenSpriteState.resizeTimer = window.setTimeout(gardenSpriteRender, 120);
  }, { passive: true });
}

// The main gardening.js file runs its own init() immediately. Waiting for
// DOMContentLoaded here guarantees the season attribute has already been
// applied before the first sprite catalog is rendered.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGardenSprites, { once: true });
} else {
  initGardenSprites();
}
})();
