// Enhances the checkbox toggle with persistence. Runs in <head> so the saved
// theme applies before first paint.
(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const system = () => (media.matches ? 'dark' : 'light');

  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch {
    // Storage can be blocked; the toggle then works for this page only.
  }
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

  document.addEventListener('DOMContentLoaded', () => {
    const input = document.querySelector('.theme-input');
    if (!input) return;
    // The checkbox means "differs from the system theme".
    const sync = () => {
      input.checked = (root.dataset.theme || system()) !== system();
    };
    sync();
    media.addEventListener('change', sync);
    input.addEventListener('change', () => {
      const other = system() === 'dark' ? 'light' : 'dark';
      const next = input.checked ? other : system();
      root.dataset.theme = next;
      try {
        localStorage.setItem('theme', next);
      } catch {
        // See above.
      }
    });
  });
})();
