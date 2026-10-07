# Sandbox Browser

A remote, disposable Chromium browser designed to keep visited websites separated from the user's normal browser.

## Security controls

- Private access key required before the browser UI can be used.
- Authentication and browser-session identifiers are stored in `HttpOnly`, `Secure`, `SameSite=Strict` cookies.
- Browser sessions expire after 5 minutes of inactivity and have a 30 minute absolute maximum lifetime.
- Each session uses a separate Playwright BrowserContext and is destroyed when the session ends.
- Chromium runs as a non-root `pwuser`.
- Chromium sandboxing is enabled when the host permits it.
- Downloads are denied by the browser context, CDP download policy, and download-event cancellation.
- File upload pickers are cleared.
- Private, local, self-referential, link-local, reserved, and other non-public destinations are blocked.
- HTTP/HTTPS and WS/WSS are restricted to ports 80 and 443.
- WebSocket destinations are validated before the remote connection is made.
- Service workers are disabled.
- Popups are collapsed back into the main remote tab.
- Strict CSP, HSTS, clickjacking protection, restrictive Permissions Policy, and no-referrer policy are applied to the controller UI.
- API and login rate limits reduce abuse.
- An **End session** button destroys the remote browser context immediately.
- An explicit **Sign out** control clears controller authentication.

## Important boundary

This is stronger isolation than an iframe browser, but it is not equivalent to a disposable virtual machine per website. The remote Chromium process still runs on the same service instance as the controller server.

The app also performs DNS/IP filtering before remote requests, but application-layer hostname checks are not a substitute for an infrastructure-level outbound firewall. For higher-assurance deployments, put Chromium workers in separate disposable containers or VMs with enforced egress rules.

## Deployment

The live Render deployment uses Docker and the pinned Playwright image matching the package version.

Required environment variables:

- `BROWSER_ACCESS_KEY` — private key required to enter the browser
- `MAX_SESSIONS` — maximum concurrent browser contexts
- `SESSION_IDLE_MS` — inactivity timeout
- `SESSION_MAX_MS` — absolute browser-session lifetime
- `APP_PUBLIC_HOST` — deployment hostname blocked from being browsed recursively
- `CHROMIUM_SANDBOX` — `true` when the host supports Chromium's sandbox

## Local run

```bash
docker build -t sandbox-browser .
docker run --rm -p 10000:10000 \
  -e BROWSER_ACCESS_KEY='replace-this-with-a-long-random-key' \
  -e CHROMIUM_SANDBOX=true \
  sandbox-browser
```

Open `http://localhost:10000`.
