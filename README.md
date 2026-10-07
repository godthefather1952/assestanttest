# SunCanvas

SunCanvas is a privacy-first, open-source image generator designed to run AI image generation locally in the visitor's browser.

It is an independent project. It does **not** contain, copy, or reproduce OpenAI's proprietary GPT Image weights, training data, source code, or internal model implementation.

## Privacy design

SunCanvas deliberately does not use an image-generation API.

- No API key
- No login or user account
- No application backend
- No prompt upload
- No generated-image upload
- No prompt history in `localStorage`
- No analytics, ad tracker, telemetry SDK, or application database
- Generated images are held as in-memory browser blobs until the user saves them or clears/closes the tab
- Model files are cached locally by the browser so they do not need to be fetched for every generation

### Network boundary

The first time the model is loaded, the browser downloads the open model/runtime files. Those download hosts can observe ordinary network metadata such as the visitor's IP address, just as any website/CDN can.

The prompt itself is **not** part of those downloads. Once the files are available, prompt processing and image generation happen locally.

A public web page cannot truthfully promise that the visitor's IP address is invisible to GitHub Pages, a CDN, or the model file host. SunCanvas instead keeps the sensitive part—the prompt and generated image—out of a remote inference service.

## Local model

The current private engine uses **SDXS-512-0.9 INT8**, a one-step distilled text-to-image model exported for ONNX Runtime.

Browser model bundle:

- INT8 CLIP text encoder: ~342 MB
- INT8 UNet: ~330 MB
- Tiny VAE decoder: ~5 MB
- Total: ~680 MB
- Fixed output: 512 × 512
- Execution: ONNX Runtime Web CPU/WASM
- Seeded local generation

The app intentionally loads the text encoder, UNet, and decoder **sequentially during each generation** and releases each ONNX session before opening the next one. This avoids the previous SD-Turbo design's attempt to allocate a ~1.7 GB single model buffer.

The model files come from `Fcouprie/sdxs-512-texte-image` and the pipeline follows the one-step SDXS reconstruction described by that model's reference implementation.

## Why SDXS replaced SD-Turbo

The previous browser build used an SD-Turbo ONNX export whose text encoder alone required a 1,733,430,199-byte allocation in the WASM heap on some browsers. That can exceed practical browser/WASM memory limits.

SDXS uses separately quantized components and is explicitly published for `onnxruntime-web`/CPU use.

## Device requirements

A modern 64-bit browser with WebAssembly and enough available memory/storage is required.

The initial model download is about 680 MB. The reference model author reports roughly 8–11 seconds per image on CPU in their environment; actual speed varies widely by device and browser.

## Run locally

This project is a static site. Serve the repository over HTTP(S), for example:

```bash
python3 -m http.server 8000
```

Then open:

`http://localhost:8000`

## Deploy

The repository root is designed to be served directly by GitHub Pages.

## License

The SunCanvas application code is MIT licensed. See [LICENSE](./LICENSE).

Third-party libraries and model weights retain their own licenses. The SDXS model repository declares OpenRAIL++ and documents additional provenance/licensing considerations; review its model card before commercial redistribution.

## Acknowledgements

- Fcouprie / SDXS-512 ONNX INT8 export
- IDKiro / SDXS-512-0.9
- ONNX Runtime Web
- Transformers.js
- TAESD

SunCanvas is not affiliated with or endorsed by OpenAI.
