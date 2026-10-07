import express from "express";
import { chromium } from "playwright";
import dns from "node:dns/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ipaddr from "ipaddr.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 10000);
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 2));
const SESSION_IDLE_MS = Math.max(60_000, Number(process.env.SESSION_IDLE_MS || 5 * 60_000));
const SESSION_MAX_MS = Math.max(5 * 60_000, Number(process.env.SESSION_MAX_MS || 30 * 60_000));
const ACCESS_KEY = String(process.env.BROWSER_ACCESS_KEY || "");
const APP_PUBLIC_HOST = String(process.env.APP_PUBLIC_HOST || "").toLowerCase();
const USE_CHROMIUM_SANDBOX = String(process.env.CHROMIUM_SANDBOX || "true").toLowerCase() !== "false";
const IS_PROD = process.env.NODE_ENV === "production";
const HOST_CACHE_MS = 10_000;

if (IS_PROD && ACCESS_KEY.length < 16) {
  throw new Error("BROWSER_ACCESS_KEY must be set to at least 16 characters in production");
}

const sessions = new Map();
const hostCache = new Map();
const rateBuckets = new Map();

const launchArgs = [
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-extensions",
  "--disable-sync",
  "--no-first-run",
  "--no-default-browser-check"
];
if (!USE_CHROMIUM_SANDBOX) launchArgs.push("--no-sandbox");

const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: USE_CHROMIUM_SANDBOX,
  args: launchArgs
});

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function cookieLine(name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict"
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (IS_PROD) parts.push("Secure");
  if (typeof maxAge === "number") parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join("; ");
}

function clearCookie(res, name) {
  res.append("Set-Cookie", cookieLine(name, "", { maxAge: 0 }));
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

const authToken = ACCESS_KEY
  ? crypto.createHmac("sha256", ACCESS_KEY).update("sandbox-browser-auth-v1").digest("base64url")
  : "";

function isAuthenticated(req) {
  if (!ACCESS_KEY && !IS_PROD) return true;
  const token = parseCookies(req).sb_auth || "";
  return safeEqual(token, authToken);
}

function clientKey(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function takeRate(key, max, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function rateLimit(max, windowMs, label) {
  return (req, res, next) => {
    const key = `${label}:${clientKey(req)}`;
    if (!takeRate(key, max, windowMs)) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

function sameOriginOnly(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next();
  const expectedHttps = `https://${req.get("host")}`;
  const expectedHttp = `http://${req.get("host")}`;
  if (origin === expectedHttps || (!IS_PROD && origin === expectedHttp)) return next();
  return res.status(403).json({ error: "Cross-origin request blocked" });
}

app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "8kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=(), browsing-topics=(), interest-cohort=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (IS_PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.path.startsWith("/api/") || req.path === "/login") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

function renderLogin(error = "") {
  const message = error ? '<p class="error">Access key not accepted.</p>' : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111318">
<title>Sandbox Browser Access</title>
<link rel="stylesheet" href="/login.css">
</head>
<body>
<main class="login-card">
<div class="mark">◎</div>
<h1>Sandbox Browser</h1>
<p class="copy">Enter the private access key to open the remote browser.</p>
${message}
<form method="post" action="/login" autocomplete="off">
<label for="accessKey">Access key</label>
<input id="accessKey" name="accessKey" type="password" required autofocus autocomplete="current-password">
<button type="submit">Open browser</button>
</form>
<p class="note">The browser session itself is isolated and disposable.</p>
</main>
</body>
</html>`;
}

app.get("/login.css", (_req, res) => {
  res.type("text/css").send(`
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0b0d11;color:#f2f4f7;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}.login-card{width:min(440px,100%);background:#14171d;border:1px solid #2c323c;border-radius:20px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.35)}.mark{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;background:#20242d;border:1px solid #343b46;font-size:26px;margin-bottom:18px}h1{margin:0 0 8px;font-size:30px;letter-spacing:-.03em}.copy,.note{color:#9ba5b3;line-height:1.5}.error{color:#ffb4a8;background:#2a1717;border:1px solid #5a2b2b;border-radius:10px;padding:9px 11px}label{display:block;font-size:13px;color:#b8c0cb;margin:18px 0 7px}input{width:100%;height:46px;border-radius:11px;border:1px solid #353d48;background:#0d1015;color:#fff;padding:0 12px;outline:none}input:focus{border-color:#667184}button{width:100%;height:46px;border:0;border-radius:11px;background:#eef1f5;color:#111;font-weight:800;margin-top:12px;cursor:pointer}.note{font-size:12px;margin:18px 0 0}
  `);
});

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) return res.redirect("/");
  res.type("html").send(renderLogin());
});

app.post("/login", rateLimit(5, 15 * 60_000, "login"), (req, res) => {
  const candidate = String(req.body?.accessKey || "");
  if (!ACCESS_KEY || !safeEqual(candidate, ACCESS_KEY)) {
    return res.status(401).type("html").send(renderLogin("invalid"));
  }
  res.append("Set-Cookie", cookieLine("sb_auth", authToken, { maxAge: 7 * 24 * 60 * 60 }));
  res.redirect("/");
});

app.post("/logout", sameOriginOnly, (req, res) => {
  clearCookie(res, "sb_auth");
  clearCookie(res, "sb_session");
  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Authentication required" });
  res.redirect("/login");
});

app.use("/api/", rateLimit(420, 60_000, "api"));
app.use("/api/", sameOriginOnly);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

function validSessionId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{32,120}$/.test(id);
}

function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

function hostnameBlocked(hostname) {
  const key = hostname.toLowerCase().replace(/\.$/, "");
  if (!key) return true;
  if (APP_PUBLIC_HOST && key === APP_PUBLIC_HOST) return true;
  if ([
    "localhost",
    "metadata.google.internal",
    "metadata.google.com",
    "instance-data.ec2.internal"
  ].includes(key)) return true;
  return [
    ".localhost",
    ".local",
    ".internal",
    ".home",
    ".lan",
    ".corp"
  ].some(suffix => key.endsWith(suffix));
}

async function hostIsPublic(hostname) {
  const key = hostname.toLowerCase().replace(/\.$/, "");
  const now = Date.now();
  const cached = hostCache.get(key);
  if (cached && cached.expires > now) return cached.ok;

  if (hostnameBlocked(key)) {
    hostCache.set(key, { ok: false, expires: now + HOST_CACHE_MS });
    return false;
  }

  let addresses = [];
  if (ipaddr.isValid(key)) {
    addresses = [{ address: key }];
  } else {
    try {
      addresses = await dns.lookup(key, { all: true, verbatim: true });
    } catch {
      hostCache.set(key, { ok: false, expires: now + 2_000 });
      return false;
    }
  }

  const ok = addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  hostCache.set(key, { ok, expires: now + HOST_CACHE_MS });
  return ok;
}

async function validateRemoteUrl(raw, allowedProtocols = ["http:", "https:"]) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error("Blocked URL scheme");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are blocked");
  }

  const isSecure = url.protocol === "https:" || url.protocol === "wss:";
  const effectivePort = url.port || (isSecure ? "443" : "80");
  if (!["80", "443"].includes(effectivePort)) {
    throw new Error("Only standard web ports 80 and 443 are allowed");
  }

  if (!(await hostIsPublic(url.hostname))) {
    throw new Error("Private, local, self-referential, or non-public network address blocked");
  }

  return url.href;
}

function normalizeNavigation(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("Only HTTP and HTTPS addresses are allowed");
  if (value.includes(".") && !/\s/.test(value) && !value.startsWith("/") && !value.startsWith(".")) {
    return `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function homeHtml() {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox Browser</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0e1014;color:#f4f6f8;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{width:min(720px,88vw);text-align:center}.mark{width:68px;height:68px;border-radius:20px;margin:0 auto 22px;display:grid;place-items:center;background:#1b1f27;border:1px solid #313846;font-size:30px}h1{font-size:clamp(28px,6vw,48px);margin:0 0 10px;letter-spacing:-.04em}p{color:#9aa4b2;margin:0 auto 26px;max-width:520px;line-height:1.5}form{display:flex;gap:8px;background:#171b22;border:1px solid #303744;border-radius:16px;padding:8px}input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#fff;font:inherit;padding:10px}button{border:0;border-radius:11px;padding:0 18px;font-weight:700;background:#f2f4f7;color:#111}small{display:block;color:#707b89;margin-top:18px}
</style>
</head>
<body>
<main>
<div class="mark">◎</div>
<h1>Sandbox Browser</h1>
<p>Browse inside an isolated remote session. Downloads, private-network access, and unsafe URL schemes are blocked.</p>
<form action="https://www.google.com/search" method="get">
<input name="q" autocomplete="off" placeholder="Search the web">
<button>Search</button>
</form>
<small>Remote sites run inside disposable server-side Chromium.</small>
</main>
</body>
</html>`;
}

function setNotice(session, text) {
  session.notice = text;
  session.noticeAt = Date.now();
}

function touchSession(session) {
  session.lastActive = Date.now();
}

function isExpired(session) {
  const now = Date.now();
  return now - session.lastActive > SESSION_IDLE_MS || now - session.createdAt > SESSION_MAX_MS;
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try { await session.context.close(); } catch {}
}

async function makeRoomForSession() {
  if (sessions.size < MAX_SESSIONS) return;
  const oldest = [...sessions.values()].sort((a, b) => a.lastActive - b.lastActive)[0];
  if (oldest) await closeSession(oldest.id);
}

async function hardenPage(session, page) {
  const cdp = await session.context.newCDPSession(page).catch(() => null);
  if (cdp) {
    await cdp.send("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  }

  page.on("download", async download => {
    setNotice(session, "Download blocked");
    try { await download.cancel(); } catch {}
  });

  page.on("filechooser", async chooser => {
    setNotice(session, "File upload blocked");
    try { await chooser.setFiles([]); } catch {}
  });

  page.on("dialog", async dialog => {
    setNotice(session, `Dialog dismissed: ${dialog.type()}`);
    try { await dialog.dismiss(); } catch {}
  });

  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) touchSession(session);
  });

  page.on("crash", () => setNotice(session, "Remote page crashed. Reload or navigate elsewhere."));
}

async function setHome(session) {
  await session.page.goto("about:blank");
  await session.page.setContent(homeHtml(), { waitUntil: "domcontentloaded" });
  session.isHome = true;
  touchSession(session);
}

async function createSession(id, viewport = {}) {
  await makeRoomForSession();

  const width = clamp(viewport.width, 320, 1920);
  const height = clamp(viewport.height, 420, 1400);

  const context = await browser.newContext({
    viewport: { width, height },
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    serviceWorkers: "block"
  });

  const session = {
    id,
    context,
    page: null,
    createdAt: Date.now(),
    lastActive: Date.now(),
    notice: "",
    noticeAt: 0,
    isHome: true
  };
  sessions.set(id, session);

  await context.route("**/*", async route => {
    const requestUrl = route.request().url();
    let parsed;
    try { parsed = new URL(requestUrl); } catch { return route.abort("blockedbyclient"); }

    if (["about:", "blob:", "data:"].includes(parsed.protocol)) return route.continue();
    if (!["http:", "https:"].includes(parsed.protocol)) {
      setNotice(session, "Blocked unsafe URL scheme");
      return route.abort("blockedbyclient");
    }

    try {
      await validateRemoteUrl(requestUrl);
      return route.continue();
    } catch {
      setNotice(session, "Blocked a private or unsafe network request");
      return route.abort("blockedbyclient");
    }
  });

  await context.routeWebSocket("**", async ws => {
    try {
      const safeUrl = await validateRemoteUrl(ws.url(), ["ws:", "wss:"]);
      if (!safeUrl) throw new Error("Blocked");
      const server = ws.connectToServer();
      ws.onMessage(message => server.send(message));
      server.onMessage(message => ws.send(message));
      ws.onClose(() => { try { server.close(); } catch {} });
      server.onClose(() => { try { ws.close(); } catch {} });
    } catch {
      setNotice(session, "Blocked unsafe WebSocket");
      try { ws.close({ code: 1008, reason: "Blocked by sandbox" }); } catch {}
    }
  });

  const page = await context.newPage();
  session.page = page;
  await hardenPage(session, page);

  context.on("page", async popup => {
    if (popup === session.page) return;
    try {
      await hardenPage(session, popup);
      await popup.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => {});
      const target = popup.url();
      await popup.close().catch(() => {});
      if (/^https?:/i.test(target)) {
        const safe = await validateRemoteUrl(target);
        await session.page.goto(safe, { waitUntil: "domcontentloaded", timeout: 20_000 });
        session.isHome = false;
      } else {
        setNotice(session, "Popup blocked");
      }
    } catch {
      await popup.close().catch(() => {});
      setNotice(session, "Popup blocked");
    }
  });

  await setHome(session);
  return session;
}

function getSessionId(req) {
  return parseCookies(req).sb_session || "";
}

async function getSession(req, res, { touch = false } = {}) {
  const id = getSessionId(req);
  if (!validSessionId(id)) {
    res.status(404).json({ error: "Session expired" });
    return null;
  }
  const session = sessions.get(id);
  if (!session || isExpired(session)) {
    if (session) await closeSession(id);
    clearCookie(res, "sb_session");
    res.status(404).json({ error: "Session expired" });
    return null;
  }
  if (touch) touchSession(session);
  return session;
}

app.post("/api/session", rateLimit(20, 10 * 60_000, "session-create"), async (req, res) => {
  try {
    let id = getSessionId(req);
    let session = validSessionId(id) ? sessions.get(id) : null;

    if (session && isExpired(session)) {
      await closeSession(id);
      session = null;
    }

    if (!session) {
      id = crypto.randomBytes(32).toString("base64url");
      session = await createSession(id, req.body?.viewport || {});
      res.append("Set-Cookie", cookieLine("sb_session", id, { maxAge: Math.ceil(SESSION_MAX_MS / 1000) }));
    }

    touchSession(session);
    res.json({ ok: true, idleTimeoutMs: SESSION_IDLE_MS, maxLifetimeMs: SESSION_MAX_MS });
  } catch (error) {
    console.error("session error", error);
    res.status(500).json({ error: "Could not create browser session" });
  }
});

app.get("/api/state", async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  try {
    const title = await session.page.title().catch(() => "");
    const rawUrl = session.isHome ? "sandbox://home" : session.page.url();
    const notice = Date.now() - session.noticeAt < 5000 ? session.notice : "";
    const editables = await session.page.evaluate(() => {
      const selector = 'input:not([type="hidden"]), textarea, [contenteditable]:not([contenteditable="false"])';
      const items = [];

      for (const el of document.querySelectorAll(selector)) {
        if (items.length >= 120) break;
        if (el.disabled || el.readOnly) continue;

        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        if (
          rect.width < 4 ||
          rect.height < 4 ||
          rect.right < 0 ||
          rect.bottom < 0 ||
          rect.left > innerWidth ||
          rect.top > innerHeight ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) continue;

        let inputMode = el.inputMode || "";
        const type = (el.getAttribute("type") || "").toLowerCase();

        if (!inputMode) {
          if (type === "email") inputMode = "email";
          else if (type === "url") inputMode = "url";
          else if (type === "tel") inputMode = "tel";
          else if (type === "number") inputMode = "decimal";
          else if (type === "search") inputMode = "search";
          else inputMode = "text";
        }

        items.push({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          inputMode,
          enterKeyHint: el.enterKeyHint || "",
          kind: tagNameFor(el),
          type
        });

        function tagNameFor(node) {
          if (node.tagName?.toLowerCase() === "textarea") return "textarea";
          if (node.isContentEditable) return "textarea";
          return "input";
        }
      }

      return items;
    }).catch(() => []);

    res.json({
      url: rawUrl,
      title,
      notice,
      editables,
      expiresInMs: Math.max(0, Math.min(
        SESSION_IDLE_MS - (Date.now() - session.lastActive),
        SESSION_MAX_MS - (Date.now() - session.createdAt)
      ))
    });
  } catch {
    res.status(500).json({ error: "Could not read browser state" });
  }
});

app.get("/api/screenshot", async (req, res) => {
  const session = await getSession(req, res);
  if (!session) return;
  try {
    const image = await session.page.screenshot({
      type: "jpeg",
      quality: 70,
      fullPage: false,
      timeout: 8000
    });
    res.type("jpeg");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.send(image);
  } catch {
    res.status(503).json({ error: "Page is busy" });
  }
});

app.post("/api/navigate", rateLimit(60, 60_000, "navigate"), async (req, res) => {
  const session = await getSession(req, res, { touch: true });
  if (!session) return;
  try {
    const normalized = normalizeNavigation(req.body?.target);
    if (!normalized) {
      await setHome(session);
      return res.json({ ok: true, url: "sandbox://home" });
    }
    const safe = await validateRemoteUrl(normalized);
    await session.page.goto(safe, { waitUntil: "domcontentloaded", timeout: 25_000 });
    session.isHome = false;
    res.json({ ok: true, url: session.page.url() });
  } catch (error) {
    setNotice(session, error.message || "Navigation failed");
    res.status(400).json({ error: error.message || "Navigation failed" });
  }
});

for (const [routeName, action] of [
  ["home", async s => setHome(s)],
  ["back", async s => { await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null); s.isHome = false; }],
  ["forward", async s => { await s.page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null); s.isHome = false; }],
  ["reload", async s => { if (s.isHome) await setHome(s); else await s.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }); }]
]) {
  app.post(`/api/${routeName}`, async (req, res) => {
    const session = await getSession(req, res, { touch: true });
    if (!session) return;
    try {
      await action(session);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: `${routeName} failed` });
    }
  });
}

app.post("/api/click", async (req, res) => {
  const session = await getSession(req, res, { touch: true });
  if (!session) return;
  const x = clamp(req.body?.x, 0, 4000);
  const y = clamp(req.body?.y, 0, 4000);
  try {
    await session.page.mouse.click(x, y);
    await session.page.waitForTimeout(80);
    const editableInfo = await session.page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;

      const tag = el.tagName?.toLowerCase();
      const editable = tag === "input" || tag === "textarea" || el.isContentEditable;
      if (!editable || el.disabled || el.readOnly) return null;

      let inputMode = el.inputMode || "";
      const type = (el.getAttribute?.("type") || "").toLowerCase();

      if (!inputMode) {
        if (type === "email") inputMode = "email";
        else if (type === "url") inputMode = "url";
        else if (type === "tel") inputMode = "tel";
        else if (type === "number") inputMode = "decimal";
        else if (type === "search") inputMode = "search";
        else inputMode = "text";
      }

      return {
        inputMode,
        enterKeyHint: el.enterKeyHint || ""
      };
    }).catch(() => null);

    session.isHome = false;
    res.json({
      ok: true,
      editable: Boolean(editableInfo),
      inputMode: editableInfo?.inputMode || "",
      enterKeyHint: editableInfo?.enterKeyHint || ""
    });
  } catch {
    res.status(500).json({ error: "Click failed" });
  }
});

app.post("/api/scroll", async (req, res) => {
  const session = await getSession(req, res, { touch: true });
  if (!session) return;
  try {
    const dx = clamp(Math.abs(req.body?.dx), 0, 2000) * Math.sign(Number(req.body?.dx) || 0);
    const dy = clamp(Math.abs(req.body?.dy), 0, 2000) * Math.sign(Number(req.body?.dy) || 0);
    await session.page.mouse.wheel(dx, dy);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Scroll failed" });
  }
});

app.post("/api/type", async (req, res) => {
  const session = await getSession(req, res, { touch: true });
  if (!session) return;
  const text = String(req.body?.text || "").slice(0, 2000);
  try {
    if (text) await session.page.keyboard.type(text, { delay: 8 });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Typing failed" });
  }
});

app.post("/api/key", async (req, res) => {
  const session = await getSession(req, res, { touch: true });
  if (!session) return;
  const key = String(req.body?.key || "");
  const allowed = new Set([
    "Enter","Backspace","Tab","Escape","Delete",
    "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
    "Home","End","PageUp","PageDown"
  ]);
  if (!allowed.has(key)) return res.status(400).json({ error: "Key not allowed" });
  try {
    await session.page.keyboard.press(key);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Key press failed" });
  }
});

app.post("/api/viewport", async (req, res) => {
  const session = await getSession(req, res, { touch: true });
  if (!session) return;
  try {
    const width = clamp(req.body?.width, 320, 1920);
    const height = clamp(req.body?.height, 420, 1400);
    await session.page.setViewportSize({ width, height });
    res.json({ ok: true, width, height });
  } catch {
    res.status(500).json({ error: "Viewport update failed" });
  }
});

app.delete("/api/session", async (req, res) => {
  const id = getSessionId(req);
  if (validSessionId(id)) await closeSession(id);
  clearCookie(res, "sb_session");
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: IS_PROD ? "1h" : 0,
  index: "index.html"
}));

setInterval(async () => {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (isExpired(session)) await closeSession(session.id);
  }
  for (const [key, value] of rateBuckets) {
    if (value.resetAt <= now) rateBuckets.delete(key);
  }
  for (const [key, value] of hostCache) {
    if (value.expires <= now) hostCache.delete(key);
  }
}, 30_000).unref();

async function shutdown() {
  for (const id of [...sessions.keys()]) await closeSession(id);
  await browser.close().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sandbox Browser listening on port ${PORT}; chromiumSandbox=${USE_CHROMIUM_SANDBOX}`);
});
