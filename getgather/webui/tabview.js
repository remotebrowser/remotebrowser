// Active-tab live view + input control over CDP.
//
// Unlike the noVNC live view (which streams the whole X display on port 8080), this streams only
// the active browser tab's page viewport via CDP Page.startScreencast, and forwards mouse/keyboard
// back via the CDP Input domain. It talks to the server-side CDP websocket proxy (/cdp/<browser_id>),
// so the Daytona signed preview token never reaches the client (it is a bearer secret).
//
// CDP is driven in "flatten" mode: a single browser-level socket multiplexes per-target sessions
// via a top-level `sessionId` field. The server proxy rewrites `targetId` fields to namespace them
// by browser_id, but leaves `sessionId` alone, so screencast/input routing is unaffected.

const browserId = document.body.dataset.browserId;
// When opened for a signin_id, this is the exact target (tab) to stream. Empty = stream the
// browser's first page target (the active-tab default).
const pinnedTargetId = document.body.dataset.targetId || "";
const img = document.getElementById("screen");
const status = document.getElementById("status");

const SCREENCAST = {
  format: "jpeg",
  quality: 60,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1,
};

let ws = null;
let nextId = 1;
let pageSession = null; // CDP flatten sessionId of the page target we are streaming
let lastMeta = null; // most recent screencastFrame metadata, for coordinate mapping
let buttons = 0; // bitmask of currently-pressed mouse buttons
let getTargetsId = null; // pending Target.getTargets request id
let attachId = null; // pending Target.attachToTarget request id

function setStatus(text) {
  status.textContent = text;
  status.style.display = text ? "block" : "none";
}

function send(method, params, sessionId) {
  const id = nextId++;
  const msg = { id, method, params: params || {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return id;
}

function startScreencast() {
  send("Page.enable", {}, pageSession);
  send("Page.bringToFront", {}, pageSession); // make it foreground or Chrome won't emit frames
  send("Page.startScreencast", SCREENCAST, pageSession);
  setStatus("");
}

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}/cdp/${encodeURIComponent(browserId)}`);
  setStatus("Connecting…");

  ws.onopen = () => {
    if (pinnedTargetId) {
      // Pinned to a specific tab (signin_id flow): attach straight to that target.
      attachId = send("Target.attachToTarget", { targetId: pinnedTargetId, flatten: true });
      setStatus("Attaching to tab…");
    } else {
      // No pin: the CDP proxy may have pre-attached every target (the fleet does), so setAutoAttach
      // won't re-fire attachedToTarget. Enumerate targets and attach to the first page ourselves.
      getTargetsId = send("Target.getTargets");
      setStatus("Finding tab…");
    }
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    // Response to Target.getTargets: pick the page target and attach to it.
    if (msg.id === getTargetsId && msg.result) {
      getTargetsId = null;
      const page = (msg.result.targetInfos || []).find((t) => t.type === "page");
      if (!page) {
        setStatus("No tab open — retrying…");
        setTimeout(() => (getTargetsId = send("Target.getTargets")), 1500);
        return;
      }
      attachId = send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      return;
    }

    // Response to Target.attachToTarget: take the session and start streaming.
    if (msg.id === attachId && msg.result) {
      attachId = null;
      pageSession = msg.result.sessionId;
      startScreencast();
      return;
    }

    // Attach failed (e.g. a pinned target that has since closed): fall back to the first page.
    if (msg.id === attachId && msg.error) {
      attachId = null;
      setStatus("Tab unavailable — finding another…");
      getTargetsId = send("Target.getTargets");
      return;
    }

    if (msg.method === "Target.detachedFromTarget" && msg.params.sessionId === pageSession) {
      pageSession = null;
      setStatus("Tab closed — finding next…");
      getTargetsId = send("Target.getTargets");
      return;
    }

    if (msg.method === "Page.screencastFrame" && msg.sessionId === pageSession) {
      lastMeta = msg.params.metadata;
      img.src = "data:image/jpeg;base64," + msg.params.data;
      // Must ack every frame with its own (integer) sessionId or the stream stalls.
      send("Page.screencastFrameAck", { sessionId: msg.params.sessionId }, pageSession);
      return;
    }
  };

  ws.onclose = () => {
    pageSession = null;
    setStatus("Disconnected — reconnecting…");
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

// ---- input mapping ----------------------------------------------------------
// Mouse coords are CSS pixels in the page's layout viewport (0,0 = top-left of the streamed image).
// Map a pointer event on the <img> to that space using the latest frame metadata.
function toViewport(e) {
  const rect = img.getBoundingClientRect();
  if (!lastMeta || !rect.width || !rect.height) return null;
  const scale = lastMeta.pageScaleFactor || 1;
  return {
    x: ((e.clientX - rect.left) / rect.width) * (lastMeta.deviceWidth / scale),
    y: ((e.clientY - rect.top) / rect.height) * (lastMeta.deviceHeight / scale),
  };
}

const BUTTON_NAME = ["left", "middle", "right"];
const BUTTON_BIT = { 0: 1, 1: 4, 2: 2 }; // CDP `buttons` bitmask: left=1, right=2, middle=4

function mouse(type, e, extra) {
  if (!pageSession) return;
  const p = toViewport(e);
  if (!p) return;
  send(
    "Input.dispatchMouseEvent",
    { type, x: p.x, y: p.y, button: extra?.button ?? "none", buttons, ...extra },
    pageSession,
  );
}

img.addEventListener("mousemove", (e) => mouse("mouseMoved", e));
img.addEventListener("mousedown", (e) => {
  buttons |= BUTTON_BIT[e.button] || 0;
  mouse("mousePressed", e, { button: BUTTON_NAME[e.button] || "left", clickCount: 1 });
});
img.addEventListener("mouseup", (e) => {
  buttons &= ~(BUTTON_BIT[e.button] || 0);
  mouse("mouseReleased", e, { button: BUTTON_NAME[e.button] || "left", clickCount: 1 });
});
img.addEventListener("contextmenu", (e) => e.preventDefault());
img.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY });
  },
  { passive: false },
);

// Keyboard: printable chars go through insertText (covers most fields); named keys
// (Enter, Tab, arrows, Backspace…) go through dispatchKeyEvent with a virtual key code.
const VK = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

document.addEventListener("keydown", (e) => {
  if (!pageSession) return;
  // Let real shortcuts (Ctrl/Cmd combos) pass as key events, not text.
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (printable) {
    e.preventDefault();
    send("Input.insertText", { text: e.key }, pageSession);
    return;
  }
  if (VK[e.key] != null) {
    e.preventDefault();
    const p = {
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: VK[e.key],
      nativeVirtualKeyCode: VK[e.key],
    };
    send("Input.dispatchKeyEvent", { type: "keyDown", ...p }, pageSession);
    send("Input.dispatchKeyEvent", { type: "keyUp", ...p }, pageSession);
  }
});

connect();
