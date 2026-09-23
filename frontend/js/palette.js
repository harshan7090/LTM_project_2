/**
 * Command palette (Ctrl/Cmd+K). Built on the native <dialog> element, so focus
 * trapping, Escape-to-close, and the backdrop come from the platform rather
 * than from hand-rolled JS.
 *
 * Searches both static commands and — usefully for a 5000-row table — segment
 * IDs, so an engineer can jump straight to a segment by typing its number.
 */
import { $, esc } from './ui.js';

let commands = [];
let filtered = [];
let active = 0;

export function setCommands(list) {
  commands = list;
}

function render() {
  const list = $('#palette-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="palette-item"><span class="sub">No matches</span></div>';
    return;
  }
  list.innerHTML = filtered.slice(0, 40).map((c, i) => `
    <div class="palette-item ${i === active ? 'active' : ''}" data-i="${i}">
      <span>${esc(c.label)}</span>
      ${c.sub ? `<span class="sub">${esc(c.sub)}</span>` : ''}
      ${c.hint ? `<span class="hint">${esc(c.hint)}</span>` : ''}
    </div>`).join('');

  list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
}

function filter(q) {
  const query = q.trim().toLowerCase();
  filtered = query
    ? commands.filter((c) =>
        c.label.toLowerCase().includes(query) ||
        (c.sub ?? '').toLowerCase().includes(query))
    : commands.filter((c) => !c.dynamic);
  active = 0;
  render();
}

export function openPalette() {
  const dlg = $('#palette');
  $('#palette-input').value = '';
  filter('');
  dlg.showModal();
  $('#palette-input').focus();
}

function run(cmd) {
  $('#palette').close();
  cmd?.run?.();
}

export function wirePalette() {
  const dlg = $('#palette');
  const input = $('#palette-input');

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      dlg.open ? dlg.close() : openPalette();
    }
  });

  input.addEventListener('input', () => filter(input.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, Math.min(filtered.length, 40) - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[active]);
    }
  });

  $('#palette-list').addEventListener('click', (e) => {
    const item = e.target.closest('.palette-item[data-i]');
    if (item) run(filtered[Number(item.dataset.i)]);
  });

  // Clicking the backdrop closes it.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}
