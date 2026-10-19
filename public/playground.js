// A separate file, because the page's CSP allows no inline script without a nonce.
(() => {
  const root = document.querySelector('#playground');
  if (!root) {
    return;
  }
  const editor = root.querySelector('#playground-editor');
  const templates = root.querySelector('#playground-template');
  const runButton = root.querySelector('#playground-run');
  const output = root.querySelector('#playground-output');
  const outputBlock = root.querySelector('#playground-output-block');
  const status = root.querySelector('#playground-status');
  const elapsedLabel = root.querySelector('#playground-elapsed');
  const canvas = document.querySelector('#page-live-view canvas');
  const liveLink = document.querySelector('#page-live-view a.page-preview-link');
  const { cdpUrl, pagesUrl } = root.dataset;

  const draftKey = `playground:${pagesUrl}`;
  const loadDraft = () => {
    try {
      return localStorage.getItem(draftKey);
    } catch {
      return null;
    }
  };
  const saveDraft = () => {
    try {
      localStorage.setItem(draftKey, editor.value);
    } catch {
      // Storage may be off; the draft is only a convenience.
    }
  };

  const selectedTemplate = () => templates.selectedOptions[0]?.dataset.code ?? '';
  editor.value = loadDraft() ?? selectedTemplate();

  /** @type {Worker | null} */
  let worker = null;
  let startedAt = 0;

  const append = (className, text) => {
    const line = document.createElement('div');
    line.className = `playground-line ${className}`;
    line.textContent = text;
    output.append(line);
    output.scrollTop = output.scrollHeight;
  };

  const appendImage = (data) => {
    const image = document.createElement('img');
    image.className = 'playground-image';
    image.alt = 'Screenshot taken by the script';
    image.src = `data:image/png;base64,${data}`;
    output.append(image);
    output.scrollTop = output.scrollHeight;
  };

  const hasCode = () => editor.value.trim() !== '';

  // Stop must always work, but there is nothing to run in an empty editor.
  const updateRunButton = () => {
    runButton.disabled = !worker && !hasCode();
  };

  // One button: it stops the script while one runs.
  const setRunning = (running, text) => {
    runButton.textContent = running ? 'Stop' : 'Run';
    runButton.classList.toggle('btn-primary', !running);
    runButton.classList.toggle('btn-secondary', running);
    // Picking a template mid-run would replace the code that is running.
    templates.classList.toggle('hidden', running);
    status.textContent = text;
    updateRunButton();
  };

  const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;

  // A short run ends before anyone needs it, so the label waits 2 seconds.
  const SHOW_ELAPSED_AFTER = 2000;
  let elapsedTimer = null;

  const updateElapsed = () => {
    const ms = performance.now() - startedAt;
    if (ms > SHOW_ELAPSED_AFTER) {
      elapsedLabel.textContent = `Running for ${Math.floor(ms / 1000)} seconds...`;
      elapsedLabel.classList.remove('hidden');
    }
  };

  const stopElapsed = () => {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    elapsedLabel.classList.add('hidden');
    elapsedLabel.textContent = '';
  };

  // Output shows only once a run ends, so a quiet run still says so.
  const finish = (text) => {
    worker?.terminate();
    worker = null;
    stopElapsed();
    setRunning(false, text);
    if (!output.hasChildNodes()) {
      append('playground-empty', 'Empty');
    }
    outputBlock.classList.remove('hidden');
  };

  const run = () => {
    if (worker || !hasCode()) {
      return;
    }
    saveDraft();
    output.replaceChildren();
    outputBlock.classList.add('hidden');
    startedAt = performance.now();
    // Checks often, so the count moves on close to each whole second.
    elapsedTimer = setInterval(updateElapsed, 250);
    setRunning(true, 'Running...');
    worker = new Worker('/playground-worker.js');
    worker.onmessage = ({ data }) => {
      if (data.type === 'log') {
        append(`playground-${data.level}`, data.text);
      } else if (data.type === 'image') {
        appendImage(data.data);
      } else if (data.type === 'page' && canvas) {
        canvas.dataset.frameUrl = `${pagesUrl}/${data.pageId}/frame`;
        // The link starts at the page list; point it at the page the run drives.
        if (liveLink) liveLink.href = `${pagesUrl}/${data.pageId}`;
      } else if (data.type === 'done') {
        if (data.result !== undefined) {
          append('playground-result', data.result);
        }
        finish(`Finished in ${elapsed()}.`);
      } else if (data.type === 'error') {
        append('playground-error', data.text);
        finish(`Failed after ${elapsed()}.`);
      }
    };
    worker.onerror = (event) => {
      append('playground-error', event.message || 'The script could not start.');
      finish(`Failed after ${elapsed()}.`);
    };
    worker.postMessage({ type: 'run', code: editor.value, cdpUrl });
  };

  const stop = () => {
    if (!worker) {
      return;
    }
    append('playground-warn', 'Stopped.');
    finish(`Stopped after ${elapsed()}.`);
  };

  runButton.addEventListener('click', () => (worker ? stop() : run()));

  templates.addEventListener('change', () => {
    editor.value = selectedTemplate();
    saveDraft();
    updateRunButton();
  });

  editor.addEventListener('input', () => {
    saveDraft();
    updateRunButton();
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      run();
      return;
    }
    // Tab indents below, so Escape is the way out of the editor by keyboard.
    if (event.key === 'Escape') {
      editor.blur();
      return;
    }
    // A plain textarea would move focus away on Tab; indent instead.
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      saveDraft();
    }
  });

  setRunning(false, 'Ready.');
})();
