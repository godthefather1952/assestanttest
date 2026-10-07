(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    prompt: $("prompt"),
    model: $("model"),
    ratio: $("ratio"),
    quality: $("quality"),
    count: $("count"),
    seed: $("seed"),
    negativePrompt: $("negativePrompt"),
    enhance: $("enhance"),
    safeMode: $("safeMode"),
    generateBtn: $("generateBtn"),
    generateAgainBtn: $("generateAgainBtn"),
    surpriseBtn: $("surpriseBtn"),
    randomSeedBtn: $("randomSeedBtn"),
    clearHistoryBtn: $("clearHistoryBtn"),
    resultsSection: $("resultsSection"),
    resultsGrid: $("resultsGrid"),
    recentSection: $("recentSection"),
    recentGrid: $("recentGrid"),
    toast: $("toast")
  };

  const STYLE_SUFFIX = {
    auto: "",
    photo: "photorealistic photography, natural detail, realistic lighting, true-to-life materials",
    cinematic: "cinematic composition, dramatic natural lighting, rich depth, film still, sophisticated color grading",
    editorial: "high-end editorial photography, art direction, refined composition, magazine quality",
    illustration: "polished digital illustration, intentional shapes, strong composition, refined details",
    anime: "premium anime illustration, expressive composition, crisp linework, detailed lighting",
    "3d": "high-end 3D render, physically based materials, global illumination, clean professional composition"
  };

  const RATIOS = {
    standard: {
      "1:1": [1024, 1024],
      "4:3": [1152, 864],
      "3:4": [864, 1152],
      "16:9": [1216, 684],
      "9:16": [684, 1216]
    },
    high: {
      "1:1": [1280, 1280],
      "4:3": [1344, 1008],
      "3:4": [1008, 1344],
      "16:9": [1536, 864],
      "9:16": [864, 1536]
    }
  };

  const SURPRISES = [
    "A quiet brutalist house hidden in a misty pine forest at dawn, warm interior lights glowing through floor-to-ceiling windows",
    "A couture fashion portrait inspired by deep-sea bioluminescence, black studio background, sculptural translucent fabric",
    "A tiny ramen shop on a rainy neon street in Tokyo, viewed through a fogged window, intimate cinematic atmosphere",
    "An astronaut tending a lush greenhouse on the moon, Earth visible through the glass dome, believable documentary photography",
    "A surreal library carved inside a red sandstone canyon, enormous shelves following the natural rock formations, golden hour",
    "A vintage 1970s sports car parked outside a modern desert motel at blue hour, understated editorial campaign photography"
  ];

  let activeStyle = "auto";
  let toastTimer = 0;
  let currentBatch = [];

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  function randomSeed() {
    return Math.floor(Math.random() * 2147483646) + 1;
  }

  function resolvedSeed() {
    const typed = Number.parseInt(els.seed.value, 10);
    return Number.isFinite(typed) && typed >= 0 ? typed : randomSeed();
  }

  function dimensions() {
    return RATIOS[els.quality.value]?.[els.ratio.value] || RATIOS.standard["1:1"];
  }

  function fullPrompt() {
    const base = els.prompt.value.trim();
    const suffix = STYLE_SUFFIX[activeStyle] || "";
    return suffix ? `${base}. ${suffix}` : base;
  }

  function buildUrls(prompt, model, width, height, seed) {
    const encoded = encodeURIComponent(prompt);
    const params = new URLSearchParams({
      model,
      width: String(width),
      height: String(height),
      seed: String(seed),
      enhance: els.enhance.checked ? "true" : "false",
      safe: els.safeMode.checked ? "true" : "false"
    });

    const negative = els.negativePrompt.value.trim();
    if (negative) params.set("negative_prompt", negative);

    return [
      `https://gen.pollinations.ai/image/${encoded}?${params.toString()}`,
      `https://image.pollinations.ai/prompt/${encoded}?${params.toString()}`
    ];
  }

  function makeGeneration(index, baseSeed) {
    const [width, height] = dimensions();
    const seed = baseSeed + index;
    const prompt = fullPrompt();

    return {
      id: `${Date.now()}-${index}-${seed}`,
      prompt,
      originalPrompt: els.prompt.value.trim(),
      model: els.model.value,
      width,
      height,
      seed,
      ratio: els.ratio.value,
      quality: els.quality.value,
      style: activeStyle,
      urls: buildUrls(prompt, els.model.value, width, height, seed)
    };
  }

  function aspectStyle(item) {
    return `aspect-ratio:${item.width}/${item.height}`;
  }

  function createCard(item, { recent = false } = {}) {
    const card = document.createElement("article");
    card.className = "image-card loading";

    const frame = document.createElement("div");
    frame.className = "image-frame";
    frame.setAttribute("style", recent ? "" : aspectStyle(item));

    const img = document.createElement("img");
    img.alt = item.originalPrompt || item.prompt;
    img.loading = recent ? "lazy" : "eager";
    img.decoding = "async";

    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.innerHTML = `<strong></strong><span></span>`;
    meta.querySelector("strong").textContent = recent ? item.originalPrompt : `Seed ${item.seed}`;
    meta.querySelector("span").textContent = `${item.model} · ${item.width}×${item.height}`;

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const openBtn = document.createElement("button");
    openBtn.className = "icon-action";
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.title = "Open full-size image";

    const copyBtn = document.createElement("button");
    copyBtn.className = "icon-action";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy image URL";

    actions.append(openBtn, copyBtn);

    const bar = document.createElement("div");
    bar.className = "card-bar";
    bar.append(meta, actions);

    frame.append(img);
    card.append(frame, bar);

    let sourceIndex = 0;

    function loadSource() {
      img.src = item.urls[sourceIndex];
    }

    img.addEventListener("load", () => {
      card.classList.remove("loading", "error");
      img.classList.add("loaded");
      item.workingUrl = img.currentSrc || img.src;
      if (!recent) saveHistory(item);
    });

    img.addEventListener("error", () => {
      sourceIndex += 1;
      if (sourceIndex < item.urls.length) {
        loadSource();
        return;
      }

      card.classList.remove("loading");
      card.classList.add("error");
      frame.replaceChildren();

      const error = document.createElement("div");
      error.className = "error-copy";
      error.textContent = "Generation failed. The free provider may be busy or rate-limited. Tap Generate again.";
      frame.append(error);
    });

    openBtn.addEventListener("click", () => {
      window.open(item.workingUrl || item.urls[0], "_blank", "noopener,noreferrer");
    });

    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.workingUrl || item.urls[0]);
        showToast("Image URL copied");
      } catch {
        showToast("Could not copy URL");
      }
    });

    loadSource();
    return card;
  }

  function history() {
    try {
      return JSON.parse(localStorage.getItem("suncanvas-history") || "[]");
    } catch {
      return [];
    }
  }

  function saveHistory(item) {
    const existing = history().filter((entry) => entry.id !== item.id);
    const compact = {
      id: item.id,
      prompt: item.prompt,
      originalPrompt: item.originalPrompt,
      model: item.model,
      width: item.width,
      height: item.height,
      seed: item.seed,
      ratio: item.ratio,
      quality: item.quality,
      style: item.style,
      urls: item.urls,
      workingUrl: item.workingUrl || item.urls[0]
    };

    localStorage.setItem("suncanvas-history", JSON.stringify([compact, ...existing].slice(0, 16)));
    renderHistory();
  }

  function renderHistory() {
    const items = history();
    els.recentGrid.replaceChildren();
    els.recentSection.hidden = items.length === 0;

    for (const item of items.slice(0, 8)) {
      if (!Array.isArray(item.urls) || !item.urls.length) item.urls = [item.workingUrl];
      els.recentGrid.append(createCard(item, { recent: true }));
    }
  }

  function generate() {
    const prompt = els.prompt.value.trim();

    if (!prompt) {
      els.prompt.focus();
      showToast("Write a prompt first");
      return;
    }

    const count = Math.min(4, Math.max(1, Number(els.count.value) || 1));
    const baseSeed = resolvedSeed();

    els.generateBtn.disabled = true;
    els.generateBtn.innerHTML = '<span class="generate-icon">✦</span> Generating…';
    els.resultsGrid.replaceChildren();

    currentBatch = Array.from({ length: count }, (_, index) => makeGeneration(index, baseSeed));

    for (const item of currentBatch) {
      els.resultsGrid.append(createCard(item));
    }

    els.resultsSection.hidden = false;
    els.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });

    setTimeout(() => {
      els.generateBtn.disabled = false;
      els.generateBtn.innerHTML = '<span class="generate-icon">✦</span> Generate';
    }, 700);
  }

  document.querySelectorAll("[data-style]").forEach((button) => {
    button.addEventListener("click", () => {
      activeStyle = button.dataset.style;
      document.querySelectorAll("[data-style]").forEach((chip) => chip.classList.toggle("active", chip === button));
    });
  });

  els.generateBtn.addEventListener("click", generate);
  els.generateAgainBtn.addEventListener("click", generate);

  els.prompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") generate();
  });

  els.randomSeedBtn.addEventListener("click", () => {
    els.seed.value = String(randomSeed());
    showToast("Seed randomized");
  });

  els.surpriseBtn.addEventListener("click", () => {
    els.prompt.value = SURPRISES[Math.floor(Math.random() * SURPRISES.length)];
    els.prompt.focus();
  });

  els.clearHistoryBtn.addEventListener("click", () => {
    localStorage.removeItem("suncanvas-history");
    renderHistory();
    showToast("Recent generations cleared");
  });

  renderHistory();
})();
