import {
  AutoTokenizer,
  env as transformersEnv
} from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.js";

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

const MODEL_BASE = "https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main";
const ORT_WEBGPU = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0-dev.20240118-28a16c223c/dist/ort.webgpu.min.js";
const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js";
const ORT_ASSET_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";

const MODEL_FILES = [
  { key: "text_encoder", path: "text_encoder/model.onnx", label: "text encoder" },
  { key: "unet", path: "unet/model.onnx", label: "image model" },
  { key: "vae_decoder", path: "vae_decoder/model.onnx", label: "image decoder" }
];

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
let backend = "webgpu";
let modelLoaded = false;
let modelLoading = false;
let generating = false;
let currentAbortController = null;
let currentImageUrl = "";
let currentImageBlob = null;
let toastTimer = 0;
let tokenizer = null;
let ort = null;
let sessions = {};

transformersEnv.allowLocalModels = false;
transformersEnv.allowRemoteModels = true;
transformersEnv.remoteHost = "https://huggingface.co/";
transformersEnv.remotePathTemplate = "{model}/resolve/{revision}/";
transformersEnv.useBrowserCache = true;

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
  return Math.floor(Math.random() * 2147483646) + 1;
}

function resolvedSeed() {
  const typed = Number.parseInt(els.seed.value, 10);
  return Number.isFinite(typed) && typed >= 0 ? typed : randomSeed();
}

function fullPrompt() {
  const base = els.prompt.value.trim();
  const suffix = STYLE_SUFFIX[activeStyle] || "";
  return suffix ? `${base}. ${suffix}` : base;
}

function setReadyState(ready, message = "") {
  modelLoaded = ready;
  els.generateBtn.disabled = !ready || generating;
  els.statusDot.classList.toggle("ready", ready);
  els.statusText.textContent = message || (ready ? "Local model ready" : "Local model not loaded");
  els.privacyState.textContent = ready
    ? `Local ${backend === "webgpu" ? "GPU" : "CPU"} inference ready`
    : "No prompt leaves this page";
  els.loadModelBtn.textContent = ready ? "Model loaded" : "Download local model";
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
    tokenizing: "Reading your prompt locally…",
    encoding: "Encoding prompt locally…",
    denoising: "Generating pixels locally…",
    decoding: "Finishing image locally…",
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

async function chooseBackend() {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter && adapter.features?.has("shader-f16")) {
        backend = "webgpu";
        els.privacyState.textContent = "WebGPU + fp16 available · prompts stay local";
        els.statusText.textContent = "Ready to download the local GPU model";
        return;
      }
    } catch {}
  }

  backend = "wasm";
  els.privacyState.textContent = "Private CPU compatibility mode";
  els.statusText.textContent = "WebGPU unavailable · CPU mode is available but much slower";
  showToast("Using private CPU compatibility mode");
}

async function loadOrtRuntime() {
  const src = backend === "webgpu" ? ORT_WEBGPU : ORT_WASM;
  await loadScript(src);

  if (!window.ort) {
    throw new Error("ONNX Runtime loaded but did not initialize.");
  }

  ort = window.ort;

  if (ort.env?.wasm) {
    ort.env.wasm.wasmPaths = ORT_ASSET_BASE;
    ort.env.wasm.numThreads = 1;
  }
}

async function fetchModelFile(path, index) {
  const url = `${MODEL_BASE}/${path}`;
  const cache = await caches.open("suncanvas-model-v2");
  let response = await cache.match(url);

  if (!response) {
    setLoadProgress({
      message: `Downloading ${MODEL_FILES[index].label}…`,
      pct: Math.round((index / MODEL_FILES.length) * 100),
      detail: "network"
    });

    try {
      await cache.add(new Request(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer"
      }));
      response = await cache.match(url);
    } catch (cacheError) {
      console.warn("Cache download failed; falling back to direct fetch:", cacheError);
      response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });
    }
  } else {
    setLoadProgress({
      message: `Loading cached ${MODEL_FILES[index].label}…`,
      pct: Math.round((index / MODEL_FILES.length) * 100),
      detail: "cached"
    });
  }

  if (!response?.ok) {
    throw new Error(`Model download failed (${response?.status || "network"}) for ${MODEL_FILES[index].label}.`);
  }

  return await response.arrayBuffer();
}

async function ensureTokenizer() {
  if (tokenizer) return tokenizer;

  setLoadProgress({ message: "Loading private prompt tokenizer…", pct: 4 });

  tokenizer = await AutoTokenizer.from_pretrained(
    "Xenova/clip-vit-base-patch16",
    { local_files_only: false, revision: "main" }
  );

  tokenizer.pad_token_id = 0;
  return tokenizer;
}

function sessionOptions(key) {
  const options = {
    executionProviders: [backend],
    enableMemPattern: false,
    enableCpuMemArena: false,
    extra: {
      session: {
        disable_prepacking: "1",
        use_device_allocator_for_initializers: "1",
        use_ort_model_bytes_directly: "1",
        use_ort_model_bytes_for_initializers: "1"
      }
    }
  };

  if (backend === "webgpu") {
    options.preferredOutputLocation = { last_hidden_state: "gpu-buffer" };
  }

  if (key === "unet") {
    options.freeDimensionOverrides = {
      batch_size: 1,
      num_channels: 4,
      height: 64,
      width: 64,
      sequence_length: 77
    };
  } else if (key === "text_encoder") {
    options.freeDimensionOverrides = { batch_size: 1 };
  } else if (key === "vae_decoder") {
    options.freeDimensionOverrides = {
      batch_size: 1,
      num_channels_latent: 4,
      height_latent: 64,
      width_latent: 64
    };
  }

  return options;
}

async function loadLocalModel() {
  if (modelLoaded || modelLoading) return;

  clearTechnicalError();
  modelLoading = true;
  els.loadModelBtn.disabled = true;
  els.loadModelBtn.textContent = "Loading…";
  els.statusText.textContent = `Preparing private ${backend === "webgpu" ? "GPU" : "CPU"} inference…`;
  els.modelProgress.hidden = false;

  try {
    await loadOrtRuntime();
    await ensureTokenizer();

    sessions = {};

    for (let index = 0; index < MODEL_FILES.length; index++) {
      const file = MODEL_FILES[index];
      const buffer = await fetchModelFile(file.path, index);

      setLoadProgress({
        message: `Compiling ${file.label} locally…`,
        pct: Math.round(((index + 0.6) / MODEL_FILES.length) * 100)
      });

      sessions[file.key] = await ort.InferenceSession.create(buffer, sessionOptions(file.key));

      setLoadProgress({
        message: `${file.label} ready`,
        pct: Math.round(((index + 1) / MODEL_FILES.length) * 100)
      });
    }

    setLoadProgress({
      message: "Local model ready",
      pct: 100,
      detail: backend === "webgpu" ? "GPU" : "CPU"
    });

    setReadyState(true, `Local model ready · ${backend === "webgpu" ? "GPU" : "CPU"} mode`);
    showToast("Local model ready");
  } catch (error) {
    console.error(error);
    setTechnicalError(error);
    setReadyState(false, "Model load failed · open Technical details");
    els.progressFill.classList.remove("indeterminate");
    els.progressFill.style.width = "0%";
    els.progressLabel.textContent = "Model load failed";
    els.progressValue.textContent = backend === "wasm" ? "CPU compatibility limit" : "See details";
    showToast("Model load failed — details are now shown");
  } finally {
    modelLoading = false;
    if (!modelLoaded) {
      els.loadModelBtn.disabled = false;
      els.loadModelBtn.textContent = "Try model download again";
    }
  }
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randnLatents(shape, sigma, seed) {
  const rand = mulberry32(seed);
  let size = 1;
  for (const dimension of shape) size *= dimension;

  const data = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    const u = Math.max(rand(), 1e-7);
    const v = Math.max(rand(), 1e-7);
    data[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
  }

  return data;
}

function scaleModelInputs(tensor, sigma) {
  const input = tensor.data;
  const output = new Float32Array(input.length);
  const divisor = Math.sqrt(sigma * sigma + 1);

  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / divisor;
  }

  return new ort.Tensor("float32", output, tensor.dims);
}

function schedulerStep(modelOutput, sample, sigma, vaeScalingFactor) {
  const output = new Float32Array(modelOutput.data.length);

  for (let i = 0; i < output.length; i++) {
    const predOriginal = sample.data[i] - sigma * modelOutput.data[i];
    const derivative = (sample.data[i] - predOriginal) / sigma;
    output[i] = (sample.data[i] + derivative * -sigma) / vaeScalingFactor;
  }

  return new ort.Tensor("float32", output, modelOutput.dims);
}

async function tensorToBlob(tensor) {
  const [, , h, w] = tensor.dims;
  const data = tensor.data;
  const rgba = new Uint8ClampedArray(w * h * 4);
  let out = 0;

  const clamp = (value) => {
    const normalized = Math.min(1, Math.max(0, value / 2 + 0.5));
    return Math.round(normalized * 255);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      rgba[out++] = clamp(data[y * w + x]);
      rgba[out++] = clamp(data[h * w + y * w + x]);
      rgba[out++] = clamp(data[2 * h * w + y * w + x]);
      rgba[out++] = 255;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  context.putImageData(new ImageData(rgba, w, h), 0, 0);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not encode image.")),
      "image/png"
    );
  });
}

async function runModel(prompt, seed, signal) {
  const tok = await ensureTokenizer();
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  setGenerationProgress("tokenizing", 10);

  const tokenized = await tok(prompt, {
    padding: true,
    max_length: 77,
    truncation: true,
    return_tensor: false
  });

  const idsRaw = tokenized.input_ids;
  const ids = Int32Array.from(Array.isArray(idsRaw[0]) ? idsRaw[0] : idsRaw);

  setGenerationProgress("encoding", 25);

  const textOutput = await sessions.text_encoder.run({
    input_ids: new ort.Tensor("int32", ids, [1, ids.length])
  });

  const hidden = textOutput.last_hidden_state || Object.values(textOutput)[0];

  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  const sigma = 14.6146;
  const vaeScalingFactor = 0.18215;
  const latentShape = [1, 4, 64, 64];
  const latent = new ort.Tensor("float32", randnLatents(latentShape, sigma, seed), latentShape);
  const latentInput = scaleModelInputs(latent, sigma);

  setGenerationProgress("denoising", 65);

  const unetOutput = await sessions.unet.run({
    sample: latentInput,
    timestep: new ort.Tensor("int64", BigInt64Array.from([999n]), [1]),
    encoder_hidden_states: hidden
  });

  const predictedNoise = unetOutput.out_sample || Object.values(unetOutput)[0];

  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  const newLatents = schedulerStep(predictedNoise, latent, sigma, vaeScalingFactor);

  setGenerationProgress("decoding", 90);

  const vaeOutput = await sessions.vae_decoder.run({ latent_sample: newLatents });
  const imageTensor = vaeOutput.sample || Object.values(vaeOutput)[0];

  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  const blob = await tensorToBlob(imageTensor);
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

  if (!modelLoaded) {
    showToast("Download the local model first");
    return;
  }

  if (!prompt) {
    els.prompt.focus();
    showToast("Write a prompt first");
    return;
  }

  if (generating) return;

  generating = true;
  els.generateBtn.disabled = true;
  els.generateBtn.innerHTML = '<span class="generate-icon">✦</span> Generating…';
  els.cancelBtn.disabled = false;
  els.generationProgress.hidden = false;
  els.generationFill.style.width = "0%";
  els.generationLabel.textContent = "Starting local generation…";

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
    els.resultMeta.textContent = `SD‑Turbo · seed ${seed}`;
    els.resultSubmeta.textContent =
      `Generated locally in ${elapsed.toFixed(1)}s · ${backend === "webgpu" ? "GPU" : "CPU"} mode · not uploaded`;

    els.resultsSection.hidden = false;
    els.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (error?.name === "AbortError") {
      showToast("Generation cancelled");
    } else {
      console.error(error);
      setTechnicalError(error);
      showToast("Local generation failed — see Technical details");
    }
  } finally {
    generating = false;
    currentAbortController = null;
    els.cancelBtn.disabled = true;
    els.generateBtn.disabled = !modelLoaded;
    els.generateBtn.innerHTML = '<span class="generate-icon">✦</span> Generate locally';
  }
}

async function removeCachedModel() {
  if (generating) {
    showToast("Cancel generation first");
    return;
  }

  try {
    for (const session of Object.values(sessions)) {
      try { session?.release?.(); } catch {}
    }

    sessions = {};
    modelLoaded = false;
    tokenizer = null;

    await caches.delete("suncanvas-model-v2");

    setReadyState(false, "Cached image model removed");
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

document.querySelectorAll("[data-style]").forEach((button) => {
  button.addEventListener("click", () => {
    activeStyle = button.dataset.style;
    document.querySelectorAll("[data-style]").forEach((chip) => {
      chip.classList.toggle("active", chip === button);
    });
  });
});

els.loadModelBtn.addEventListener("click", loadLocalModel);
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

setReadyState(false);
chooseBackend();
