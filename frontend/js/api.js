/**
 * Thin API client. Holds the session token and normalises error handling so
 * every caller gets a real Error with the server's `detail` message rather
 * than a bare "fetch failed".
 */

const BASE = window.location.origin;
const TOKEN_KEY = 'integrityai_token';

export const session = {
  token: localStorage.getItem(TOKEN_KEY),
  me: null,

  set(token) {
    this.token = token;
    localStorage.setItem(TOKEN_KEY, token);
  },

  clear() {
    this.token = null;
    this.me = null;
    localStorage.removeItem(TOKEN_KEY);
  },
};

function authHeaders(extra = {}) {
  return session.token
    ? { ...extra, Authorization: `Bearer ${session.token}` }
    : { ...extra };
}

async function raise(res) {
  const body = await res.json().catch(() => ({ detail: res.statusText }));
  const err = new Error(body.detail || `Request failed (${res.status})`);
  err.status = res.status;
  throw err;
}

export async function apiGet(path) {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  if (!res.ok) await raise(res);
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await raise(res);
  return res.status === 204 ? null : res.json();
}

export async function apiBlob(path) {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  if (!res.ok) await raise(res);
  return res.blob();
}

export async function login(username, password) {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) await raise(res);
  return res.json();
}

/**
 * Streams the assistant's answer. The backend sends plain text chunks rather
 * than SSE — simpler, and there's no need for event framing here.
 *
 * `onChunk` is called with each decoded piece as it arrives. Pass an
 * AbortSignal to let the user stop a long generation, which matters because a
 * local CPU model can take minutes.
 */
export async function streamChat(payload, onChunk, signal) {
  const res = await fetch(BASE + '/api/assistant/chat', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) await raise(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = decoder.decode(value, { stream: true });
    if (piece) {
      full += piece;
      onChunk(piece, full);
    }
  }
  return full;
}

export async function analyzeImage(file, segmentId, note, signal) {
  const form = new FormData();
  form.append('file', file);
  if (segmentId) form.append('segment_id', segmentId);
  if (note) form.append('note', note);

  const res = await fetch(BASE + '/api/assistant/analyze-image', {
    method: 'POST',
    headers: authHeaders(),   // no Content-Type: the browser sets the multipart boundary
    body: form,
    signal,
  });
  if (!res.ok) await raise(res);
  return res.json();
}
