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

const PORT = Number(process.env.PORT || 10000);
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 8));
const SESSION_IDLE_MS = Math.max(60_000, Number(process.env.SESSION_IDLE_MS || 15 * 60_000));
const HOST_CACHE_MS = 5 * 60_000;
const sessions = new Map();
const hostCache = new Map();

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--no-sandbox"]
});

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=()");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

function validSessionId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{20,100}$/.test(id);
}

function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

async function hostIsPublic(hostname) {
  const key = hostname.toLowerCase();
  const now = Date.now();
  const cached = hostCache.get(key);
  if (cached && cached.expires > now) return cached.ok;

  if (
    key === "localhost" ||
    key.endsWith(".localhost") ||
    key.endsWith(".local") ||
    key.endsWith(".internal") ||
    key.endsWith(".home")
  ) {
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
      hostCache.set(key, { ok: false, expires: now + 30_000 });
      return false;
    }
  }

  const ok = addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  hostCache.set(key, { ok, expires: now + HOST_CACHE_MS });
  return ok;
}

async function validateRemoteUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are blocked");
  }

  const effectivePort = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!["80", "443"].includes(effectivePort)) {
    throw new Error("Only standard web ports 80 and 443 are allowed");
  }

  if (!(await hostIsPublic(url.hostname))) {
    throw new Error("Private, local, or non-public network addresses are blocked");
  }

  return url.href;
}

function normalizeNavigation(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) return value;

  if (
    value.includes(".") &&
    !/\s/.test(value) &&
    !value.startsWith("/") &&
    !value.startsWith(".")
  ) {
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
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#0e1014;color:#f4f6f8;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
  main{width:min(720px,88vw);text-align:center}
  .mark{width:68px;height:68px;border-radius:20px;margin:0 auto 22px;display:grid;place-items:center;background:#1b1f27;border:1px solid #313846;font-size:30px}
  h1{font-size:clamp(28px,6vw,48px);margin:0 0 10px;letter-spacing:-.04em}
  p{color:#9aa4b2;margin:0 auto 26px;max-width:520px;line-height:1.5}
  form{display:flex;gap:8px;background:#171b22;border:1px solid #303744;border-radius:16px;padding:8px}
  input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#fff;font:inherit;padding:10px}
  button{border:0;border-radius:11px;padding:0 18px;font-weight:700;background:#f2f4f7;color:#111}
  small{display:block;color:#707b89;margin-top:18px}
</style>
</head>
<body>
<main>
  <div class="mark">◎</div>
  <h1>Sandbox Browser</h1>
  <p>Browse inside an isolated remote session. Downloads and private-network access are disabled.</p>
  <form action="https://www.google.com/search" method="get">
    <input name="q" autocomplete="off" placeholder="Search the web">
    <button>Search</button>
  </form>
  <small>Remote sites run on the server, not inside this page.</small>
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

async function attachPageHandlers(session) {
  const page = session.page;

  page.on("download", async (download) => {
    setNotice(session, "Download blocked");
    try {
      await download.cancel();
    } catch {}
  });

  page.on("dialog", async (dialog) => {
    setNotice(session, `Dialog dismissed: ${dialog.type()}`);
    try {
      await dialog.dismiss();
    } catch {}
  });

  page.on("framenavigated", (frame) => {
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

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    await session.context.close();
  } catch {}
}

async function makeRoomForSession() {
  if (sessions.size < MAX_SESSIONS) return;
  const oldest = [...sessions.values()].sort((a, b) => a.lastActive - b.lastActive)[0];
  if (oldest) await closeSession(oldest.id);
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

  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (!/^https?:/i.test(requestUrl)) {
      return route.continue();
    }

    try {
      await validateRemoteUrl(requestUrl);
      return route.continue();
    } catch {
      setNotice(session, "Blocked a request to a private or unsafe network address");
      return route.abort("blockedbyclient");
    }
  });

  const page = await context.newPage();
  session.page = page;
  await attachPageHandlers(session);

  context.on("page", async (popup) => {
    if (popup === session.page) return;

    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => {});
      const target = popup.url();
      await popup.close().catch(() => {});
      if (/^https?:/i.test(target)) {
        const safe = await validateRemoteUrl(target);
        await session.page.goto(safe, { waitUntil: "domcontentloaded", timeout: 20_000 });
        session.isHome = false;
      }
    } catch {
      await popup.close().catch(() => {});
      setNotice(session, "Popup blocked");
    }
  });

  await setHome(session);
  return session;
}

function getId(req) {
  return req.get("x-session-id") || req.body?.sessionId || req.query?.sessionId || "";
}

function getSession(req, res) {
  const id = getId(req);
  if (!validSessionId(id)) {
    res.status(400).json({ error: "Invalid session" });
    return null;
  }

  const session = sessions.get(id);
  if (!session) {
    res.status(404).json({ error: "Session expired" });
    return null;
  }

  touchSession(session);
  return session;
}

app.post("/api/session", async (req, res) => {
  const id = getId(req);
  if (!validSessionId(id)) {
    return res.status(400).json({ error: "Invalid session" });
  }

  try {
    let session = sessions.get(id);
    if (!session) session = await createSession(id, req.body?.viewport || {});
    touchSession(session);
    res.json({ ok: true });
  } catch (error) {
    console.error("session error", error);
    res.status(500).json({ error: "Could not create browser session" });
  }
});

app.get("/api/state", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  try {
    const title = await session.page.title().catch(() => "");
    const rawUrl = session.isHome ? "sandbox://home" : session.page.url();
    const notice = Date.now() - session.noticeAt < 5000 ? session.notice : "";
    res.json({ url: rawUrl, title, notice });
  } catch {
    res.status(500).json({ error: "Could not read browser state" });
  }
});

app.get("/api/screenshot", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  try {
    const image = await session.page.screenshot({
      type: "jpeg",
      quality: 72,
      fullPage: false,
      timeout: 8000
    });
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.send(image);
  } catch {
    res.status(503).json({ error: "Page is busy" });
  }
});

app.post("/api/navigate", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  try {
    const normalized = normalizeNavigation(req.body?.target);
    if (!normalized) {
      await setHome(session);
      return res.json({ ok: true, url: "sandbox://home" });
    }

    const safe = await validateRemoteUrl(normalized);
    await session.page.goto(safe, {
      waitUntil: "domcontentloaded",
      timeout: 25_000
    });
    session.isHome = false;
    res.json({ ok: true, url: session.page.url() });
  } catch (error) {
    setNotice(session, error.message || "Navigation failed");
    res.status(400).json({ error: error.message || "Navigation failed" });
  }
});

app.post("/api/home", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  try {
    await setHome(session);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not open home page" });
  }
});

app.post("/api/back", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  try {
    const response = await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    if (!response && session.page.url() === "about:blank") session.isHome = true;
    else session.isHome = false;
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Back navigation failed" });
  }
});

app.post("/api/forward", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  try {
    await session.page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    session.isHome = false;
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Forward navigation failed" });
  }
});

app.post("/api/reload", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  try {
    if (session.isHome) await setHome(session);
    else await session.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Reload failed" });
  }
});

app.post("/api/click", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const x = clamp(req.body?.x, 0, 4000);
  const y = clamp(req.body?.y, 0, 4000);

  try {
    await session.page.mouse.click(x, y);
    await session.page.waitForTimeout(80);
    const editable = await session.page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    }).catch(() => false);
    session.isHome = false;
    res.json({ ok: true, editable });
  } catch {
    res.status(500).json({ error: "Click failed" });
  }
});

app.post("/api/scroll", async (req, res) => {
  const session = getSession(req, res);
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
  const session = getSession(req, res);
  if (!session) return;

  const text = String(req.body?.text || "").slice(0, 4000);
  try {
    if (text) await session.page.keyboard.type(text, { delay: 10 });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Typing failed" });
  }
});

app.post("/api/key", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const key = String(req.body?.key || "");
  const allowed = new Set([
    "Enter", "Backspace", "Tab", "Escape", "Delete",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown"
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
  const session = getSession(req, res);
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
  const id = getId(req);
  if (validSessionId(id)) await closeSession(id);
  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

setInterval(async () => {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (now - session.lastActive > SESSION_IDLE_MS) {
      await closeSession(session.id);
    }
  }
}, 60_000).unref();

async function shutdown() {
  for (const id of [...sessions.keys()]) await closeSession(id);
  await browser.close().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sandbox Browser listening on port ${PORT}`);
});
