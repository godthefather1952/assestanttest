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

The first time the model is loaded, the browser has to download the open model/runtime files. Those download hosts can observe ordinary network metadata such as the visitor's IP address, just as any website/CDN can.

The prompt itself is **not** part of the model download request and inference happens locally after the files are loaded.

This distinction matters: SunCanvas is designed for private prompts and account-free use, but a public web page cannot truthfully promise that the visitor's IP address is invisible to GitHub Pages, a CDN, or the model file host.

## Local model

The current private engine uses:

- **SD-Turbo**
- 512 × 512 output
- WebGPU acceleration
- Browser-side ONNX Runtime inference
- Seeded generation
- Open model files downloaded once and cached locally

The browser integration talks directly to ONNX Runtime Web. Model/runtime files are downloaded from public model/CDN hosts; no generation request is sent to those hosts.

## Device requirements

WebGPU is preferred. If WebGPU is unavailable, SunCanvas attempts a private CPU/WASM compatibility mode. CPU mode is dramatically slower and may still fail on low-memory devices because the local diffusion model is large.

The initial model download is roughly 2.3 GB.

## Run locally

This project is a static site. Serve the repository over HTTP(S), for example:

```bash
python3 -m http.server 8000
```

Then open:

`http://localhost:8000`

WebGPU generally requires a secure context when not using localhost.

## Deploy

The repository root is designed to be served directly by GitHub Pages.

## License

The SunCanvas application code is MIT licensed. See [LICENSE](./LICENSE).

Third-party libraries and model weights retain their own licenses.

## Acknowledgements

- `web-txt2img` — browser-only text-to-image library
- ONNX Runtime Web
- Transformers.js
- Stability AI SD-Turbo open weights

SunCanvas is not affiliated with or endorsed by OpenAI.
