import {
  detectCapabilities,
  loadModel,
  generateImage,
  unloadModel,
  purgeModelCache
} from "https://esm.sh/web-txt2img@0.3.1?bundle&deps=onnxruntime-web@1.18.0,@xenova/transformers@2.17.2";

import * as ort from "https://esm.sh/onnxruntime-web@1.18.0/webgpu?bundle";
import {
  AutoTokenizer,
  env as transformersEnv
} from "https://esm.sh/@xenova/transformers@2.17.2?bundle";

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
  toast: $("toast")
};

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

const MODEL_ID = "sd-turbo";
const ORT_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";

let activeStyle = "auto";
let modelLoaded = false;
let modelLoading = false;
let generating = false;
let currentAbortController = null;
let currentImageUrl = "";
let currentImageBlob = null;
let toastTimer = 0;
let tokenizerPromise = null;

transformersEnv.allowLocalModels = false;
transformersEnv.allowRemoteModels = true;
transformersEnv.remoteHost = "https://huggingface.co/";
transformersEnv.remotePathTemplate = "{model}/resolve/{revision}/";
transformersEnv.useBrowserCache = true;

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2000);
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
  els.privacyState.textContent = ready ? "Local inference ready" : "No prompt leaves this page";
  els.loadModelBtn.textContent = ready ? "Model loaded" : "Download local model";
  els.loadModelBtn.disabled = ready || modelLoading;
}

function setLoadProgress(progress = {}) {
  els.modelProgress.hidden = false;

  const pct = typeof progress.pct === "number"
    ? Math.max(0, Math.min(100, Math.round(progress.pct)))
    : null;

  if (pct === null) {
    els.progressFill.classList.add("indeterminate");
  } else {
    els.progressFill.classList.remove("indeterminate");
    els.progressFill.style.width = pct + "%";
  }

  els.progressLabel.textContent = progress.message || "Preparing local model…";

  if (
    typeof progress.bytesDownloaded === "number" &&
    typeof progress.totalBytesExpected === "number" &&
    progress.totalBytesExpected > 0
  ) {
    const loadedGB = progress.bytesDownloaded / 1024 / 1024 / 1024;
    const totalGB = progress.totalBytesExpected / 1024 / 1024 / 1024;
    els.progressValue.textContent = `${loadedGB.toFixed(2)} / ${totalGB.toFixed(2)} GB`;
  } else {
    els.progressValue.textContent = pct === null ? "" : pct + "%";
  }
}

function setGenerationProgress(event = {}) {
  els.generationProgress.hidden = false;
  const pct = typeof event.pct === "number"
    ? Math.max(0, Math.min(100, Math.round(event.pct)))
    : 0;

  els.generationFill.style.width = pct + "%";

  const labels = {
    tokenizing: "Reading your prompt locally…",
    encoding: "Encoding prompt locally…",
    denoising: "Generating pixels on your GPU…",
    decoding: "Finishing image locally…",
    complete: "Complete"
  };

  els.generationLabel.textContent = labels[event.phase] || "Generating locally…";
}

async function tokenizerProvider() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(
      "Xenova/clip-vit-base-patch16",
      {
        local_files_only: false,
        revision: "main"
      }
    );
  }

  const tokenizer = await tokenizerPromise;
  tokenizer.pad_token_id = 0;

  return async (text, options = {}) => tokenizer(text, options);
}

async function checkDevice() {
  try {
    const caps = await detectCapabilities();

    if (!caps.webgpu || !navigator.gpu) {
      els.privacyState.textContent = "WebGPU unavailable";
      els.statusText.textContent = "This browser/device does not expose WebGPU";
      els.loadModelBtn.disabled = true;
      els.generateBtn.disabled = true;
      showToast("WebGPU is required for local generation");
      return;
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      els.privacyState.textContent = "Compatible GPU not found";
      els.loadModelBtn.disabled = true;
      return;
    }

    els.privacyState.textContent = "WebGPU available · prompts stay local";
    els.statusText.textContent = "Ready to download the local model";
    els.loadModelBtn.disabled = false;
  } catch (error) {
    console.error(error);
    els.privacyState.textContent = "Device check failed";
    els.loadModelBtn.disabled = true;
  }
}

async function loadLocalModel() {
  if (modelLoaded || modelLoading) return;

  modelLoading = true;
  els.loadModelBtn.disabled = true;
  els.loadModelBtn.textContent = "Loading…";
  els.statusText.textContent = "Downloading / loading model locally";
  els.modelProgress.hidden = false;
  setLoadProgress({ message: "Starting private local model…" });

  try {
    const result = await loadModel(MODEL_ID, {
      backendPreference: ["webgpu"],
      ort,
      wasmPaths: ORT_WASM_PATH,
      wasmNumThreads: Math.min(4, Math.max(1, navigator.hardwareConcurrency || 2)),
      wasmSimd: true,
      tokenizerProvider,
      onProgress: setLoadProgress
    });

    if (!result?.ok) {
      throw new Error(result?.message || "Could not load the local model.");
    }

    setLoadProgress({
      message: "Local model ready",
      pct: 100,
      bytesDownloaded: result.bytesDownloaded
    });

    setReadyState(true, "Local model ready · generation stays on device");
    showToast("Local model ready");
  } catch (error) {
    console.error(error);
    setReadyState(false, "Model load failed");
    els.progressLabel.textContent = error?.message || "Model load failed";
    els.progressFill.classList.remove("indeterminate");
    els.progressFill.style.width = "0%";
    showToast("Could not load local model");
  } finally {
    modelLoading = false;
    if (!modelLoaded) {
      els.loadModelBtn.disabled = false;
      els.loadModelBtn.textContent = "Try model download again";
    }
  }
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
  const startedAt = performance.now();

  try {
    const result = await generateImage({
      model: MODEL_ID,
      prompt: fullPrompt(),
      seed,
      width: 512,
      height: 512,
      signal: currentAbortController.signal,
      onProgress: setGenerationProgress
    });

    if (!result?.ok) {
      if (result?.reason === "cancelled") {
        showToast("Generation cancelled");
        return;
      }
      throw new Error(result?.message || "Local generation failed.");
    }

    clearCurrentImage();

    currentImageBlob = result.blob;
    currentImageUrl = URL.createObjectURL(result.blob);
    els.resultImage.src = currentImageUrl;
    els.resultImage.classList.add("loaded");
    els.imagePlaceholder.hidden = true;

    const elapsedMs = result.timeMs || (performance.now() - startedAt);
    els.resultMeta.textContent = `SD‑Turbo · seed ${seed}`;
    els.resultSubmeta.textContent = `Generated locally in ${(elapsedMs / 1000).toFixed(1)}s · not uploaded`;
    els.resultsSection.hidden = false;
    els.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });

    els.generationFill.style.width = "100%";
    els.generationLabel.textContent = "Complete · image stayed on this device";
  } catch (error) {
    if (currentAbortController?.signal.aborted) {
      showToast("Generation cancelled");
    } else {
      console.error(error);
      showToast(error?.message || "Local generation failed");
      els.generationLabel.textContent = error?.message || "Generation failed";
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
    if (modelLoaded) {
      await unloadModel(MODEL_ID);
    }

    await purgeModelCache(MODEL_ID);
    tokenizerPromise = null;
    setReadyState(false, "Cached model removed");
    els.modelProgress.hidden = true;
    els.progressFill.style.width = "0%";
    showToast("Local model cache removed");
  } catch (error) {
    console.error(error);
    showToast("Could not remove model cache");
  }
}

function clearSession() {
  if (currentAbortController) currentAbortController.abort();

  els.prompt.value = "";
  els.seed.value = "";
  clearCurrentImage();
  els.generationProgress.hidden = true;

  document.querySelectorAll("[data-style]").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.style === "auto");
  });
  activeStyle = "auto";

  showToast("Prompt and image cleared from this tab");
}

async function downloadCurrentImage() {
  if (!currentImageBlob || !currentImageUrl) {
    showToast("Generate an image first");
    return;
  }

  const a = document.createElement("a");
  a.href = currentImageUrl;
  a.download = `suncanvas-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
checkDevice();
