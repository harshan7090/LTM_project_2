/**
 * AI assistant view: grounded chat + pipeline photo analysis.
 *
 * Two things this deliberately does NOT do:
 *   - It never talks to an LLM provider directly. Every call goes through the
 *     FastAPI backend so the API key stays server-side.
 *   - It never claims photo analysis is available when the configured model
 *     can't actually see images. The status endpoint reports that honestly and
 *     the dropzone is disabled with an explanation instead.
 */
import { analyzeImage, apiGet, streamChat } from './api.js';
import { $, esc, md, toast } from './ui.js';

const state = {
  provider: null,
  history: [],       // [{role, content}]
  segmentId: null,   // anchors questions to one segment
  busy: false,
  controller: null,  // AbortController for the in-flight request
  file: null,
};

const SUGGESTIONS = [
  'Which segments need inspection first, and why?',
  'What does low soil resistivity do to external corrosion rate?',
  'Explain cathodic protection under NACE SP0169',
  'How should I prioritise uncoated segments with no CP?',
];

// -------------------------------------------------------------- status ----

export async function refreshStatus() {
  const bar = $('#provider-bar');
  try {
    state.provider = await apiGet('/api/assistant/status');
  } catch (err) {
    bar.className = 'provider-bar bad';
    bar.innerHTML = `<span class="pill">offline</span><span>${esc(err.message)}</span>`;
    return;
  }

  const p = state.provider;
  const kind = p.provider === 'mock' ? 'warn' : p.available ? 'ok' : 'bad';
  bar.className = `provider-bar ${kind}`;
  bar.innerHTML = `
    <span class="pill">${esc(p.provider)}</span>
    <span class="mono" style="color:var(--text-muted)">${esc(p.model ?? '—')}</span>
    <span class="spacer"></span>
    <span style="color:var(--text-muted)">${esc(p.detail ?? '')}</span>`;

  renderVisionAvailability();
}

function renderVisionAvailability() {
  const p = state.provider;
  const note = $('#vision-note');
  const dz = $('#dropzone');

  if (p?.supports_vision) {
    note.classList.add('hidden');
    dz.classList.remove('hidden');
    return;
  }

  note.classList.remove('hidden');
  dz.classList.add('hidden');
  note.innerHTML = `
    <strong>Photo analysis isn't available with the current model.</strong><br>
    ${esc(p?.detail ?? 'No vision-capable model configured.')}
    <br><br>
    Two ways to enable it:
    <br>• Local, no API key: <code>ollama pull llama3.2-vision</code>, then restart the server.
    <br>• Faster, needs a free key: set <code>GROQ_API_KEY</code> in <code>.env</code>.`;
}

// ---------------------------------------------------------------- chat ----

function addMessage(role, html, opts = {}) {
  const log = $('#chat-log');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `
    <div class="avatar">${role === 'user' ? 'You' : 'AI'}</div>
    <div class="bubble">${html}</div>`;
  if (opts.id) el.dataset.id = opts.id;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function setBusy(busy) {
  state.busy = busy;
  $('#chat-send').disabled = busy;
  $('#chat-stop').classList.toggle('hidden', !busy);
  $('#chat-input').disabled = busy;
}

export async function ask(question) {
  if (state.busy || !question.trim()) return;

  addMessage('user', `<p>${esc(question)}</p>`);
  state.history.push({ role: 'user', content: question });

  const slowHint = state.provider?.provider === 'ollama'
    ? '<br><span style="font-size:11.5px;color:var(--text-dim)">Local model — this can take a minute.</span>'
    : '';
  const el = addMessage('assistant',
    `<span class="typing"><span></span><span></span><span></span></span>${slowHint}`);
  const bubble = $('.bubble', el);

  setBusy(true);
  state.controller = new AbortController();

  try {
    const full = await streamChat(
      {
        question,
        segment_id: state.segmentId,
        history: state.history.slice(0, -1),
      },
      (_piece, accumulated) => {
        bubble.innerHTML = md(accumulated);
        $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
      },
      state.controller.signal,
    );
    state.history.push({ role: 'assistant', content: full });
    if (!full.trim()) {
      bubble.innerHTML = '<p><em>The model returned an empty response.</em></p>';
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      bubble.innerHTML += '<p><em>Stopped.</em></p>';
    } else {
      bubble.innerHTML = `<p><strong>Error:</strong> ${esc(err.message)}</p>`;
      toast(err.message, 'error');
    }
  } finally {
    setBusy(false);
    state.controller = null;
  }
}

/** Focus the assistant on one segment (called from the detail panel). */
export function focusSegment(segmentId) {
  state.segmentId = segmentId;
  state.history = [];
  $('#chat-log').replaceChildren();
  $('#chat-scope').textContent = segmentId
    ? `Answers are grounded in ${segmentId}`
    : 'Answers are grounded in your visible fleet';
  $('#chat-clear-scope').classList.toggle('hidden', !segmentId);
  $('#image-segment').value = segmentId ?? '';
  greet();
}

function greet() {
  addMessage('assistant', md(
    state.segmentId
      ? `Ready. I have **${state.segmentId}**'s attributes, its predicted corrosion rate, and the SHAP drivers behind that prediction. Ask me why it scored the way it did, or what to inspect first.`
      : `Ready. I can see your fleet summary and the segments in your scope.\n\nI'm restricted to pipeline integrity and corrosion engineering — I'll decline anything outside that.`,
  ));
}

// --------------------------------------------------------------- image ----

function showPreview(file) {
  state.file = file;
  const url = URL.createObjectURL(file);
  $('#preview-wrap').classList.remove('hidden');
  $('#dropzone').classList.add('hidden');
  $('#preview-img').src = url;
  $('#preview-img').onload = () => URL.revokeObjectURL(url);
  $('#analyze-btn').disabled = false;
  $('#image-meta').textContent =
    `${file.name} — ${(file.size / 1024 / 1024).toFixed(2)} MB`;
}

function clearPreview() {
  state.file = null;
  $('#preview-wrap').classList.add('hidden');
  if (state.provider?.supports_vision) $('#dropzone').classList.remove('hidden');
  $('#preview-img').removeAttribute('src');
  $('#analyze-btn').disabled = true;
  $('#image-meta').textContent = '';
  $('#file-input').value = '';
}

function acceptFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('That file is not an image.', 'error');
    return;
  }
  const MAX = 8 * 1024 * 1024;
  if (file.size > MAX) {
    toast(`Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 8 MB.`, 'error');
    return;
  }
  showPreview(file);
}

async function runAnalysis() {
  if (!state.file) return;
  const out = $('#analysis-out');
  const btn = $('#analyze-btn');

  btn.disabled = true;
  btn.textContent = 'Analysing…';
  out.classList.remove('hidden');
  out.innerHTML = `
    <span class="typing"><span></span><span></span><span></span></span>
    <p style="font-size:12px;color:var(--text-dim);margin-top:8px">
      Vision models are slower than text. On a local model this can take
      several minutes.</p>`;

  try {
    const res = await analyzeImage(
      state.file,
      $('#image-segment').value.trim() || null,
      $('#image-note').value.trim() || null,
    );
    out.innerHTML = md(res.analysis) +
      `<p style="font-size:11.5px;color:var(--text-dim);margin-top:14px;
                 border-top:1px solid var(--border);padding-top:10px">
         Qualitative visual triage from ${esc(res.provider)} / ${esc(res.model ?? 'model')}.
         Wall loss and remaining life cannot be determined from a photograph —
         those require UT or ILI measurement.
       </p>`;
  } catch (err) {
    out.innerHTML = `<p><strong>Analysis failed.</strong> ${esc(err.message)}</p>`;
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyse photo';
  }
}

// -------------------------------------------------------------- wiring ----

export function wireAssistant() {
  // suggestions
  const row = $('#suggestion-row');
  row.innerHTML = SUGGESTIONS.map(
    (s) => `<button class="suggestion">${esc(s)}</button>`,
  ).join('');
  row.addEventListener('click', (e) => {
    const btn = e.target.closest('.suggestion');
    if (btn) ask(btn.textContent);
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const q = input.value;
    input.value = '';
    input.style.height = 'auto';
    ask(q);
  });

  // Enter sends, Shift+Enter newlines. Auto-grow the textarea.
  const input = $('#chat-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });

  $('#chat-stop').addEventListener('click', () => state.controller?.abort());

  $('#chat-clear-scope').addEventListener('click', () => focusSegment(null));

  // ---- image bay
  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#file-input').click());
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    acceptFile(e.dataTransfer.files?.[0]);
  });

  $('#file-input').addEventListener('change', (e) => acceptFile(e.target.files?.[0]));
  $('#preview-clear').addEventListener('click', clearPreview);
  $('#analyze-btn').addEventListener('click', runAnalysis);

  // Paste a screenshot straight into the analyser.
  document.addEventListener('paste', (e) => {
    if ($('#view-assistant').classList.contains('hidden')) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      acceptFile(item.getAsFile());
      toast('Pasted image ready to analyse', 'success');
    }
  });

  greet();
}
