# SunCanvas

SunCanvas is a free, open-source, mobile-friendly AI image generator that runs as a static website.

It was built as an independent alternative to proprietary image-generation interfaces. It **does not contain, copy, or reproduce OpenAI model weights, training data, source code, or the GPT Image model itself**.

## What it does

- Text-to-image generation
- Flux, Z-Image, and Klein model choices through Pollinations
- 1:1, 4:3, 3:4, 16:9, and 9:16 aspect ratios
- Standard and high-detail output sizes
- 1–4 images per prompt
- Style presets
- Prompt enhancement toggle
- Negative-prompt field
- Reproducible seed control
- Safe-mode toggle
- Local generation history
- Mobile-first interface
- No app account or app-side API key

## How generation works

The site is completely static. Your browser sends image requests directly to Pollinations.

Primary endpoint:

`https://gen.pollinations.ai/image/{prompt}`

Legacy fallback:

`https://image.pollinations.ai/prompt/{prompt}`

This keeps the GitHub project lightweight and avoids requiring a paid GPU server. The availability, quotas, model lineup, and terms of the generation provider can change independently of this repository.

## Privacy

This repository has no database and no application server. Recent-generation history is stored in your browser with `localStorage`.

Prompts and generation parameters are sent to Pollinations in order to create images. Review Pollinations' current privacy and usage terms before entering sensitive information.

## Run locally

No build step is required.

```bash
python3 -m http.server 8000
```

Then open:

`http://localhost:8000`

## Deploy

The project is designed for GitHub Pages. Serve the repository root from the `main` branch.

## License

MIT. See [LICENSE](./LICENSE).

## Attribution

Image generation is powered by [Pollinations](https://pollinations.ai/).

SunCanvas is not affiliated with or endorsed by OpenAI.
