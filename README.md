# Sandbox Browser

This repository is now a dedicated **remote sandboxed web browser**.

When the deployed site opens, the page itself is the browser UI. Websites run inside an isolated headless Chromium context on the server and are rendered back to the visitor as screenshots. Clicks, scrolling, navigation, and typing are relayed to that remote browser.

## Security model

- Each visitor session gets its own Chromium browser context.
- Remote website code does **not** run directly in the visitor's browser.
- File downloads are disabled with Playwright's `acceptDownloads: false` and download events are cancelled.
- Private, local, link-local, reserved, and other non-public network destinations are blocked to reduce SSRF/internal-network access.
- Only HTTP/HTTPS on ports 80 and 443 are allowed.
- Service workers are blocked.
- Browser sessions expire after inactivity.
- Popups are folded back into the current remote tab instead of opening uncontrolled local windows.
- Camera, microphone, geolocation, USB, and payment permissions are disabled for the app UI.

## Important boundary

This is a **remote browser**, not an anonymity service. Remote websites see the deployment server's network identity. The server receives the navigation and input commands needed to operate the remote page, so do not use a deployment you do not trust for sensitive credentials.

The user receives page images, not remote response bodies or downloaded files.

## Run locally

You need Docker because the app requires Chromium.

```bash
docker build -t sandbox-browser .
docker run --rm -p 10000:10000 sandbox-browser
```

Then open:

```
http://localhost:10000
```

## Deploy

This is **not a GitHub Pages app**. GitHub Pages cannot run the Chromium backend.

A `render.yaml` and `Dockerfile` are included for a Render Docker deployment. Other Docker-capable hosts can also run it.

## Environment variables

- `PORT` — HTTP port, defaults to `10000`
- `MAX_SESSIONS` — maximum concurrent isolated browser sessions, defaults to `8`
- `SESSION_IDLE_MS` — inactive-session lifetime, defaults to 15 minutes

## Current interaction model

The remote viewport supports:

- address/search navigation
- back / forward / reload / home
- mouse or touch clicking
- wheel or touch scrolling
- keyboard entry
- an on-screen mobile typing dock
- responsive viewport resizing
- automatic download cancellation
