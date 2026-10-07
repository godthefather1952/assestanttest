import { Tokenizer } from "https://cdn.jsdelivr.net/npm/@huggingface/tokenizers@0.2.0";

const $ = (id) => document.getElementById(id);

const els = {
  prompt: $("prompt"),
  seed: $("seed"),
  loadModelBtn: $("loadModelBtn"),
  removeModelBtn: $("removeModelBtn"),
  modelProgress: $("modelProgress"),
  progressFill: $("progressFill"),
  progressLabel: $("progressLabel"),
  progressValue: $("progressValue"),
  privacyState: $("privacyState"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  generateBtn: $("generateBtn"),
  generateAgainBtn: $("generateAgainBtn"),
  surpriseBtn: $("surpriseBtn"),
  randomSeedBtn: $("randomSeedBtn"),
  clearSessionBtn: $("clearSessionBtn"),
  generationProgress: $("generationProgress"),
  generationFill: $("generationFill"),
  generationLabel: $("generationLabel"),
  cancelBtn: $("cancelBtn"),
  resultsSection: $("resultsSection"),
  resultImage: $("resultImage"),
  imagePlaceholder: $("imagePlaceholder"),
  resultMeta: $("resultMeta"),
  resultSubmeta: $("resultSubmeta"),
  downloadBtn: $("downloadBtn"),
  toast: $("toast"),
  loadDetails: $("loadDetails"),
  loadError: $("loadError")
};

const MODEL_BASE = "https://huggingface.co/Fcouprie/sdxs-512-texte-image/resolve/main";
const TOKENIZER_JSON_URL = `${MODEL_BASE}/tokenizer/tokenizer.json`;
const TOKENIZER_CONFIG_URL = `${MODEL_BASE}/tokenizer/tokenizer_config.json`;
const ORT_RUNTIME = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js";
const ORT_ASSET_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
const CACHE_NAME = "suncanvas-sdxs-v1";

const MODEL_FILES = [
  { key: "text_encoder", path: "onnx/text_encoder_int8.onnx", label: "text encoder", mb: 342 },
  { key: "unet", path: "onnx/unet_int8.onnx", label: "image model", mb: 330 },
  { key: "vae_decoder", path: "onnx/vae_decoder.onnx", label: "image decoder", mb: 5 }
];

const TOTAL_MODEL_MB = MODEL_FILES.reduce((sum, file) => sum + file.mb, 0);
const LATENT_SIZE = 64;
const IMAGE_SIZE = 512;
const MAX_TOKENS = 77;
const ALPHA_CUMPROD_T999 = 0.00466009508818388;

const STYLE_SUFFIX = {
  auto: "",
  photo: "photorealistic photograph, natural lighting, realistic materials, fine detail",
  cinematic: "cinematic film still, dramatic lighting, intentional composition, rich depth",
  editorial: "high-end editorial photography, sophisticated art direction, refined composition",
  illustration: "polished digital illustration, strong composition, intentional shapes, refined detail",
  anime: "premium anime illustration, expressive composition, crisp linework, detailed lighting",
  "3d": "high-end 3D render, physically based materials, global illumination, professional composition"
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
let modelCached = false;
let modelLoading = false;
let generating = false;
let currentAbortController = null;
let currentImageUrl = "";
let currentImageBlob = null;
let toastTimer = 0;
let tokenizer = null;
let ort = null;

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2300);
}

function setTechnicalError(error) {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}\n\n${error.stack || ""}`
    : String(error);

  els.loadError.textContent = message;
  els.loadDetails.hidden = false;
}

function clearTechnicalError() {
  els.loadError.textContent = "";
  els.loadDetails.hidden = true;
}

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff);
}

function resolvedSeed() {
  const typed = Number.parseInt(els.seed.value, 10);
  return Number.isFinite(typed) && typed >= 0 ? typed >>> 0 : randomSeed();
}

function fullPrompt() {
  const base = els.prompt.value.trim();
  const suffix = STYLE_SUFFIX[activeStyle] || "";
  return suffix ? `${base}. ${suffix}` : base;
}

function setReadyState(ready, message = "") {
  modelCached = ready;
  els.generateBtn.disabled = !ready || generating;
  els.statusDot.classList.toggle("ready", ready);
  els.statusText.textContent = message || (ready ? "Local model cached and ready" : "Local model not downloaded");
  els.privacyState.textContent = ready ? "CPU-local inference ready" : "No prompt leaves this page";
  els.loadModelBtn.textContent = ready ? "Model downloaded" : "Download local model";
  els.loadModelBtn.disabled = ready || modelLoading;
}

function setLoadProgress({ message = "Preparing…", pct = null, detail = "" } = {}) {
  els.modelProgress.hidden = false;

  if (typeof pct === "number") {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    els.progressFill.classList.remove("indeterminate");
    els.progressFill.style.width = clamped + "%";
    els.progressValue.textContent = detail || clamped + "%";
  } else {
    els.progressFill.style.width = "35%";
    els.progressFill.classList.add("indeterminate");
    els.progressValue.textContent = detail;
  }

  els.progressLabel.textContent = message;
}

function setGenerationProgress(phase, pct) {
  els.generationProgress.hidden = false;
  els.generationFill.style.width = Math.max(0, Math.min(100, pct)) + "%";

  const labels = {
    tokenizer: "Tokenizing prompt locally…",
    text_encoder: "Encoding prompt locally…",
    unet: "Generating image structure locally…",
    vae: "Decoding pixels locally…",
    complete: "Complete · image stayed on this device"
  };

  els.generationLabel.textContent = labels[phase] || "Generating locally…";
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-runtime="${src}"]`);
    if (existing) {
      if (window.ort) resolve();
      else existing.addEventListener("load", resolve, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.runtime = src;
    script.referrerPolicy = "no-referrer";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not download ONNX Runtime."));
    document.head.appendChild(script);
  });
}

async function ensureRuntime() {
  if (ort) return ort;

  await loadScript(ORT_RUNTIME);

  if (!window.ort) {
    throw new Error("ONNX Runtime loaded but did not initialize.");
  }

  ort = window.ort;
  ort.env.wasm.wasmPaths = ORT_ASSET_BASE;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  return ort;
}

async function fetchJsonCached(url) {
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(url);

  if (!response) {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    });

    if (!response.ok) {
      throw new Error(`Tokenizer download failed (${response.status}).`);
    }

    try {
      await cache.put(url, response.clone());
    } catch (error) {
      console.warn("Tokenizer cache write skipped:", error);
    }
  }

  return await response.json();
}

async function ensureTokenizer() {
  if (tokenizer) return tokenizer;

  setLoadProgress({ message: "Loading prompt tokenizer…", pct: 2 });

  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    fetchJsonCached(TOKENIZER_JSON_URL),
    fetchJsonCached(TOKENIZER_CONFIG_URL)
  ]);

  tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  return tokenizer;
}

function modelUrl(file) {
  return `${MODEL_BASE}/${file.path}`;
}

async function getCachedResponse(file) {
  const cache = await caches.open(CACHE_NAME);
  return await cache.match(modelUrl(file));
}

async function cacheModelFile(file, index) {
  const cache = await caches.open(CACHE_NAME);
  const url = modelUrl(file);
  const existing = await cache.match(url);

  const beforeMB = MODEL_FILES.slice(0, index).reduce((sum, item) => sum + item.mb, 0);
  const pct = Math.round((beforeMB / TOTAL_MODEL_MB) * 100);

  if (existing) {
    setLoadProgress({
      message: `${file.label} already cached`,
      pct,
      detail: `${file.mb} MB cached`
    });
    return;
  }

  setLoadProgress({
    message: `Downloading ${file.label}…`,
    pct,
    detail: `~${file.mb} MB`
  });

  const request = new Request(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store"
  });

  const response = await fetch(request);

  if (!response.ok) {
    throw new Error(`Model download failed (${response.status}) for ${file.label}.`);
  }

  try {
    await cache.put(url, response.clone());
  } catch (error) {
    throw new Error(
      `Browser storage could not cache the ${file.label} (~${file.mb} MB). ` +
      `Free some browser storage and try again. Original error: ${error?.message || error}`
    );
  }
}

async function verifyModelCache() {
  for (const file of MODEL_FILES) {
    if (!(await getCachedResponse(file))) return false;
  }
  return true;
}

async function downloadLocalModel() {
  if (modelCached || modelLoading) return;

  clearTechnicalError();
  modelLoading = true;
  els.loadModelBtn.disabled = true;
  els.loadModelBtn.textContent = "Downloading…";
  els.statusText.textContent = "Downloading smaller local CPU model…";
  els.modelProgress.hidden = false;

  try {
    await ensureRuntime();

    // Clean out the oversized SD-Turbo cache from the earlier build.
    await caches.delete("suncanvas-model-v2");

    await ensureTokenizer();

    for (let index = 0; index < MODEL_FILES.length; index++) {
      await cacheModelFile(MODEL_FILES[index], index);
    }

    const ok = await verifyModelCache();
    if (!ok) throw new Error("One or more model files were not cached.");

    setLoadProgress({
      message: "SDXS model cached locally",
      pct: 100,
      detail: "~680 MB"
    });

    setReadyState(true, "SDXS cached · ready for private CPU generation");
    showToast("Smaller local model is ready");
  } catch (error) {
    console.error(error);
    setTechnicalError(error);
    setReadyState(false, "Model download failed · open Technical details");
    els.progressFill.classList.remove("indeterminate");
    els.progressFill.style.width = "0%";
    els.progressLabel.textContent = "Model download failed";
    els.progressValue.textContent = "See details";
    showToast("Model download failed — details are shown");
  } finally {
    modelLoading = false;

    if (!modelCached) {
      els.loadModelBtn.disabled = false;
      els.loadModelBtn.textContent = "Try model download again";
    }
  }
}

async function modelBuffer(file) {
  let response = await getCachedResponse(file);

  if (!response) {
    // Recover if the browser evicted one cached file.
    const index = MODEL_FILES.indexOf(file);
    await cacheModelFile(file, index);
    response = await getCachedResponse(file);
  }

  if (!response) {
    throw new Error(`Could not read cached ${file.label}.`);
  }

  return await response.arrayBuffer();
}

function sessionOptions() {
  return {
    executionProviders: ["wasm"],
    enableMemPattern: false,
    enableCpuMemArena: false,
    graphOptimizationLevel: "all",
    extra: {
      session: {
        disable_prepacking: "1",
        use_device_allocator_for_initializers: "1",
        use_ort_model_bytes_directly: "1",
        use_ort_model_bytes_for_initializers: "1"
      }
    }
  };
}

async function withSession(file, callback) {
  let buffer = null;
  let session = null;

  try {
    buffer = await modelBuffer(file);
    session = await ort.InferenceSession.create(buffer, sessionOptions());
    buffer = null;
    return await callback(session);
  } finally {
    try { session?.release?.(); } catch {}
    session = null;
    buffer = null;

    // Yield between large stages so the browser can reclaim JS-side buffers.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function tokenizePrompt(tok, prompt) {
  return tok.encode(prompt);
}

function tokenIdsFromEncoding(encoded) {
  const raw = Array.isArray(encoded?.ids) ? encoded.ids : [];
  const clipped = raw.slice(0, MAX_TOKENS);

  // CLIP uses 49407 as end-of-text. Preserve an EOT token if truncation
  // removed it, then pad remaining positions with the configured pad id 0.
  if (raw.length > MAX_TOKENS && clipped.length === MAX_TOKENS) {
    clipped[MAX_TOKENS - 1] = 49407;
  }

  const ids = new BigInt64Array(MAX_TOKENS);

  for (let i = 0; i < MAX_TOKENS; i++) {
    ids[i] = BigInt(clipped[i] ?? 0);
  }

  return ids;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(size, rng) {
  const arr = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    const u = 1 - rng();
    const v = rng();
    arr[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  return arr;
}

function reconstructX0(noise, epsilon) {
  const sqrtAlpha = Math.sqrt(ALPHA_CUMPROD_T999);
  const sqrtOneMinusAlpha = Math.sqrt(1 - ALPHA_CUMPROD_T999);
  const x0 = new Float32Array(noise.length);

  for (let i = 0; i < x0.length; i++) {
    x0[i] = (noise[i] - sqrtOneMinusAlpha * epsilon[i]) / sqrtAlpha;
  }

  return x0;
}

function rgbaFromChw(raw, size) {
  const rgba = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pixel = y * size + x;

      for (let channel = 0; channel < 3; channel++) {
        const value = raw[channel * size * size + pixel];
        rgba[pixel * 4 + channel] =
          Math.round(Math.min(1, Math.max(0, value / 2 + 0.5)) * 255);
      }

      rgba[pixel * 4 + 3] = 255;
    }
  }

  return rgba;
}

async function rgbaToBlob(rgba, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable.");

  context.putImageData(new ImageData(rgba, width, height), 0, 0);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not encode image.")),
      "image/png"
    );
  });
}

async function runModel(prompt, seed, signal) {
  await ensureRuntime();
  const tok = await ensureTokenizer();

  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  setGenerationProgress("tokenizer", 8);
  const encoded = await tokenizePrompt(tok, prompt);
  const ids = tokenIdsFromEncoding(encoded);

  setGenerationProgress("text_encoder", 18);

  const hidden = await withSession(MODEL_FILES[0], async (session) => {
    const output = await session.run({
      input_ids: new ort.Tensor("int64", ids, [1, MAX_TOKENS])
    });

    const tensor = output.last_hidden_state || Object.values(output)[0];

    return {
      data: new Float32Array(tensor.data),
      dims: Array.from(tensor.dims)
    };
  });

  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  const rng = mulberry32(seed);
  const latentShape = [1, 4, LATENT_SIZE, LATENT_SIZE];
  const noise = randn(4 * LATENT_SIZE * LATENT_SIZE, rng);

  setGenerationProgress("unet", 48);

  const epsilon = await withSession(MODEL_FILES[1], async (session) => {
    const output = await session.run({
      sample: new ort.Tensor("float32", noise, latentShape),
      timestep: new ort.Tensor("int64", BigInt64Array.from([999n]), []),
      encoder_hidden_states: new ort.Tensor("float32", hidden.data, hidden.dims)
    });

    const tensor = output.noise_pred || Object.values(output)[0];
    return new Float32Array(tensor.data);
  });

  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  const x0 = reconstructX0(noise, epsilon);

  setGenerationProgress("vae", 82);

  const image = await withSession(MODEL_FILES[2], async (session) => {
    const output = await session.run({
      latents: new ort.Tensor("float32", x0, latentShape)
    });

    const tensor = output.image || Object.values(output)[0];
    return new Float32Array(tensor.data);
  });

  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  const rgba = rgbaFromChw(image, IMAGE_SIZE);
  const blob = await rgbaToBlob(rgba, IMAGE_SIZE, IMAGE_SIZE);

  setGenerationProgress("complete", 100);
  return blob;
}

function clearCurrentImage() {
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = "";
  }

  currentImageBlob = null;
  els.resultImage.removeAttribute("src");
  els.resultImage.classList.remove("loaded");
  els.imagePlaceholder.hidden = false;
  els.resultsSection.hidden = true;
}

async function generateLocalImage() {
  const prompt = els.prompt.value.trim();

  if (!modelCached) {
    showToast("Download the smaller local model first");
    return;
  }

  if (!prompt) {
    els.prompt.focus();
    showToast("Write a prompt first");
    return;
  }

  if (generating) return;

  clearTechnicalError();
  generating = true;
  els.generateBtn.disabled = true;
  els.generateBtn.innerHTML = '<span class="generate-icon">✦</span> Generating…';
  els.cancelBtn.disabled = false;
  els.generationProgress.hidden = false;
  els.generationFill.style.width = "0%";
  els.generationLabel.textContent = "Starting local CPU generation…";

  currentAbortController = new AbortController();
  const seed = resolvedSeed();
  const started = performance.now();

  try {
    const blob = await runModel(fullPrompt(), seed, currentAbortController.signal);
    clearCurrentImage();

    currentImageBlob = blob;
    currentImageUrl = URL.createObjectURL(blob);
    els.resultImage.src = currentImageUrl;
    els.resultImage.classList.add("loaded");
    els.imagePlaceholder.hidden = true;

    const elapsed = (performance.now() - started) / 1000;
    els.resultMeta.textContent = `SDXS‑512 INT8 · seed ${seed}`;
    els.resultSubmeta.textContent =
      `Generated locally in ${elapsed.toFixed(1)}s · CPU/WASM · not uploaded`;

    els.resultsSection.hidden = false;
    els.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (error?.name === "AbortError") {
      showToast("Generation cancelled");
    } else {
      console.error(error);
      setTechnicalError(error);
      showToast("Local generation failed — see Technical details");
      els.generationLabel.textContent = "Generation failed · see Technical details";
    }
  } finally {
    generating = false;
    currentAbortController = null;
    els.cancelBtn.disabled = true;
    els.generateBtn.disabled = !modelCached;
    els.generateBtn.innerHTML = '<span class="generate-icon">✦</span> Generate locally';
  }
}

async function removeCachedModel() {
  if (generating) {
    showToast("Cancel generation first");
    return;
  }

  try {
    await caches.delete(CACHE_NAME);
    await caches.delete("suncanvas-model-v2");

    modelCached = false;
    setReadyState(false, "Cached SDXS image model removed");
    els.modelProgress.hidden = true;
    els.progressFill.style.width = "0%";
    showToast("Local image model cache removed");
  } catch (error) {
    console.error(error);
    setTechnicalError(error);
    showToast("Could not remove model cache");
  }
}

function clearSession() {
  if (currentAbortController) currentAbortController.abort();

  els.prompt.value = "";
  els.seed.value = "";
  clearCurrentImage();
  els.generationProgress.hidden = true;
  clearTechnicalError();

  document.querySelectorAll("[data-style]").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.style === "auto");
  });

  activeStyle = "auto";
  showToast("Prompt and image cleared from this tab");
}

function downloadCurrentImage() {
  if (!currentImageBlob || !currentImageUrl) {
    showToast("Generate an image first");
    return;
  }

  const link = document.createElement("a");
  link.href = currentImageUrl;
  link.download = `suncanvas-${Date.now()}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function initialize() {
  setReadyState(false, "Checking local model cache…");

  try {
    await ensureRuntime();
    const ready = await verifyModelCache();

    if (ready) {
      setReadyState(true, "SDXS cached · ready for private CPU generation");
      setLoadProgress({ message: "SDXS model already cached", pct: 100, detail: "~680 MB" });
    } else {
      setReadyState(false, "Ready to download the smaller local CPU model");
      els.privacyState.textContent = "Private CPU/WASM mode";
    }
  } catch (error) {
    console.error(error);
    setTechnicalError(error);
    setReadyState(false, "Runtime check failed · open Technical details");
  }
}

document.querySelectorAll("[data-style]").forEach((button) => {
  button.addEventListener("click", () => {
    activeStyle = button.dataset.style;
    document.querySelectorAll("[data-style]").forEach((chip) => {
      chip.classList.toggle("active", chip === button);
    });
  });
});

els.loadModelBtn.addEventListener("click", downloadLocalModel);
els.removeModelBtn.addEventListener("click", removeCachedModel);
els.generateBtn.addEventListener("click", generateLocalImage);
els.generateAgainBtn.addEventListener("click", generateLocalImage);
els.clearSessionBtn.addEventListener("click", clearSession);
els.downloadBtn.addEventListener("click", downloadCurrentImage);

els.cancelBtn.addEventListener("click", () => {
  if (currentAbortController) currentAbortController.abort();
});

els.randomSeedBtn.addEventListener("click", () => {
  els.seed.value = String(randomSeed());
});

els.surpriseBtn.addEventListener("click", () => {
  els.prompt.value = SURPRISES[Math.floor(Math.random() * SURPRISES.length)];
  els.prompt.focus();
});

els.prompt.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    generateLocalImage();
  }
});

window.addEventListener("pagehide", () => {
  if (currentAbortController) currentAbortController.abort();
  if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
});

initialize();
