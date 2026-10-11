// A separate file, because the page's CSP rejects an inline script that htmx swaps in.
(() => {
  const canvas = document.querySelector('#page-live-view canvas');
  if (!canvas) {
    return;
  }
  const context = canvas.getContext('2d');
  const frameUrl = canvas.dataset.frameUrl;
  // Lets the server skip frames we already drew.
  let seq = 0;

  // Caps the rate at 4 fps even if the browser repaints faster than 60 Hz.
  const MIN_FRAME_GAP = 250;

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const draw = async (blob) => {
    const bitmap = await createImageBitmap(blob);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
  };

  const run = async () => {
    // A later htmx swap can remove the canvas.
    while (canvas.isConnected) {
      // Lets the server stop the screencast when nobody sees it.
      while (document.hidden) {
        await new Promise((resolve) => document.addEventListener('visibilitychange', resolve, { once: true }));
      }
      const startedAt = performance.now();
      try {
        const response = await fetch(`${frameUrl}?after=${seq}`, { cache: 'no-store' });
        if (response.status === 200 && response.headers.get('Content-Type') === 'image/jpeg') {
          await draw(await response.blob());
          seq = Number(response.headers.get('X-Frame-Seq')) || seq;
          await pause(MIN_FRAME_GAP - (performance.now() - startedAt));
        } else if (response.status !== 204) {
          await pause(2000);
        }
      } catch {
        await pause(2000);
      }
    }
  };

  void run();
})();
