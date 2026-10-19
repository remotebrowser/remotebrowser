// A separate file, because the page's CSP rejects an inline script that htmx swaps in.
(() => {
  // htmx may run this file again when it swaps in a fragment that loads it.
  if (window.screencastStarted) {
    return;
  }
  window.screencastStarted = true;

  const MAX_PIXEL_RATIO = 2;

  // Caps the rate at 4 fps even if the browser repaints faster than 60 Hz.
  const MIN_FRAME_GAP = 250;

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Each canvas streams one page, so a browser with several pages shows them all live.
  const stream = async (canvas) => {
    const context = canvas.getContext('2d');
    // Read on each poll: the playground points it at whichever page its script drives.
    let frameUrl = canvas.dataset.frameUrl;
    // Lets the server skip frames we already drew.
    let seq = 0;
    let frameRequest = null;

    // Switching pages must not wait for the old page's long poll to finish.
    const frameUrlObserver = new MutationObserver(() => frameRequest?.abort());
    frameUrlObserver.observe(canvas, { attributes: true, attributeFilter: ['data-frame-url'] });

    const draw = async (blob, expectedUrl) => {
      const bitmap = await createImageBitmap(blob);
      if (canvas.dataset.frameUrl !== expectedUrl) {
        bitmap.close();
        return false;
      }
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return true;
    };

    // A later htmx swap can remove the canvas.
    while (canvas.isConnected) {
      // Lets the server stop the screencast when nobody sees it.
      while (document.hidden) {
        await new Promise((resolve) => document.addEventListener('visibilitychange', resolve, { once: true }));
      }
      if (canvas.dataset.frameUrl !== frameUrl) {
        frameUrl = canvas.dataset.frameUrl;
        // Sequence numbers belong to one page.
        seq = 0;
      }
      if (!frameUrl) {
        await pause(500);
        continue;
      }
      const startedAt = performance.now();
      const requestedUrl = frameUrl;
      const controller = new AbortController();
      frameRequest = controller;
      try {
        const width = Math.round(canvas.clientWidth * Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
        const response = await fetch(`${requestedUrl}?after=${seq}&w=${width}`, {
          cache: 'no-store',
          signal: controller.signal
        });
        if (canvas.dataset.frameUrl !== requestedUrl) {
          continue;
        }
        if (response.status === 200 && response.headers.get('Content-Type')?.startsWith('image/')) {
          if (!(await draw(await response.blob(), requestedUrl))) continue;
          seq = Number(response.headers.get('X-Frame-Seq')) || seq;
          await pause(MIN_FRAME_GAP - (performance.now() - startedAt));
        } else if (response.status !== 204) {
          await pause(2000);
        }
      } catch (error) {
        if (error.name !== 'AbortError') await pause(2000);
      } finally {
        if (frameRequest === controller) frameRequest = null;
      }
    }
    frameUrlObserver.disconnect();
  };

  const streaming = new WeakSet();

  const startAll = () => {
    for (const canvas of document.querySelectorAll('canvas[data-frame-url]')) {
      // A swap may put back a canvas that is already streaming.
      if (!streaming.has(canvas) && canvas.isConnected) {
        streaming.add(canvas);
        void stream(canvas).finally(() => streaming.delete(canvas));
      }
    }
  };

  // htmx adds canvases later, for example when a browser opens a new page.
  new MutationObserver(startAll).observe(document.body, { childList: true, subtree: true });
  startAll();
})();
