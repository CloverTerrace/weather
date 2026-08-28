/* =====================================================================
   CLOVER TERRACE — GARDEN SCENE
   Reads the current season off <body data-garden-season="...">, then
   places real sprite images into the flower bed + ambient scatter from
   the manifest below. CSS handles the parts that are pure background
   tiling (terrain, border trim, card corners via --season-* variables
   in gardening.css); this file only handles the placed, individually
   clickable/decorative <img> elements that a CSS background can't be.

   TO ADD A NEW SEASON: drop its files under assets/garden/<season>/
   (same seven subfolders as summer: terrain, flowers, plants,
   creatures, decorations, borders, crops), then copy the "summer" key
   below into a new "autumn" / "winter" / "spring" key and swap in that
   season's filenames. Nothing else in this file needs to change — the
   season switch (data-garden-season) already works, it just has
   nowhere to look for the other three seasons yet.
   ===================================================================== */

(function () {
  "use strict";

  var SEASON_MANIFEST = {
    summer: {
      // Shown in the flower bed strip, left to right. Each is a real,
      // clickable sprite (button) with a short fact shown on tap/click.
      bed: [
        { file: "flowers/bed-rose.png", label: "Rose", fact: "Roses like consistent moisture — deep watering 2–3x a week beats a light daily sprinkle." },
        { file: "flowers/bed-daisy.png", label: "Daisy", fact: "Shasta daisies are pollinator magnets and rebloom if you deadhead spent flowers." },
        { file: "flowers/bed-sunflower.png", label: "Sunflower", fact: "Young sunflowers track the sun east to west; mature blooms settle facing east." },
        { file: "flowers/bed-hyacinth.png", label: "Hyacinth", fact: "Hyacinth bulbs need a cold spell to bloom well — plant in fall for spring flowers." },
        { file: "flowers/bed-allium.png", label: "Allium", fact: "Alliums are in the onion family — deer and rabbits tend to leave them alone." },
        { file: "flowers/bed-tulip.png", label: "Tulip", fact: "Tulip buds close up at night and on cloudy days, then reopen in sunlight." },
        { file: "flowers/bed-peony.png", label: "Peony", fact: "Peonies can live 50+ years in the same spot — plant them somewhere permanent." },
        { file: "flowers/bed-lily.png", label: "Lily", fact: "Lily pollen stains are notoriously hard to lift from fabric — handle blooms by the stem." }
      ],
      // The little creature perched in the bed.
      creature: { file: "creatures/berry-bug.png", label: "Garden bug", fact: "Ladybugs and their look-alikes can eat 50+ aphids a day — good company for a garden." },
      // Purely decorative, non-clickable sprites scattered in the bed.
      decorations: [
        "decorations/mushroom-red-cluster.png",
        "decorations/mushroom-tan-pair.png",
        "decorations/mushroom-red.png"
      ],
      // Small ambient flourishes pinned around the hero/margins.
      ambient: [
        "flowers/icon-daisy.png",
        "plants/grass-tuft.png",
        "flowers/icon-tulip.png",
        "plants/grass-blade-tall.png",
        "flowers/icon-sunflower.png",
        "plants/vine-blue.png"
      ],
      corner: "borders/corner.png"
    }

    // "spring": { ... },  // TODO once spring assets are sourced (may reuse summer)
    // "autumn": { ... },  // TODO — planned within the month
    // "winter": { ... }   // TODO
  };

  var basePath = function (season) {
    return "assets/garden/" + season + "/";
  };

  function getSeason() {
    return document.body.getAttribute("data-garden-season") || "summer";
  }

  // Falls back to summer's manifest/assets if the active season has no
  // manifest entry yet, so the page never shows broken image icons.
  function resolveManifest(season) {
    if (SEASON_MANIFEST[season]) {
      return { season: season, data: SEASON_MANIFEST[season] };
    }
    return { season: "summer", data: SEASON_MANIFEST.summer };
  }

  function closeTooltip() {
    var existing = document.querySelector(".garden-tooltip");
    if (existing) existing.remove();
    var active = document.querySelector(".garden-sprite.is-active");
    if (active) {
      active.classList.remove("is-active");
      active.setAttribute("aria-pressed", "false");
    }
  }

  function showTooltip(button, label, fact) {
    var wasActive = button.classList.contains("is-active");
    closeTooltip();
    if (wasActive) return; // clicking an already-open sprite just closes it

    button.classList.add("is-active");
    button.setAttribute("aria-pressed", "true");

    var tip = document.createElement("div");
    tip.className = "garden-tooltip";
    tip.setAttribute("role", "status");
    var strong = document.createElement("strong");
    strong.textContent = label;
    var p = document.createElement("p");
    p.style.margin = "0";
    p.textContent = fact;
    tip.appendChild(strong);
    tip.appendChild(p);
    button.appendChild(tip);
  }

  function makeSpriteButton(basePathValue, item, extraClass) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "garden-sprite" + (extraClass ? " " + extraClass : "");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", item.label);

    var img = document.createElement("img");
    img.src = basePathValue + item.file;
    img.alt = "";
    img.style.width = (extraClass === "garden-critter" ? "26px" : "40px");
    img.loading = "lazy";
    img.onerror = function () {
      btn.remove();
    };
    btn.appendChild(img);

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      showTooltip(btn, item.label, item.fact);
    });

    return btn;
  }

  function makeDecoration(basePathValue, file) {
    var span = document.createElement("span");
    span.className = "garden-deco";
    var img = document.createElement("img");
    img.src = basePathValue + file;
    img.alt = "";
    img.style.width = "28px";
    img.loading = "lazy";
    img.onerror = function () {
      span.remove();
    };
    span.appendChild(img);
    return span;
  }

  function renderBed(season, data) {
    var bed = document.getElementById("garden-bed-inner");
    if (!bed) return;
    bed.innerHTML = "";
    var path = basePath(season);

    (data.bed || []).forEach(function (item) {
      bed.appendChild(makeSpriteButton(path, item));
    });

    if (data.creature) {
      bed.appendChild(makeSpriteButton(path, data.creature, "garden-critter"));
    }

    (data.decorations || []).forEach(function (file) {
      bed.appendChild(makeDecoration(path, file));
    });
  }

  function renderAmbient(season, data) {
    var slots = document.querySelectorAll("[data-sprite-slot^='ambient-']");
    var path = basePath(season);
    var files = data.ambient || [];
    slots.forEach(function (el, i) {
      var file = files[i % files.length];
      if (!file) {
        el.style.display = "none";
        return;
      }
      el.src = path + file;
      el.onerror = function () {
        el.style.display = "none";
      };
    });
  }

  function renderCorners(season, data) {
    if (!data.corner) return;
    var path = basePath(season) + data.corner;
    document.querySelectorAll('[data-sprite="corner"]').forEach(function (img) {
      img.src = path;
    });
  }

  function applySeason(season) {
    var resolved = resolveManifest(season);
    renderBed(resolved.season, resolved.data);
    renderAmbient(resolved.season, resolved.data);
    renderCorners(resolved.season, resolved.data);
  }

  // Exposed so a future date-based or admin-set season switch can call
  // this directly: window.CloverGarden.setSeason("autumn").
  window.CloverGarden = window.CloverGarden || {};
  window.CloverGarden.setSeason = function (season) {
    document.body.setAttribute("data-garden-season", season);
    var world = document.querySelector(".garden-world");
    if (world) world.setAttribute("data-garden-season", season);
    applySeason(season);
  };

  document.addEventListener("click", closeTooltip);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeTooltip();
  });

  document.addEventListener("DOMContentLoaded", function () {
    applySeason(getSeason());
  });
})();
