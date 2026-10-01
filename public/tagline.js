(() => {
  const phrase = document.querySelector('.tagline-phrase');
  if (!phrase || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const phrases = ['superintelligent assistant.', 'workplace assistant.', 'autonomous assistant.'];
  const FADE_MS = 400;
  let index = 0;
  setInterval(() => {
    phrase.classList.add('tagline-phrase-hidden');
    setTimeout(() => {
      index = (index + 1) % phrases.length;
      phrase.textContent = phrases[index];
      phrase.classList.remove('tagline-phrase-hidden');
    }, FADE_MS);
  }, 3000);
})();
