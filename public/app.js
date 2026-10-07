(() => {
  const els = {
    stage: document.getElementById("stage"),
    screen: document.getElementById("screen"),
    loading: document.getElementById("loading"),
    address: document.getElementById("address"),
    navForm: document.getElementById("navForm"),
    pageTitle: document.getElementById("pageTitle"),
    status: document.getElementById("status"),
    notice: document.getElementById("notice"),
    keyboardBridge: document.getElementById("keyboardBridge"),
    endSessionBtn: document.getElementById("endSessionBtn"),
    signOutBtn: document.getElementById("signOutBtn")
  };

  const BRIDGE_SENTINEL = "\u200B";
  const isTouchDevice = navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;

  let ready = false;
  let busy = false;
  let objectUrl = "";
  let lastStateUrl = "";
  let noticeTimer = 0;
  let touchStart = null;
  let lastTouch = null;
  let resizeTimer = 0;
  let screenTimer = 0;
  let stateTimer = 0;
  let editableRegions = [];
  let composing = false;
  let suppressClickUntil = 0;
  let inputQueue = Promise.resolve();

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    if (response.status === 401) {
      location.href = "/login";
      throw new Error("Authentication required");
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function viewportSize() {
    const rect = els.stage.getBoundingClientRect();
    return {
      width: Math.max(320, Math.round(rect.width)),
      height: Math.max(420, Math.round(rect.height))
    };
  }

  async function startSession() {
    els.loading.classList.remove("hidden");
    els.loading.querySelector("span").textContent = "Starting isolated browser…";
    els.status.textContent = "Starting hardened Chromium session…";

    await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ viewport: viewportSize() })
    });

    ready = true;
    els.status.textContent = "Protected remote browser connected";
    await updateState();
    scheduleScreen(0);
  }

  function showNotice(message) {
    if (!message) return;
    clearTimeout(noticeTimer);
    els.notice.textContent = message;
    els.notice.classList.add("show");
    noticeTimer = setTimeout(() => els.notice.classList.remove("show"), 2600);
  }

  async function updateState() {
    if (!ready) return;
    try {
      const state = await api("/api/state");
      els.pageTitle.textContent = state.title || "Sandbox Browser";
      document.title = state.title ? state.title + " · Sandbox Browser" : "Sandbox Browser";
      editableRegions = Array.isArray(state.editables) ? state.editables : [];

      if (document.activeElement !== els.address && state.url && state.url !== lastStateUrl) {
        els.address.value = state.url === "sandbox://home" ? "" : state.url;
        lastStateUrl = state.url;
      }

      if (state.notice) showNotice(state.notice);
      if (typeof state.expiresInMs === "number") {
        const mins = Math.max(0, Math.ceil(state.expiresInMs / 60000));
        els.status.textContent = `Protected remote browser · session expires in ~${mins}m`;
      }
    } catch (error) {
      if (/Session expired/i.test(error.message)) {
        ready = false;
        await startSession().catch(() => {});
      }
    }
  }

  function scheduleScreen(delay = 650) {
    clearTimeout(screenTimer);
    screenTimer = setTimeout(refreshScreen, delay);
  }

  async function refreshScreen() {
    if (!ready) return;
    try {
      const response = await fetch("/api/screenshot?t=" + Date.now(), {
        credentials: "same-origin",
        cache: "no-store"
      });

      if (response.status === 401) {
        location.href = "/login";
        return;
      }
      if (response.status === 404) {
        ready = false;
        await startSession();
        return;
      }

      if (response.ok) {
        const blob = await response.blob();
        const next = URL.createObjectURL(blob);
        els.screen.onload = () => {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          els.screen.classList.add("ready");
          els.loading.classList.add("hidden");
        };
        els.screen.src = next;
      }
    } catch {}
    scheduleScreen();
  }

  async function action(path, body) {
    if (!ready || busy) return;
    busy = true;
    try {
      await api(path, {
        method: "POST",
        body: JSON.stringify(body || {})
      });
      setTimeout(updateState, 120);
    } catch (error) {
      showNotice(error.message);
    } finally {
      busy = false;
    }
  }

  function queueRemote(path, body) {
    inputQueue = inputQueue.then(async () => {
      if (!ready) return;
      await api(path, {
        method: "POST",
        body: JSON.stringify(body || {})
      });
    }).catch(error => {
      showNotice(error.message);
    });
    return inputQueue;
  }

  function queueText(text) {
    const parts = String(text || "").replace(/\r/g, "").split("\n");
    parts.forEach((part, index) => {
      if (part) queueRemote("/api/type", { text: part });
      if (index < parts.length - 1) queueRemote("/api/key", { key: "Enter" });
    });
  }

  els.navForm.addEventListener("submit", async event => {
    event.preventDefault();
    els.keyboardBridge.blur();

    if (!ready) await startSession().catch(error => showNotice(error.message));
    if (!ready) return;

    const target = els.address.value.trim();
    els.status.textContent = target ? "Navigating…" : "Opening home…";
    els.loading.classList.remove("hidden");

    try {
      await api("/api/navigate", {
        method: "POST",
        body: JSON.stringify({ target })
      });
      setTimeout(updateState, 100);
    } catch (error) {
      showNotice(error.message);
    } finally {
      els.loading.classList.add("hidden");
    }
  });

  document.getElementById("backBtn").addEventListener("click", () => action("/api/back"));
  document.getElementById("forwardBtn").addEventListener("click", () => action("/api/forward"));
  document.getElementById("reloadBtn").addEventListener("click", () => action("/api/reload"));
  document.getElementById("homeBtn").addEventListener("click", () => action("/api/home"));

  function imagePoint(clientX, clientY) {
    const rect = els.screen.getBoundingClientRect();
    if (!rect.width || !rect.height || !els.screen.naturalWidth || !els.screen.naturalHeight) return null;

    const x = (clientX - rect.left) * (els.screen.naturalWidth / rect.width);
    const y = (clientY - rect.top) * (els.screen.naturalHeight / rect.height);

    if (x < 0 || y < 0 || x > els.screen.naturalWidth || y > els.screen.naturalHeight) return null;
    return { x, y };
  }

  function editableAt(point) {
    if (!point) return null;
    for (let i = editableRegions.length - 1; i >= 0; i--) {
      const region = editableRegions[i];
      if (
        point.x >= region.x &&
        point.y >= region.y &&
        point.x <= region.x + region.width &&
        point.y <= region.y + region.height
      ) {
        return region;
      }
    }
    return null;
  }

  function resetKeyboardBridge() {
    els.keyboardBridge.value = BRIDGE_SENTINEL;
    try {
      els.keyboardBridge.setSelectionRange(BRIDGE_SENTINEL.length, BRIDGE_SENTINEL.length);
    } catch {}
  }

  function configureKeyboard(region = {}) {
    const mode = region.inputMode || "text";
    const enterHint = region.enterKeyHint || "";

    els.keyboardBridge.setAttribute("inputmode", mode);
    if (enterHint) els.keyboardBridge.setAttribute("enterkeyhint", enterHint);
    else els.keyboardBridge.removeAttribute("enterkeyhint");
  }

  function activateKeyboard(region = {}) {
    if (!isTouchDevice) return;
    configureKeyboard(region);
    resetKeyboardBridge();
    try {
      els.keyboardBridge.focus({ preventScroll: true });
    } catch {
      els.keyboardBridge.focus();
    }
  }

  function dismissKeyboard() {
    if (document.activeElement === els.keyboardBridge) els.keyboardBridge.blur();
  }

  async function remoteClickPoint(point, localRegion = null) {
    if (!point || !ready) return;
    try {
      const result = await api("/api/click", {
        method: "POST",
        body: JSON.stringify(point)
      });

      if (result.editable && isTouchDevice && document.activeElement !== els.keyboardBridge) {
        activateKeyboard({
          inputMode: result.inputMode || localRegion?.inputMode || "text",
          enterKeyHint: result.enterKeyHint || localRegion?.enterKeyHint || ""
        });
      } else if (!result.editable && !localRegion) {
        dismissKeyboard();
      }

      setTimeout(updateState, 100);
    } catch (error) {
      showNotice(error.message);
    }
  }

  function handleRemoteTap(clientX, clientY) {
    const point = imagePoint(clientX, clientY);
    if (!point) return;

    const region = editableAt(point);
    if (region) activateKeyboard(region);
    else dismissKeyboard();

    remoteClickPoint(point, region);
  }

  els.screen.addEventListener("click", event => {
    if (Date.now() < suppressClickUntil) return;
    handleRemoteTap(event.clientX, event.clientY);
  });

  els.stage.addEventListener("wheel", event => {
    if (!ready) return;
    event.preventDefault();
    dismissKeyboard();
    action("/api/scroll", {
      dx: Math.max(-1400, Math.min(1400, event.deltaX)),
      dy: Math.max(-1400, Math.min(1400, event.deltaY))
    });
  }, { passive: false });

  els.stage.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    lastTouch = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });

  els.stage.addEventListener("touchmove", event => {
    if (!touchStart || event.touches.length !== 1) return;
    event.preventDefault();

    const touch = event.touches[0];
    const dx = lastTouch.x - touch.clientX;
    const dy = lastTouch.y - touch.clientY;
    lastTouch = { x: touch.clientX, y: touch.clientY };

    if (Math.abs(dx) + Math.abs(dy) > 2) {
      dismissKeyboard();
      action("/api/scroll", { dx: dx * 2.2, dy: dy * 2.2 });
    }
  }, { passive: false });

  els.stage.addEventListener("touchend", event => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const distance = Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y);
    const elapsed = Date.now() - touchStart.time;

    if (distance < 12 && elapsed < 550) {
      suppressClickUntil = Date.now() + 650;
      handleRemoteTap(touch.clientX, touch.clientY);
    }

    touchStart = null;
    lastTouch = null;
  }, { passive: true });

  els.keyboardBridge.addEventListener("compositionstart", () => {
    composing = true;
  });

  els.keyboardBridge.addEventListener("compositionend", event => {
    composing = false;
    const text = event.data || els.keyboardBridge.value.replaceAll(BRIDGE_SENTINEL, "");
    if (text) queueText(text);
    resetKeyboardBridge();
  });

  els.keyboardBridge.addEventListener("keydown", event => {
    if (event.key === "Backspace") {
      event.preventDefault();
      queueRemote("/api/key", { key: "Backspace" });
      resetKeyboardBridge();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      queueRemote("/api/key", { key: "Enter" });
      resetKeyboardBridge();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      dismissKeyboard();
    }
  });

  els.keyboardBridge.addEventListener("input", () => {
    if (composing) return;

    const raw = els.keyboardBridge.value;
    const text = raw.replaceAll(BRIDGE_SENTINEL, "");

    if (!raw) {
      queueRemote("/api/key", { key: "Backspace" });
    } else if (text) {
      queueText(text);
    }

    resetKeyboardBridge();
  });

  window.addEventListener("keydown", event => {
    const active = document.activeElement;
    if (active === els.address || active === els.keyboardBridge) return;

    const allowed = ["Enter","Backspace","Tab","Escape","Delete","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"];
    if (allowed.includes(event.key)) {
      event.preventDefault();
      queueRemote("/api/key", { key: event.key });
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      queueRemote("/api/type", { text: event.key });
    }
  });

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (ready) action("/api/viewport", viewportSize());
    }, 250);
  });

  els.endSessionBtn.addEventListener("click", async () => {
    dismissKeyboard();
    try {
      await api("/api/session", { method: "DELETE" });
    } catch {}

    ready = false;
    editableRegions = [];
    clearTimeout(screenTimer);
    els.screen.classList.remove("ready");
    els.screen.removeAttribute("src");
    els.address.value = "";
    els.loading.classList.remove("hidden");
    els.loading.querySelector("span").textContent = "Session ended";
    els.status.textContent = "Session ended · enter an address to start a new isolated session";
    showNotice("Remote browser data cleared");
  });

  els.signOutBtn.addEventListener("click", async () => {
    dismissKeyboard();
    try {
      await fetch("/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
    } finally {
      location.href = "/login";
    }
  });

  resetKeyboardBridge();
  stateTimer = setInterval(updateState, 1200);

  startSession().catch(error => {
    els.loading.querySelector("span").textContent = "Could not start browser";
    els.status.textContent = error.message;
    showNotice(error.message);
  });

  window.addEventListener("pagehide", () => {
    clearTimeout(screenTimer);
    clearInterval(stateTimer);
  });
})();
