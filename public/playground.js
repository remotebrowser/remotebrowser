// A separate file, because the page's CSP allows no inline script without a nonce.
(() => {
  const root = document.querySelector('#playground');
  if (!root) {
    return;
  }
  const editor = root.querySelector('#playground-editor');
  const templates = root.querySelector('#playground-template');
  const runButton = root.querySelector('#playground-run');
  const stopButton = root.querySelector('#playground-stop');
  const clearButton = root.querySelector('#playground-clear');
  const output = root.querySelector('#playground-output');
  const status = root.querySelector('#playground-status');
  const canvas = document.querySelector('#page-live-view canvas');
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

  const setRunning = (running, text) => {
    runButton.disabled = running;
    stopButton.disabled = !running;
    status.textContent = text;
  };

  const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;

  const finish = (text) => {
    worker?.terminate();
    worker = null;
    setRunning(false, text);
  };

  const run = () => {
    if (worker) {
      return;
    }
    saveDraft();
    output.replaceChildren();
    startedAt = performance.now();
    setRunning(true, 'Running...');
    worker = new Worker('/playground-worker.js');
    worker.onmessage = ({ data }) => {
      if (data.type === 'log') {
        append(`playground-${data.level}`, data.text);
      } else if (data.type === 'image') {
        appendImage(data.data);
      } else if (data.type === 'page' && canvas) {
        canvas.dataset.frameUrl = `${pagesUrl}/${data.pageId}/frame`;
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

  runButton.addEventListener('click', run);
  stopButton.addEventListener('click', stop);
  clearButton.addEventListener('click', () => output.replaceChildren());

  templates.addEventListener('change', () => {
    editor.value = selectedTemplate();
    saveDraft();
  });

  editor.addEventListener('input', saveDraft);
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
