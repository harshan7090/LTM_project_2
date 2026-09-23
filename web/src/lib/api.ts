import type {
  AssignmentResult, AssistantStatus, Citation, FleetStats, ImageAnalysis,
  InspectionPlan, KnowledgeHit, LoginResponse, MapConfig, Me, PipelineRoute,
  RepairPlan,
  RiskMatrix,
  ScheduleRequest, ScheduleResult, Segment, SegmentDetailRaw, SegmentHistory,
  WorkOrderRequest,
} from './types';

const TOKEN_KEY = 'integrityai_token';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
  },
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const t = auth.token;
  return t ? { ...extra, Authorization: `Bearer ${t}` } : extra;
}

async function toError(res: Response): Promise<never> {
  let detail = res.statusText;
  try {
    const body = await res.json();
    detail = body?.detail ?? detail;
  } catch {
    /* non-JSON error body — keep the status text */
  }
  throw new ApiError(detail || `Request failed (${res.status})`, res.status);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
  if (!res.ok) await toError(res);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await toError(res);
  return res.json() as Promise<T>;
}

// ------------------------------------------------------------- endpoints ---

export const api = {
  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) await toError(res);
    return res.json();
  },

  logout: () => post<{ ok: boolean }>('/api/logout'),
  me: () => get<Me>('/api/me'),

  segments: () => get<{ segments: Segment[] }>('/api/segments').then((r) => r.segments),
  segment: (id: string) => get<SegmentDetailRaw>(`/api/segments/${encodeURIComponent(id)}`),
  inspection: (id: string) =>
    get<InspectionPlan>(`/api/segments/${encodeURIComponent(id)}/inspection`),
  acknowledge: (id: string) =>
    post<{ ok: boolean }>(`/api/segments/${encodeURIComponent(id)}/acknowledge`),

  riskMatrix: () => get<RiskMatrix>('/api/risk-matrix'),
  mapRoutes: () =>
    get<{ routes: PipelineRoute[] }>('/api/map/routes').then((r) => r.routes),
  mapConfig: () => get<MapConfig>('/api/map/config'),

  /** One map tile as an object URL.
   *
   *  The tile route is authenticated, and an <img src> cannot carry a
   *  bearer token — so the bytes are fetched here, where the header can be
   *  attached, and handed back as a blob URL the caller assigns to an
   *  Image. The caller owns revoking it. */
  async mapTile(key: string): Promise<string> {
    const res = await fetch(`/api/map/tile/${key}.png`, { headers: headers() });
    if (!res.ok) await toError(res);
    return URL.createObjectURL(await res.blob());
  },
  history: (id: string) =>
    get<SegmentHistory>(`/api/segments/${encodeURIComponent(id)}/history`),

  /** Back-cast series for many segments at once. The register asks for the
   *  rows it can currently see; one call, not one per row. */
  bulkHistory: (ids: string[]) =>
    post<{ series: Record<string, number[]>; reconstructed: boolean }>(
      '/api/history', { segment_ids: ids }),

  stats: () => get<FleetStats>('/api/stats'),
  assistantStatus: () => get<AssistantStatus>('/api/assistant/status'),

  knowledgeSearch: (q: string, topK = 5) =>
    get<{ query: string; results: KnowledgeHit[] }>(
      `/api/knowledge/search?q=${encodeURIComponent(q)}&top_k=${topK}`,
    ),

  schedule: (req: Partial<ScheduleRequest>) => post<ScheduleResult>('/api/schedule', req),

  repair: (id: string) =>
    get<RepairPlan>(`/api/segments/${encodeURIComponent(id)}/repair`),

  assignWorkOrders: (req: Partial<WorkOrderRequest>) =>
    post<AssignmentResult>('/api/workorders/assign', req),

  async exportCsv(): Promise<Blob> {
    const res = await fetch('/api/export.csv', { headers: headers() });
    if (!res.ok) await toError(res);
    return res.blob();
  },

  async analyzeImage(
    file: File,
    segmentId?: string | null,
    note?: string | null,
    signal?: AbortSignal,
  ): Promise<ImageAnalysis> {
    const form = new FormData();
    form.append('file', file);
    if (segmentId) form.append('segment_id', segmentId);
    if (note) form.append('note', note);
    // No Content-Type header — the browser must set the multipart boundary.
    const res = await fetch('/api/assistant/analyze-image', {
      method: 'POST',
      headers: headers(),
      body: form,
      signal,
    });
    if (!res.ok) await toError(res);
    return res.json();
  },
};

/**
 * Streams a chat answer.
 *
 * The backend prefixes the stream with a NUL-delimited citations line so the UI
 * can show sources immediately rather than waiting for a slow local model to
 * finish. That marker is parsed off here so callers only ever see clean text.
 */
const CITATION_MARKER = '\x00CITATIONS\x00';

export async function streamChat(
  payload: { question: string; segment_id?: string | null; history: unknown[]; use_rag?: boolean },
  onChunk: (accumulated: string) => void,
  onCitations: (citations: Citation[]) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) await toError(res);
  if (!res.body) throw new ApiError('No response body', 500);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let citationsParsed = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    if (!citationsParsed) {
      if (buffer.startsWith(CITATION_MARKER)) {
        const end = buffer.indexOf('\x00', CITATION_MARKER.length);
        if (end === -1) continue; // marker not fully received yet
        try {
          onCitations(JSON.parse(buffer.slice(CITATION_MARKER.length, end)));
        } catch {
          /* malformed citations must not break the answer */
        }
        buffer = buffer.slice(end + 1).replace(/^\n/, '');
        citationsParsed = true;
      } else if (buffer.length >= CITATION_MARKER.length) {
        citationsParsed = true; // no citations on this response
      } else {
        continue; // too short to tell yet
      }
    }

    answer = buffer;
    onChunk(answer);
  }
  return answer;
}
