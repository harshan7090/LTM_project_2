import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, ImageUp, Send, Square, X } from 'lucide-react';

import { api, streamChat } from '../lib/api';
import type { ChatMessage, Citation, ImageAnalysis } from '../lib/types';
import { Button, Module, Sweep, cx, useToast } from '../components/ui';

const SUGGESTIONS = [
  'Which segments need inspection first, and why?',
  'What does low soil resistivity do to external corrosion rate?',
  'Why can disbonded tape coating hide a CP problem?',
  'How do I convert mpy to remaining life?',
];

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface Props {
  segmentId: string | null;
  onClearScope: () => void;
}

export default function Assistant({ segmentId, onClearScope }: Props) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const { data: status } = useQuery({
    queryKey: ['assistantStatus'],
    queryFn: api.assistantStatus,
  });

  // Reset the conversation whenever the grounding scope changes — carrying an
  // old segment's discussion into a new segment's context invites confusion.
  useEffect(() => { setMessages([]); }, [segmentId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const ask = useCallback(async (question: string) => {
    if (busy || !question.trim()) return;
    setInput('');
    setMessages((m) => [
      ...m,
      { role: 'user', content: question },
      { role: 'assistant', content: '' },
    ]);
    setBusy(true);
    abortRef.current = new AbortController();

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    const patchLast = (patch: Partial<ChatMessage>) =>
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });

    try {
      await streamChat(
        { question, segment_id: segmentId, history, use_rag: true },
        (accumulated) => patchLast({ content: accumulated }),
        (citations: Citation[]) => patchLast({ citations }),
        abortRef.current.signal,
      );
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        patchLast({ content: (messages.at(-1)?.content ?? '') + '\n\n_Stopped._' });
      } else {
        patchLast({ content: e.message, error: true });
        toast(e.message, 'error');
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, messages, segmentId, toast]);

  const kb = status?.knowledge_base;
  const providerTone =
    status?.provider === 'mock' ? 'border-elevated/45'
      : status?.available ? 'border-normal/40' : 'border-critical/45';

  return (
    <div className="flex flex-col gap-3">
      {/* provider status rail — reads like a channel strip */}
      <div
        className={cx(
          'flex flex-wrap items-center gap-3 border bg-panel px-3 py-1.5',
          providerTone,
        )}
      >
        <span className="flex items-center gap-1.5">
          <span
            className={cx(
              'lamp',
              status?.provider === 'mock' ? 'text-elevated'
                : status?.available ? 'text-normal' : 'text-critical',
            )}
          />
          <span className="label" style={{ fontSize: 9.5 }}>
            {status?.provider ?? 'checking'}
          </span>
        </span>
        <span className="num text-[11px] text-muted">{status?.model ?? '—'}</span>
        {status?.supports_vision && (
          <span className="num text-[11px] text-dim">
            vision: {status.vision_model}
          </span>
        )}
        {kb && (
          <span className="flex items-center gap-1.5 text-[11px] text-dim">
            <BookOpen size={11} />
            <span className="num">{kb.chunks}</span> chunks /{' '}
            <span className="num">{kb.documents}</span> docs
            {kb.dense_enabled && ' +dense'}
          </span>
        )}
        <div className="flex-1" />
        <span className="label" style={{ fontSize: 9 }}>Scope: oil &amp; gas integrity</span>
      </div>

      <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] xl:[grid-template-columns:minmax(0,1.5fr)_minmax(330px,1fr)]">
        {/* ---------------- chat ---------------- */}
        <Module
          title="Assistant"
          id={segmentId ?? 'FLEET'}
          bodyClass=""
          className="flex min-h-[540px] flex-col"
          right={
            segmentId ? (
              <button
                onClick={onClearScope}
                className="label hover:text-accent"
                style={{ fontSize: 9 }}
              >
                Clear focus ✕
              </button>
            ) : (
              <span className="label" style={{ fontSize: 9 }}>Grounded in visible fleet</span>
            )
          }
        >

          <div ref={logRef} className="flex max-h-[52vh] flex-1 flex-col gap-3.5 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="rounded-md border border-line bg-raised p-3.5 text-[13px] leading-relaxed text-muted">
                {segmentId
                  ? <>Ready. I have <span className="font-mono text-ink">{segmentId}</span>'s
                    attributes, its predicted rate, the SHAP drivers, and its recommended
                    inspection plan.</>
                  : <>Ready. I can see your fleet summary and a corrosion engineering knowledge
                    base. I'm restricted to pipeline integrity — I'll decline anything outside it.</>}
              </div>
            )}

            {/* Transcript entries, not chat bubbles — a speaker tag in the
                margin and a rule between turns reads as an operator log. */}
            {messages.map((m, i) => (
              <div key={i} className="animate-fade-up flex gap-2.5">
                <span
                  className={cx(
                    'label w-[28px] shrink-0 pt-[2px] text-right',
                    m.role === 'assistant' ? 'text-accent' : 'text-dim',
                  )}
                  style={{ fontSize: 9, color: 'inherit' }}
                >
                  {m.role === 'assistant' ? 'AI' : 'OPR'}
                </span>
                <div
                  className={cx(
                    'min-w-0 flex-1 border-l pl-3 text-[12.5px] leading-relaxed',
                    m.role === 'assistant' ? 'border-accent/40' : 'border-line',
                    m.error && 'border-critical',
                  )}
                >
                  {m.content ? (
                    <div className="prose-chat break-words">
                      <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
                    </div>
                  ) : (
                    <Sweep
                      label={
                        status?.provider === 'ollama'
                          ? 'Local model — this can take a minute…'
                          : 'Generating…'
                      }
                    />
                  )}

                  {m.citations && m.citations.length > 0 && (
                    <div className="mt-2 border-t border-line-soft pt-1.5">
                      <div className="label mb-1" style={{ fontSize: 9 }}>
                        Retrieved sources
                      </div>
                      <ol className="flex flex-col gap-[2px]">
                        {m.citations.map((c, n) => (
                          <li key={n} className="flex gap-1.5 text-[10.5px] text-dim">
                            <span className="num text-accent">[{n + 1}]</span>
                            <span>{c.citation}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {messages.length === 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  className="border border-line px-2.5 py-1 text-left text-[11px] text-muted
                             transition-colors hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); ask(input); }}
            className="flex items-end gap-2 border-t border-line-soft p-2.5"
          >
            <span className="label pb-2" style={{ fontSize: 9 }}>&gt;</span>
            <textarea
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask(input);
                }
              }}
              rows={1}
              placeholder="Ask about corrosion, CP, coatings, inspection planning…"
              aria-label="Ask the assistant"
              className="max-h-[140px] min-h-[36px] flex-1 resize-none border border-line
                         bg-bg px-2.5 py-2 text-[12.5px] text-ink outline-none
                         placeholder:text-dim focus:border-accent disabled:opacity-60"
            />
            {busy && (
              <Button type="button" variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                <Square size={12} /> Stop
              </Button>
            )}
            <Button type="submit" disabled={busy || !input.trim()}>
              <Send size={14} /> Ask
            </Button>
          </form>
        </Module>

        {/* ---------------- photo analysis ---------------- */}
        <PhotoAnalysis
          segmentId={segmentId}
          supportsVision={!!status?.supports_vision}
          visionDetail={status?.vision_detail ?? ''}
          visionModel={status?.vision_model ?? null}
          textModel={status?.model ?? null}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PhotoAnalysis({
  segmentId, supportsVision, visionDetail, visionModel, textModel,
}: {
  segmentId: string | null;
  supportsVision: boolean;
  visionDetail: string;
  visionModel: string | null;
  textModel: string | null;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [segInput, setSegInput] = useState(segmentId ?? '');
  const [result, setResult] = useState<ImageAnalysis | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setSegInput(segmentId ?? ''); }, [segmentId]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const accept = useCallback((f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) return toast('That file is not an image.', 'error');
    if (f.size > MAX_IMAGE_BYTES) {
      return toast(`Image is ${(f.size / 1048576).toFixed(1)} MB — the limit is 8 MB.`, 'error');
    }
    setFile(f);
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
    setResult(null);
  }, [toast]);

  // Paste a screenshot straight in.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (item) { accept(item.getAsFile()); toast('Pasted image ready to analyse', 'success'); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [accept, toast]);

  async function run() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setShowRaw(false);
    setStage(1);
    // The request is a single round trip, but the server runs two stages. The
    // vision pass dominates the wall time, so flip the label optimistically
    // to show the pipeline is progressing rather than hung.
    const toStage2 = setTimeout(() => setStage(2), 12_000);
    try {
      const res = await api.analyzeImage(file, segInput.trim() || null, note.trim() || null);
      setResult(res);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      clearTimeout(toStage2);
      setStage(0);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Module title="Pipeline Photo Analysis" id="VIS">
        <p className="mb-3.5 text-xs leading-relaxed text-muted">
          Upload a photo of a pipeline asset. The model assesses visible corrosion morphology
          and coating condition, then checks it against this segment's predicted rate and
          SHAP drivers.
        </p>

        {!supportsVision ? (
          <div className="rounded border border-elevated/35 bg-elevated/10 px-3.5 py-3 text-xs leading-relaxed">
            <strong>Photo analysis isn't available yet.</strong>
            <p className="mt-1 text-muted">{visionDetail}</p>
            <p className="mt-2">Install a local vision model — no API key needed:</p>
            <ul className="mt-1 list-disc pl-4 text-muted">
              <li><code className="font-mono">ollama pull moondream</code> — ~1.7 GB, fast on CPU</li>
              <li><code className="font-mono">ollama pull llama3.2-vision</code> — ~8 GB, better but slow without a GPU</li>
            </ul>
            <p className="mt-2 text-muted">Then restart the server.</p>
          </div>
        ) : (
          <>
            {/* Signal-chain diagram: makes the two-stage architecture legible
                at a glance instead of hiding it in prose. */}
            <div className="mb-3 flex items-center gap-1.5 border border-line-soft bg-raised px-2.5 py-1.5">
              <span className="label" style={{ fontSize: 8.5 }}>Photo</span>
              <span className="text-dim">→</span>
              <span className="num text-[10px] text-accent">{visionModel}</span>
              <span className="text-dim">→</span>
              <span className="label" style={{ fontSize: 8.5 }}>Observations</span>
              <span className="text-dim">→</span>
              <span className="num text-[10px] text-accent">{textModel}</span>
              <span className="text-dim">→</span>
              <span className="label" style={{ fontSize: 8.5 }}>Assessment</span>
            </div>

            {!preview ? (
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); accept(e.dataTransfer.files?.[0]); }}
                className={cx(
                  'cursor-pointer border border-dashed px-4 py-6 text-center transition-colors',
                  drag ? 'border-accent bg-accent/10' : 'border-line hover:border-accent',
                )}
              >
                <ImageUp size={20} className="mx-auto mb-1.5 text-dim" />
                <div className="label mb-1">Drop · click · paste</div>
                <div className="text-[10.5px] text-dim">JPEG · PNG · WebP · GIF — max 8 MB</div>
              </div>
            ) : (
              <div className="relative border border-line bg-bg">
                <img src={preview} alt="Pipeline photo preview" className="max-h-60 w-full object-contain" />
                <button
                  onClick={() => { setFile(null); setPreview(null); setResult(null); }}
                  aria-label="Remove image"
                  className="absolute right-1.5 top-1.5 grid place-items-center border
                             border-line bg-bg/90 text-muted hover:text-critical"
                  style={{ height: 22, width: 22 }}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => accept(e.target.files?.[0])}
            />
            {file && (
              <p className="num mt-1.5 text-[10px] text-dim">
                {file.name} · {(file.size / 1048576).toFixed(2)} MB
              </p>
            )}

            <label className="mt-3 block">
              <span className="label">Segment ID — grounds the analysis</span>
              <input
                value={segInput}
                onChange={(e) => setSegInput(e.target.value)}
                placeholder="SEG-00042"
                className="num mt-1 w-full border border-line bg-bg px-2.5 py-1.5 text-[12px]
                           text-ink outline-none placeholder:text-dim focus:border-accent"
              />
            </label>
            <label className="mt-2 block">
              <span className="label">Inspector note</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="taken at soil-to-air interface"
                className="mt-1 w-full border border-line bg-bg px-2.5 py-1.5 text-[12px]
                           text-ink outline-none placeholder:text-dim focus:border-accent"
              />
            </label>

            <Button className="mt-3 w-full" disabled={!file || busy} onClick={run}>
              {busy ? 'Analysing…' : 'Analyse photo'}
            </Button>
          </>
        )}
      </Module>

      {(busy || result) && (
        <Module title="Assessment" id={busy ? `STAGE ${stage}` : 'DONE'}
                className="max-h-[46vh] overflow-y-auto">
          {busy && (
            <>
              {/* Explicit stage indicator — the pipeline is visible while it runs */}
              <div className="mb-2.5 flex items-center gap-2">
                {[1, 2].map((s) => (
                  <div key={s} className="flex flex-1 items-center gap-1.5">
                    <span
                      className={cx(
                        'lamp',
                        stage === s ? 'text-accent lamp-critical'
                          : stage > s ? 'text-normal' : 'text-dim',
                      )}
                    />
                    <span className="label" style={{ fontSize: 8.5 }}>
                      {s === 1 ? 'See' : 'Reason'}
                    </span>
                  </div>
                ))}
              </div>
              <Sweep
                label={
                  stage === 1
                    ? `${visionModel ?? 'vision model'} is reading the photo…`
                    : `${textModel ?? 'text model'} is writing the assessment…`
                }
              />
              <p className="mt-2 text-[10.5px] text-dim">
                {stage === 1
                  ? 'Vision runs on CPU — this step is the slow one.'
                  : 'Almost there.'}
              </p>
            </>
          )}

          {result && (
            <>
              <div className="prose-chat text-[12.5px] leading-relaxed">
                <Markdown remarkPlugins={[remarkGfm]}>{result.analysis}</Markdown>
              </div>

              {result.observations && (
                <div className="mt-3 border-t border-line-soft pt-2">
                  <button
                    onClick={() => setShowRaw((v) => !v)}
                    className="label hover:text-accent"
                    style={{ fontSize: 9 }}
                  >
                    {showRaw ? '▼' : '▶'} Raw stage-1 observations
                  </button>
                  {showRaw && (
                    <p className="mt-1.5 border-l-2 border-line bg-bg px-2.5 py-2
                                  text-[11.5px] leading-relaxed text-muted">
                      {result.observations}
                    </p>
                  )}
                  <p className="num mt-2 text-[10px] leading-relaxed text-dim">
                    {result.vision_model} ({result.vision_provider}) →{' '}
                    {result.model} ({result.provider})
                  </p>
                  <p className="mt-1 flex gap-1.5 text-[10px] leading-relaxed text-dim">
                    <span className="lamp mt-[4px] text-elevated" />
                    <span>
                      Qualitative triage only. Wall loss and remaining life require
                      UT or ILI measurement — they cannot be read from a photograph.
                    </span>
                  </p>
                </div>
              )}
            </>
          )}
        </Module>
      )}
    </div>
  );
}
