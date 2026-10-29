// A separate file, because the page's CSP allows no inline script without a nonce.
(() => {
  // htmx swaps in a new editor when the browser starts running.
  const start = (root) => {
    const editor = root.querySelector('#playground-editor');
    const templates = root.querySelector('#playground-template');
    const runButton = root.querySelector('#playground-run');
    // In the sidebar, outside the panel.
    const output = document.querySelector('#playground-output');
    const outputBlock = document.querySelector('#playground-output-block');
    const status = document.querySelector('#playground-status');
    const progressLabel = root.querySelector('#playground-progress');
    const { pagesUrl, harnessUrl } = root.dataset;
    const cdpUrl = new URL(root.dataset.cdpUrl);
    cdpUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

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

    const selectedTemplate = () => templates.selectedOptions[0]?.dataset.example ?? '';
    // Edited text becomes a Custom task, so the examples never change.
    const syncTemplate = () => {
      const match = [...templates.options].find((option) => option.dataset.example === editor.value);
      templates.value = match ? match.value : 'custom';
    };
    const draft = loadDraft();
    editor.value = draft ?? selectedTemplate();
    if (draft !== null) syncTemplate();

    /** @type {Worker | null} */
    let worker = null;
    /** @type {AbortController | null} */
    let request = null;
    let startedAt = 0;

    const isRunning = () => Boolean(worker || request);

    const append = (className, text) => {
      const line = document.createElement('div');
      line.className = `playground-line ${className}`;
      line.textContent = text;
      output.append(line);
      output.scrollTop = output.scrollHeight;
    };

    const hasCode = () => editor.value.trim() !== '';

    // Stop must always work, but there is nothing to run in an empty editor.
    const updateRunButton = () => {
      runButton.disabled = !isRunning() && !hasCode();
    };

    // One button: it stops the script while one runs.
    const setRunning = (running, text) => {
      runButton.textContent = running ? 'Stop' : 'Run';
      runButton.classList.toggle('btn-primary', !running);
      runButton.classList.toggle('btn-secondary', running);
      // Picking a template mid-run would replace the code that is running.
      // Faded out rather than removed, so the toolbar keeps its layout.
      templates.disabled = running;
      templates.classList.toggle('playground-template-running', running);
      status.textContent = text;
      updateRunButton();
    };

    const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;

    // A short run ends before anyone needs the count, so it waits 2 seconds.
    const SHOW_ELAPSED_AFTER = 2000;
    let elapsedTimer = null;

    const showProgress = (text) => {
      progressLabel.textContent = text;
      progressLabel.classList.remove('hidden');
    };

    const updateElapsed = () => {
      const ms = performance.now() - startedAt;
      if (ms > SHOW_ELAPSED_AFTER) {
        showProgress(`${worker ? 'Running' : 'Checking'} for ${Math.floor(ms / 1000)} seconds...`);
      }
    };

    const stopElapsed = () => {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
      progressLabel.classList.add('hidden');
      progressLabel.textContent = '';
    };

    // Output shows only once a run ends, so a quiet run still says so.
    const finish = (text) => {
      request?.abort();
      request = null;
      worker?.terminate();
      worker = null;
      stopElapsed();
      setRunning(false, text);
      if (!output.hasChildNodes()) {
        append('playground-empty', 'Empty');
      }
      outputBlock.classList.remove('hidden');
    };

    const runCode = (code) => {
      setRunning(true, 'Running...');
      worker = new Worker('/playground-worker.js');
      showProgress('Running...');
      updateElapsed();
      worker.onmessage = ({ data }) => {
        if (data.type === 'log') {
          append(`playground-${data.level}`, data.text);
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
      worker.postMessage({ type: 'run', code, cdpUrl: cdpUrl.href });
    };

    // The harness checks the code, or has the LLM write it from natural
    // language. Returns the code, or null once it has shown why there is none.
    const prepareCode = async () => {
      request = new AbortController();
      const { signal } = request;
      setRunning(true, 'Checking...');
      showProgress('Checking...');
      const body = new FormData();
      body.set('csrf', root.querySelector('input[name="csrf"]').value);
      const input = editor.value;
      body.set('input', input);
      let answer;
      try {
        const response = await fetch(harnessUrl, { method: 'POST', body, signal });
        // A signed-out user is redirected to an HTML page.
        answer = await response.json().catch(() => ({ error: 'Please sign in again.' }));
      } catch {
        answer = { error: 'Unable to reach the server. Please try again.' };
      }
      // Stopped while it waited; stop() has already reported it.
      if (signal.aborted) return null;
      request = null;
      if (typeof answer.code !== 'string') {
        append('playground-error', answer.error || 'Something went wrong. Please try again.');
        finish(`Failed after ${elapsed()}.`);
        return null;
      }
      // Shows what the LLM wrote, unless the user typed during the wait.
      if (answer.generated && editor.value === input) {
        editor.value = answer.code;
        saveDraft();
        syncTemplate();
      }
      return answer.code;
    };

    const run = async () => {
      if (isRunning() || !hasCode()) {
        return;
      }
      saveDraft();
      output.replaceChildren();
      outputBlock.classList.add('hidden');
      startedAt = performance.now();
      // Checked 4 times a second, so the count changes near each whole second.
      elapsedTimer = setInterval(updateElapsed, 250);
      const code = await prepareCode();
      if (code !== null) {
        runCode(code);
      }
    };

    const stop = () => {
      if (!isRunning()) {
        return;
      }
      append('playground-warn', 'Stopped.');
      finish(`Stopped after ${elapsed()}.`);
    };

    runButton.addEventListener('click', () => (isRunning() ? stop() : void run()));

    templates.addEventListener('change', () => {
      editor.value = selectedTemplate();
      saveDraft();
      updateRunButton();
    });

    editor.addEventListener('input', () => {
      syncTemplate();
      saveDraft();
      updateRunButton();
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void run();
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
  };

  const startAll = () => {
    const root = document.querySelector('#playground');
    if (root && !root.dataset.started) {
      root.dataset.started = 'true';
      start(root);
    }
  };

  document.body.addEventListener('htmx:afterSettle', startAll);
  startAll();
})();
