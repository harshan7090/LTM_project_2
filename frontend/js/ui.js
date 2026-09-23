/**
 * Small shared UI utilities: DOM helpers, toasts, markdown rendering, and a
 * View Transitions wrapper.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const fmt = {
  rate: (v) => Number(v).toFixed(2),
  years: (v) => `${Number(v).toFixed(1)} yrs`,
  label: (s) => String(s).replaceAll('_', ' '),
};

/** Escapes text before it goes anywhere near innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Deliberately minimal markdown -> HTML for LLM output.
 *
 * Escapes first, then re-introduces only a known-safe subset of tags. Model
 * output is untrusted input as far as the DOM is concerned — especially with
 * image analysis, where text inside an uploaded photo can reach the model.
 * A full markdown library would be more capable and a much larger surface.
 */
export function md(text) {
  let s = esc(text);

  // fenced code -> <pre>
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // bold headings that models emit as **Section**
  s = s.replace(/^\s*\*\*(.+?)\*\*\s*$/gm, '<h4>$1</h4>');
  // markdown headings
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<h4>$1</h4>');
  // bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // lists: group consecutive bullet/number lines into one <ul>/<ol>
  const lines = s.split('\n');
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${bullet[1]}</li>`);
    } else if (numbered) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${numbered[1]}</li>`);
    } else {
      closeList();
      out.push(line);
    }
  }
  closeList();

  // remaining blank-line-separated blocks become paragraphs
  return out.join('\n')
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return '';
      if (/^<(h4|ul|ol|pre|li|\/)/.test(b)) return b;
      return `<p>${b.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

/** Toast notifications. */
export function toast(message, kind = 'info', ms = 4200) {
  const host = $('#toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 200ms ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/**
 * Runs a DOM update inside a View Transition when the browser supports it,
 * falling back to a plain call when it doesn't. Progressive enhancement —
 * nothing breaks without it.
 */
export function withTransition(fn) {
  if (document.startViewTransition) {
    document.startViewTransition(fn);
  } else {
    fn();
  }
}

/** Simple debounce for search-as-you-type. */
export function debounce(fn, ms = 180) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
