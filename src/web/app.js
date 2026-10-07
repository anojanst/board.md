// The board page. Renders GET /api/board, moves cards with PATCH /api/tasks/:id and reloads when
// the server says files changed. Plain DOM, no dependencies; every task string goes in as text.

const token = document.querySelector('meta[name="boardmd-token"]')?.getAttribute('content') ?? '';
const $ = (selector) => document.querySelector(selector);
const RESERVED = new Set(['q', 'lanes', 'task']);
const COLLAPSED_KEY = 'boardmd:collapsed';

const state = {
  board: null,
  q: '',
  filters: {},
  lanes: false,
  openTask: null,
  /** The branch the user already agreed to edit on. */
  confirmedBranch: null,
  /** Output of a failing checkCommand: { id, text }. */
  warning: null,
  connectionLost: false,
  collapsed: readCollapsed(),
  dragging: null,
  pending: new Set(),
  openDetails: new Set(),
  panelVersion: null,
  lastLoad: 0,
};

// ---------------------------------------------------------------------------------------------
// Small helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2), value);
    else if (key === 'value' || key === 'checked' || key === 'selected') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

const ICONS = {
  branch:
    'M5 3.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM5 6.75v6.5M5 13.25a1.75 1.75 0 1 0 0 .01M11 3.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM11 6.75c0 3-6 2.5-6 5',
  pr: 'M4.5 3.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM4.5 6.75v5.5M4.5 12.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM11.5 12.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM11.5 12.25V6.5c0-1.2-.8-2-2-2H7.5M9 3l-1.5 1.5L9 6',
  merged:
    'M4.5 2.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM4.5 5.75v8M11.5 9.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM4.5 6c0 3 2.5 5 5.25 5',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  close: 'M4 4l8 8M12 4l-8 8',
  copy: 'M5.5 5.5V3.75c0-.69.56-1.25 1.25-1.25h5.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25H10.5M3.75 5.5h5.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-5.5c-.69 0-1.25-.56-1.25-1.25v-5.5c0-.69.56-1.25 1.25-1.25Z',
  external: 'M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1v-7c0-.55.45-1 1-1h3',
  info: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 7.5V11M8 5h.01',
  warn: 'M8 2 1.5 13.5h13L8 2ZM8 6.5v3.25M8 11.75h.01',
  chevronLeft: 'M10 3.5 5.5 8l4.5 4.5',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3',
};

function icon(name, size = 14) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '2.4' : '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state.collapsed));
  } catch {
    // Private windows can refuse storage; collapsing still works for this visit.
  }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-Boardmd-Token'] = token;
  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: `Can't reach boardmd (${error.message}).` } };
  }
}

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
}

function taskById(id) {
  return state.board?.tasks.find((t) => t.id === id) ?? null;
}

function fieldDisplay(name, value) {
  const label = state.board?.fields[name]?.values?.[value];
  return label === undefined || label === String(value) ? String(value) : `${value} · ${label}`;
}

function shortLabel(name, value) {
  return state.board?.fields[name]?.values?.[value] ?? String(value);
}

function prUrl(pr) {
  return state.board?.repoUrl ? `${state.board.repoUrl}/pull/${pr}` : null;
}

/** Why a card can't be moved, or null when it can. */
function lockReason(t) {
  if (t.live?.state === 'in-review')
    return `In review in PR #${t.live.pr}. Its status is set by its own PR, so it can't be moved here.`;
  if (t.live?.state === 'in-progress')
    return `In progress on ${t.live.branch}. Its status is set by its own PR, so it can't be moved here.`;
  if (!t.editable)
    return `This file has no one-line "${state.board.statusField}:" in its frontmatter, so it can't be moved.`;
  return null;
}

function isCollapsed(column) {
  return state.collapsed[column.name] ?? column.collapsed;
}

function laneField() {
  if (!state.board) return null;
  return Object.keys(state.board.fields).find((k) => state.board.fields[k].swimlane) ?? null;
}

// ---------------------------------------------------------------------------------------------
// URL state: search, filters, swimlanes and the open task can be bookmarked.

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.q = params.get('q') ?? '';
  state.lanes = params.get('lanes') === '1';
  state.openTask = params.get('task');
  state.filters = {};
  for (const [key, value] of params) if (!RESERVED.has(key) && value) state.filters[key] = value;
}

function writeUrl(push = false) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
  if (state.lanes) params.set('lanes', '1');
  if (state.openTask) params.set('task', state.openTask);
  const query = params.toString();
  const url = `${location.pathname}${query ? `?${query}` : ''}`;
  if (url !== `${location.pathname}${location.search}`)
    history[push ? 'pushState' : 'replaceState'](null, '', url);
}

// ---------------------------------------------------------------------------------------------
// Loading

let loading = null;
let reloadQueued = false;

function loadBoard() {
  if (loading) {
    reloadQueued = true;
    return loading;
  }
  loading = (async () => {
    const res = await api('GET', '/api/board');
    if (res.ok) setBoard(res.data);
    else if (!state.board) {
      $('#board').replaceChildren(
        h('p', { class: 'loading muted' }, res.data?.error ?? `Couldn't load the board (HTTP ${res.status}).`),
      );
    }
  })().finally(() => {
    loading = null;
    if (reloadQueued) {
      reloadQueued = false;
      loadBoard();
    }
  });
  return loading;
}

function setBoard(board) {
  state.board = board;
  state.lastLoad = Date.now();
  // Drop filters for fields that aren't filters.
  for (const key of Object.keys(state.filters))
    if (!board.fields[key]?.filter) delete state.filters[key];
  renderHeader();
  renderFilters();
  renderNotices();
  render();
  if (state.openTask) {
    const t = taskById(state.openTask);
    if (!t || t.version !== state.panelVersion) renderPanel();
    else markOpenCard();
  }
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadBoard, 120);
}

// ---------------------------------------------------------------------------------------------
// Header, filters and notices

function renderHeader() {
  const b = state.board;
  $('#project-name').textContent = b.name;
  $('#tasks-dir').textContent = b.tasksDir;
  const chip = $('#branch');
  if (b.branch) {
    const off = b.baseBranch && b.branch !== b.baseBranch;
    chip.className = `chip${off ? ' warn' : ''}`;
    chip.title = off
      ? `You're on ${b.branch}, not ${b.baseBranch}. Edits land on this branch.`
      : 'The checked-out branch. Edits land here.';
    chip.replaceChildren(icon('branch', 12), h('span', {}, b.branch));
    chip.hidden = false;
  } else chip.hidden = true;
  const lane = laneField();
  $('#lanes-toggle').hidden = !lane;
  if (lane) $('#lanes-label').textContent = `Lanes by ${b.fields[lane].label.toLowerCase()}`;
  $('#lanes').checked = state.lanes && !!lane;
  const search = $('#search');
  if (document.activeElement !== search) search.value = state.q;
  search.classList.toggle('active', !!state.q);
  $('#clear-filters').hidden = !state.q && Object.keys(state.filters).length === 0;
}

/** Values for a field: the config's order first, then any others found in the files. */
function fieldValues(name) {
  const field = state.board.fields[name];
  const known = Object.keys(field.values ?? {});
  const found = new Set();
  for (const t of state.board.tasks) {
    const v = t.data[name];
    for (const x of Array.isArray(v) ? v : [v])
      if (x !== null && x !== undefined && x !== '' && typeof x !== 'object') found.add(String(x));
  }
  const extra = [...found].filter((v) => !known.includes(v)).sort((a, b) => a.localeCompare(b));
  return [...known, ...extra];
}

function renderFilters() {
  const box = $('#filters');
  const selects = [];
  for (const [name, field] of Object.entries(state.board.fields)) {
    if (!field.filter) continue;
    const values = fieldValues(name);
    const current = state.filters[name] ?? '';
    if (current && !values.includes(current)) values.push(current);
    const select = h(
      'select',
      { 'aria-label': `Filter by ${field.label}`, 'data-field': name, class: current ? 'active' : '' },
      h('option', { value: '' }, `${field.label}: all`),
      values.map((v) => h('option', { value: v }, fieldDisplay(name, v))),
    );
    select.value = current;
    selects.push(select);
  }
  box.replaceChildren(...selects);
}

function notice(kind, body, extra) {
  return h(
    'div',
    { class: `notice ${kind}` },
    icon(kind === 'info' ? 'info' : 'warn', 15),
    h('div', { class: 'notice-body' }, body),
    extra,
  );
}

function detailsList(key, summary, items) {
  const details = h('details', { 'data-key': key }, h('summary', {}, summary), h('ul', {}, items));
  details.open = state.openDetails.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) state.openDetails.add(key);
    else state.openDetails.delete(key);
  });
  return details;
}

function renderNotices() {
  const b = state.board;
  const out = [];
  if (state.connectionLost)
    out.push(notice('danger', h('p', {}, 'Lost the connection to boardmd. Is it still running? Retrying…')));
  if (b) {
    for (const note of b.notes) out.push(notice('info', h('p', {}, note)));
    if (state.warning) {
      out.push(
        notice(
          'warn',
          [h('p', {}, `The check command reported problems after moving ${state.warning.id}:`), h('pre', {}, state.warning.text)],
          h(
            'button',
            {
              class: 'button ghost small',
              type: 'button',
              onclick: () => {
                state.warning = null;
                renderNotices();
              },
            },
            'Dismiss',
          ),
        ),
      );
    }
    if (b.uncommitted.length) {
      const n = b.uncommitted.length;
      out.push(
        notice('warn', [
          h(
            'p',
            {},
            h('strong', {}, `${n} task file${n === 1 ? ' has' : 's have'} uncommitted changes.`),
            b.afterEditHint ? ` ${b.afterEditHint}` : '',
          ),
          detailsList(
            'uncommitted',
            'Show files',
            b.uncommitted.map((u) => h('li', {}, h('code', {}, `${u.code.trim() || 'M'} ${u.file}`))),
          ),
        ]),
      );
    }
    if (b.invalid.length) {
      const n = b.invalid.length;
      out.push(
        notice('danger', [
          h('p', {}, h('strong', {}, `${n} file${n === 1 ? '' : 's'} couldn't be read as a task.`)),
          detailsList(
            'invalid',
            'Show files',
            b.invalid.map((f) => h('li', {}, h('code', {}, f.file), ` ${f.error}`)),
          ),
        ]),
      );
    }
  }
  $('#notices').replaceChildren(...out);
}

// ---------------------------------------------------------------------------------------------
// The board

const searchCache = new WeakMap();

function searchText(t) {
  let text = searchCache.get(t);
  if (text === undefined) {
    const parts = [t.id, t.title, t.status ?? '', t.live?.branch ?? '', t.live?.pr ? `#${t.live.pr}` : ''];
    for (const [key, value] of Object.entries(t.data)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v === null || typeof v === 'object') continue;
        parts.push(String(v));
        const label = state.board.fields[key]?.values?.[v];
        if (label) parts.push(label);
      }
    }
    text = parts.join('\n').toLowerCase();
    searchCache.set(t, text);
  }
  return text;
}

function matches(t) {
  for (const [name, value] of Object.entries(state.filters)) {
    const v = t.data[name];
    const values = (Array.isArray(v) ? v : [v]).map((x) => String(x ?? ''));
    if (!values.includes(value)) return false;
  }
  if (state.q) {
    const text = searchText(t);
    for (const word of state.q.toLowerCase().split(/\s+/).filter(Boolean))
      if (!text.includes(word)) return false;
  }
  return true;
}

function render() {
  const b = state.board;
  if (!b) return;
  const boardEl = $('#board');
  const focusedId = document.activeElement?.closest?.('.card')?.dataset.id ?? null;
  const filtering = !!state.q || Object.keys(state.filters).length > 0;
  const visible = b.tasks.filter(matches);
  const lane = state.lanes ? laneField() : null;

  const grid = h('div', { class: `grid${lane ? ' laned' : ''}` });
  grid.style.gridTemplateColumns = b.columns
    .map((c) => (isCollapsed(c) ? '44px' : 'minmax(244px, 1fr)'))
    .join(' ');

  b.columns.forEach((column, i) => {
    const shown = visible.filter((t) => t.column === i).length;
    grid.append(columnHead(column, i, filtering ? `${shown} / ${column.count}` : String(column.count)));
  });

  if (lane) {
    lanes(lane, visible).forEach(({ key, tasks }, laneIndex) => {
      const name = key === null ? 'None' : shortLabel(lane, key);
      grid.append(
        h(
          'div',
          { class: 'lane-head' },
          h(
            'div',
            { class: 'lane-label' },
            key === null || name === key ? null : h('span', {}, key),
            h('span', { class: 'lane-name' }, name),
            h('span', { class: 'count' }, String(tasks.length)),
          ),
        ),
      );
      b.columns.forEach((column, i) =>
        grid.append(cell(column, i, tasks.filter((t) => t.column === i), laneIndex === 0)),
      );
    });
    if (visible.length === 0) grid.append(h('p', { class: 'lane-head' }, 'No tasks match.'));
  } else {
    b.columns.forEach((column, i) => grid.append(cell(column, i, visible.filter((t) => t.column === i))));
  }

  boardEl.replaceChildren(grid);
  boardEl.setAttribute('aria-busy', 'false');
  markOpenCard();
  if (focusedId) boardEl.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
}

function lanes(field, tasks) {
  const order = fieldValues(field);
  const groups = new Map(order.map((v) => [v, []]));
  const none = [];
  for (const t of tasks) {
    const v = t.data[field];
    const key = v === null || v === undefined || v === '' ? null : String(v);
    if (key === null) none.push(t);
    else {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
  }
  const out = [...groups].filter(([, list]) => list.length).map(([key, list]) => ({ key, tasks: list }));
  if (none.length) out.push({ key: null, tasks: none });
  return out;
}

function columnHead(column, i, count) {
  const collapsed = isCollapsed(column);
  const title = column.other
    ? 'Tasks whose status matches no column'
    : column.droppable
      ? `Drop a card here to set ${state.board.statusField}: ${column.status}`
      : 'Set by open pull requests; cards can’t be dropped here';
  return h(
    'div',
    {
      class: `col-head${collapsed ? ' collapsed' : ''}${column.other ? ' other' : ''}`,
      'data-col': i,
      title,
    },
    collapsed ? null : h('span', { class: 'col-name' }, column.name),
    h('span', { class: 'count' }, count),
    h(
      'button',
      {
        class: 'col-toggle',
        type: 'button',
        'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${column.name}`,
        'aria-expanded': String(!collapsed),
        onclick: () => toggleColumn(column),
      },
      icon(collapsed ? 'chevronRight' : 'chevronLeft', 14),
    ),
  );
}

function toggleColumn(column) {
  state.collapsed[column.name] = !isCollapsed(column);
  saveCollapsed();
  render();
}

function cell(column, i, tasks, first = true) {
  const collapsed = isCollapsed(column);
  const el = h('div', { class: `cell${collapsed ? ' collapsed' : ''}`, 'data-col': i });
  if (!collapsed) append(el, tasks.map(card));
  else if (first)
    el.append(
      h(
        'button',
        {
          class: 'collapsed-name',
          type: 'button',
          title: `Expand ${column.name}`,
          onclick: () => toggleColumn(column),
        },
        column.name,
        h('span', { class: 'count' }, String(column.count)),
      ),
    );
  return el;
}

function card(t) {
  const b = state.board;
  const lock = lockReason(t);
  const fields = Object.entries(b.fields);
  const lane = state.lanes ? laneField() : null;
  const badges = fields
    .filter(([, f]) => f.badge)
    .flatMap(([name, f]) => {
      const v = t.data[name];
      if (v === null || v === undefined || v === '' || typeof v === 'object') return [];
      return [h('span', { class: 'badge', title: `${f.label}: ${fieldDisplay(name, v)}` }, shortLabel(name, v))];
    });
  const meta = fields
    .filter(([name, f]) => !f.badge && !f.list && (f.filter || f.swimlane) && name !== lane)
    .flatMap(([name, f]) => {
      const v = t.data[name];
      if (v === null || v === undefined || v === '' || typeof v === 'object') return [];
      return [h('span', { title: f.label }, shortLabel(name, v))];
    });

  const live = liveBadges(t);

  const pending = state.pending.has(t.id);
  return h(
    'article',
    {
      class: `card${lock ? ' locked' : ''}${pending ? ' pending' : ''}`,
      tabindex: '0',
      draggable: lock || pending ? 'false' : 'true',
      'data-id': t.id,
      'aria-label': `${t.id}: ${t.title}`,
      'aria-keyshortcuts': 'Enter M',
      title: lock ?? 'Drag to another column, or press M to move',
    },
    h(
      'div',
      { class: 'card-top' },
      h('span', { class: 'card-id' }, t.id),
      badges.length ? h('span', { class: 'badges' }, badges) : null,
      h(
        'button',
        {
          class: 'card-more',
          type: 'button',
          tabindex: '-1',
          'aria-label': `Move ${t.id}`,
          'aria-haspopup': 'menu',
          'data-action': 'menu',
        },
        icon('more', 14),
      ),
    ),
    h('div', { class: 'card-title' }, t.title),
    meta.length ? h('div', { class: 'card-meta' }, meta) : null,
    h('div', { class: 'card-live' }, live),
  );
}

/** Branch, PR, merged and uncommitted badges for a task. */
function liveBadges(t) {
  const b = state.board;
  const live = [];
  if (t.live?.state === 'in-progress')
    live.push(
      h(
        'span',
        { class: 'live progress', title: `In progress on branch ${t.live.branch}` },
        icon('branch', 12),
        h('span', { class: 'text mono' }, t.live.branch),
      ),
    );
  if (t.live?.state === 'in-review') {
    const url = prUrl(t.live.pr);
    const label = `#${t.live.pr}${t.live.note ? ` · ${t.live.note}` : ''}`;
    live.push(
      h(
        url ? 'a' : 'span',
        {
          class: 'live review',
          href: url,
          target: url ? '_blank' : null,
          rel: url ? 'noopener noreferrer' : null,
          title: `Open PR #${t.live.pr}${t.live.note ? ` (${t.live.note})` : ''} from ${t.live.branch}`,
        },
        icon('pr', 12),
        h('span', { class: 'text' }, label),
      ),
    );
  }
  if (t.merged) {
    const url = prUrl(t.merged.pr);
    live.push(
      h(
        url ? 'a' : 'span',
        {
          class: 'live merged',
          href: url,
          target: url ? '_blank' : null,
          rel: url ? 'noopener noreferrer' : null,
          title: `PR #${t.merged.pr} is merged, but the file still says ${b.statusField}: ${t.status}`,
        },
        icon('merged', 12),
        h('span', { class: 'text' }, `#${t.merged.pr} merged, file not updated`),
      ),
    );
  }
  if (t.modified)
    live.push(
      h('span', { class: 'live modified', title: 'This file has uncommitted changes' }, h('span', { class: 'dot' }), 'uncommitted'),
    );
  return live;
}

function markOpenCard() {
  for (const el of document.querySelectorAll('.card.open')) el.classList.remove('open');
  if (state.openTask)
    document.querySelector(`.card[data-id="${CSS.escape(state.openTask)}"]`)?.classList.add('open');
}

function focusCard(id) {
  document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.focus();
}

// ---------------------------------------------------------------------------------------------
// Moving cards

function confirmBranch(branch) {
  const dialog = $('#confirm');
  const text = $('#confirm-text');
  text.replaceChildren('You’re on ', h('code', {}, branch), '; edits will land on that branch.');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

async function moveTask(id, status) {
  const b = state.board;
  const t = taskById(id);
  if (!t || t.status === status || lockReason(t) || state.pending.has(id)) return;
  const target = b.columns.findIndex((c) => c.status === status);
  if (target === -1) return;
  if (b.branch && b.baseBranch && b.branch !== b.baseBranch && state.confirmedBranch !== b.branch) {
    if (!(await confirmBranch(b.branch))) return;
    state.confirmedBranch = b.branch;
  }

  // Show the card in its new column straight away; the reload below settles it.
  t.status = status;
  t.column = target;
  state.pending.add(id);
  render();

  const res = await api('PATCH', `/api/tasks/${encodeURIComponent(id)}`, { status, version: t.version });
  state.pending.delete(id);
  if (res.ok) {
    Object.assign(t, { status: res.data.task.status, version: res.data.task.version, modified: true });
    render();
    renderNotices();
    toast(`${id} moved to ${b.columns[target].name}.`);
    if (res.data.warning) {
      state.warning = { id, text: res.data.warning };
      renderNotices();
    }
  } else if (res.status === 409) {
    toast(`${id} changed on disk since the page loaded it, so nothing was written. It has been reloaded.`, 'error');
  } else {
    toast(res.data?.error ?? `Couldn't move ${id} (HTTP ${res.status}).`, 'error');
  }
  if (!state.openTask) focusCard(id);
  await loadBoard();
}

// Drag and drop

const boardEl = $('#board');
let hoverCol = null;

function setHover(col) {
  if (col === hoverCol) return;
  hoverCol = col;
  for (const el of boardEl.querySelectorAll('.drop-hover')) el.classList.remove('drop-hover');
  if (col !== null)
    for (const el of boardEl.querySelectorAll(`[data-col="${col}"]`)) el.classList.add('drop-hover');
}

function endDrag() {
  state.dragging = null;
  setHover(null);
  document.body.classList.remove('is-dragging');
  for (const el of boardEl.querySelectorAll('.drop-ok, .dragging'))
    el.classList.remove('drop-ok', 'dragging');
}

boardEl.addEventListener('dragstart', (event) => {
  const cardEl = event.target.closest?.('.card');
  const t = cardEl && taskById(cardEl.dataset.id);
  if (!t || lockReason(t)) {
    event.preventDefault();
    return;
  }
  closeMenu();
  state.dragging = t.id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', t.id);
  cardEl.classList.add('dragging');
  document.body.classList.add('is-dragging');
  for (const el of boardEl.querySelectorAll('[data-col]')) {
    const column = state.board.columns[Number(el.dataset.col)];
    if (column?.droppable && column.status !== t.status) el.classList.add('drop-ok');
  }
});

boardEl.addEventListener('dragover', (event) => {
  if (!state.dragging) return;
  const target = event.target.closest?.('[data-col]');
  if (target?.classList.contains('drop-ok')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setHover(Number(target.dataset.col));
  } else setHover(null);
});

boardEl.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget || !boardEl.contains(event.relatedTarget)) setHover(null);
});

boardEl.addEventListener('drop', (event) => {
  const target = event.target.closest?.('[data-col]');
  const id = state.dragging;
  if (!id || !target?.classList.contains('drop-ok')) return endDrag();
  event.preventDefault();
  const column = state.board.columns[Number(target.dataset.col)];
  endDrag();
  moveTask(id, column.status);
});

boardEl.addEventListener('dragend', endDrag);

// Clicks and keys on cards

boardEl.addEventListener('click', (event) => {
  const cardEl = event.target.closest('.card');
  if (!cardEl) return;
  if (event.target.closest('a')) return;
  if (event.target.closest('[data-action="menu"]')) {
    openMenu(cardEl.dataset.id, cardEl.querySelector('.card-more'));
    return;
  }
  openPanel(cardEl.dataset.id);
});

boardEl.addEventListener('keydown', (event) => {
  const cardEl = event.target.closest?.('.card');
  if (!cardEl || event.target !== cardEl) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openPanel(cardEl.dataset.id);
  } else if (
    ((event.key === 'm' || event.key === 'M') && !event.ctrlKey && !event.metaKey && !event.altKey) ||
    event.key === 'ContextMenu' ||
    (event.key === 'F10' && event.shiftKey)
  ) {
    event.preventDefault();
    openMenu(cardEl.dataset.id, cardEl.querySelector('.card-more') ?? cardEl);
  } else if (event.key.startsWith('Arrow')) {
    event.preventDefault();
    moveFocus(cardEl, event.key);
  }
});

/** Arrow keys move focus between cards: up and down in a column, left and right across columns. */
function moveFocus(cardEl, key) {
  const cards = [...boardEl.querySelectorAll('.card')];
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const siblings = [...cardEl.parentElement.querySelectorAll('.card')];
    const next = siblings[siblings.indexOf(cardEl) + (key === 'ArrowDown' ? 1 : -1)];
    next?.focus();
    return;
  }
  const col = Number(cardEl.parentElement.dataset.col);
  const top = cardEl.getBoundingClientRect().top;
  const step = key === 'ArrowRight' ? 1 : -1;
  for (let c = col + step; c >= 0 && c < state.board.columns.length; c += step) {
    const inColumn = cards.filter((el) => Number(el.parentElement.dataset.col) === c);
    if (!inColumn.length) continue;
    const nearest = inColumn.reduce((best, el) =>
      Math.abs(el.getBoundingClientRect().top - top) < Math.abs(best.getBoundingClientRect().top - top) ? el : best,
    );
    nearest.focus();
    return;
  }
}

// The move menu (moving without dragging)

const menuEl = $('#menu');
let menuFor = null;

function openMenu(id, anchor) {
  const t = taskById(id);
  if (!t) return;
  if (menuFor === id) return closeMenu(true);
  closeMenu();
  menuFor = id;
  const lock = lockReason(t);
  const items = [];
  if (!lock) {
    state.board.columns.forEach((column, i) => {
      if (!column.droppable || column.status === t.status) return;
      items.push(
        h(
          'button',
          {
            class: 'menu-item',
            type: 'button',
            role: 'menuitem',
            tabindex: '-1',
            onclick: () => {
              closeMenu();
              moveTask(id, column.status);
            },
          },
          h('span', {}, column.name),
          h('kbd', {}, column.status),
        ),
      );
    });
  }
  menuEl.replaceChildren(
    h('div', { class: 'menu-title' }, `Move ${t.id} to…`),
    ...(lock ? [h('p', { class: 'menu-note' }, lock)] : items),
    h('p', { class: 'menu-hint' }, 'Arrow keys to choose, Enter to move, Esc to close'),
  );
  menuEl.hidden = false;
  anchor?.setAttribute?.('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect();
  const width = menuEl.offsetWidth;
  const height = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
  menuEl.style.top = `${rect.bottom + 4 + height > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`;
  (menuEl.querySelector('.menu-item') ?? menuEl).focus();
  if (!menuEl.querySelector('.menu-item')) menuEl.tabIndex = -1;
}

function closeMenu(refocus = false) {
  if (menuFor === null) return;
  const id = menuFor;
  menuFor = null;
  menuEl.hidden = true;
  menuEl.replaceChildren();
  for (const el of document.querySelectorAll('.card-more[aria-expanded="true"]'))
    el.setAttribute('aria-expanded', 'false');
  if (refocus) focusCard(id);
}

menuEl.addEventListener('pointermove', (event) => {
  const item = event.target.closest?.('.menu-item');
  if (item && document.activeElement !== item) item.focus();
});

menuEl.addEventListener('keydown', (event) => {
  const items = [...menuEl.querySelectorAll('.menu-item')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!items.length) return;
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === 'Tab') {
    closeMenu(true);
  }
});

document.addEventListener('pointerdown', (event) => {
  if (menuFor !== null && !menuEl.contains(event.target) && !event.target.closest?.('[data-action="menu"]'))
    closeMenu();
});

// ---------------------------------------------------------------------------------------------
// The detail panel

const panelEl = $('#panel');
let panelRequest = 0;

function openPanel(id) {
  closeMenu();
  if (state.openTask === id && !panelEl.hidden) return;
  state.openTask = id;
  writeUrl(true);
  renderPanel();
}

function closePanel() {
  const id = state.openTask;
  state.openTask = null;
  state.panelVersion = null;
  panelEl.hidden = true;
  panelEl.replaceChildren();
  writeUrl(true);
  markOpenCard();
  if (id) focusCard(id);
}

async function renderPanel() {
  const id = state.openTask;
  if (!id) {
    panelEl.hidden = true;
    return;
  }
  const request = ++panelRequest;
  const summary = taskById(id);
  panelEl.hidden = false;
  markOpenCard();
  if (!panelEl.childElementCount || panelEl.dataset.id !== id)
    panelEl.replaceChildren(panelHead(id, summary?.title ?? ''), h('div', { class: 'panel-body muted' }, 'Loading…'));

  const res = await api('GET', `/api/tasks/${encodeURIComponent(id)}`);
  if (request !== panelRequest || state.openTask !== id) return;
  panelEl.dataset.id = id;
  if (!res.ok) {
    state.panelVersion = null;
    panelEl.replaceChildren(
      panelHead(id, ''),
      h('div', { class: 'panel-body' }, h('p', {}, res.data?.error ?? `Couldn't load ${id}.`)),
    );
    return;
  }
  const task = res.data;
  const t = taskById(id) ?? { ...task, live: null, merged: null, column: -1 };
  state.panelVersion = task.version;
  const scroll = panelEl.querySelector('.panel-body')?.scrollTop ?? 0;
  panelEl.replaceChildren(panelHead(id, task.title), panelBody(task, t));
  const body = panelEl.querySelector('.panel-body');
  if (body && panelEl.dataset.id === id) body.scrollTop = scroll;
}

function panelHead(id, title) {
  return h(
    'div',
    { class: 'panel-head' },
    h('div', { class: 'grow' }, h('span', { class: 'card-id' }, id), h('h2', {}, title)),
    h(
      'button',
      { class: 'icon-button', type: 'button', 'aria-label': 'Close details (Esc)', title: 'Close (Esc)', onclick: closePanel },
      icon('close', 16),
    ),
  );
}

function panelBody(task, t) {
  const b = state.board;
  const lock = lockReason(t);
  const column = b.columns[t.column];

  const statusRow = h('div', { class: 'panel-row' }, h('span', { class: 'label' }, 'Status'));
  if (!lock) {
    const select = h(
      'select',
      { 'aria-label': `Move ${t.id} to` },
      b.columns
        .filter((c) => c.droppable)
        .map((c) => h('option', { value: c.status, selected: c.status === t.status }, c.name)),
    );
    if (!b.columns.some((c) => c.droppable && c.status === t.status))
      select.prepend(h('option', { value: '', selected: true, disabled: true }, t.status ?? '(none)'));
    select.addEventListener('change', () => moveTask(t.id, select.value));
    statusRow.append(select);
  } else {
    statusRow.append(h('span', { class: 'status-pill' }, column?.name ?? t.status ?? '(none)'));
  }
  if (t.status && column?.status !== t.status)
    statusRow.append(h('span', { class: 'muted' }, `file says ${b.statusField}: ${t.status}`));

  const live = liveBadges(t);
  const liveRow = live.length ? h('div', { class: 'panel-row' }, h('span', { class: 'label' }, 'Live'), live) : null;

  const pathRow = h(
    'div',
    { class: 'panel-row' },
    h('span', { class: 'label' }, 'File'),
    h(
      'span',
      { class: 'path' },
      h('code', { title: task.absPath }, task.file),
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          'aria-label': 'Copy the file path',
          title: 'Copy path',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(task.file);
              toast('Path copied.');
            } catch {
              toast("Couldn't copy the path.", 'error');
            }
          },
        },
        icon('copy', 14),
      ),
    ),
    h(
      'a',
      { class: 'button small', href: `vscode://file/${encodeURI(task.absPath.replaceAll('\\', '/'))}` },
      'Open in VS Code',
    ),
  );

  const html = h('div', { class: 'markdown' });
  html.innerHTML = task.html; // Rendered on the server with raw HTML escaped.
  for (const a of html.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('?task=')) {
      a.addEventListener('click', (event) => {
        event.preventDefault();
        openPanel(new URLSearchParams(href.slice(1)).get('task'));
      });
    } else if (/^https?:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }

  return h(
    'div',
    { class: 'panel-body' },
    statusRow,
    liveRow,
    lock ? h('p', { class: 'lock-note' }, lock) : null,
    pathRow,
    h('h3', {}, 'Frontmatter'),
    frontmatterTable(task.data),
    task.body.trim() ? [h('h3', {}, 'Notes'), html] : null,
  );
}

function frontmatterTable(data) {
  const rows = Object.entries(data).map(([key, value]) => {
    const field = state.board.fields[key];
    let cellValue;
    if (value === null || value === undefined || value === '') cellValue = h('span', { class: 'none' }, '—');
    else if (Array.isArray(value))
      cellValue = value.length
        ? h('ul', {}, value.map((v) => h('li', {}, typeof v === 'object' ? JSON.stringify(v) : String(v))))
        : h('span', { class: 'none' }, 'none');
    else if (typeof value === 'object') cellValue = h('code', {}, JSON.stringify(value));
    else cellValue = fieldDisplay(key, value);
    return h('tr', {}, h('th', { scope: 'row', title: key }, field?.label ?? key), h('td', {}, cellValue));
  });
  return h('table', { class: 'fm-table' }, h('tbody', {}, rows));
}

// ---------------------------------------------------------------------------------------------
// Controls

let searchTimer;
$('#search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = event.target.value.trim();
    writeUrl();
    renderHeader();
    render();
  }, 120);
});

$('#filters').addEventListener('change', (event) => {
  const select = event.target.closest('select[data-field]');
  if (!select) return;
  if (select.value) state.filters[select.dataset.field] = select.value;
  else delete state.filters[select.dataset.field];
  select.classList.toggle('active', !!select.value);
  writeUrl();
  renderHeader();
  render();
});

$('#lanes').addEventListener('change', (event) => {
  state.lanes = event.target.checked;
  writeUrl();
  render();
});

$('#clear-filters').addEventListener('click', () => {
  state.q = '';
  state.filters = {};
  $('#search').value = '';
  writeUrl();
  renderHeader();
  renderFilters();
  render();
});

$('#refresh').addEventListener('click', async () => {
  const button = $('#refresh');
  button.disabled = true;
  button.textContent = 'Refreshing…';
  const res = await api('POST', '/api/refresh');
  button.disabled = false;
  button.textContent = 'Refresh';
  if (res.ok) {
    setBoard(res.data);
    toast('Branch and PR state refreshed.');
  } else toast(res.data?.error ?? `Refresh failed (HTTP ${res.status}).`, 'error');
});

document.addEventListener('keydown', (event) => {
  const typing = event.target.closest?.('input, select, textarea, [contenteditable]');
  if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    $('#search').focus();
  } else if (event.key === 'Escape') {
    if (menuFor !== null) closeMenu(true);
    else if (event.target === $('#search') && state.q) {
      $('#search').value = '';
      $('#search').dispatchEvent(new Event('input'));
    } else if (!panelEl.hidden && !$('#confirm').open) closePanel();
  }
});

window.addEventListener('popstate', () => {
  readUrl();
  renderHeader();
  renderFilters();
  render();
  if (state.openTask) renderPanel();
  else {
    panelEl.hidden = true;
    markOpenCard();
  }
});

// ---------------------------------------------------------------------------------------------
// Live updates: the server pushes `changed` when task files or branches change.

function connect() {
  const events = new EventSource('/api/events');
  events.addEventListener('changed', scheduleReload);
  events.addEventListener('open', () => {
    // The server restarted: its write token changed, so reload the whole page.
    if (state.connectionLost) location.reload();
  });
  events.addEventListener('error', () => {
    if (state.connectionLost || events.readyState === EventSource.OPEN) return;
    state.connectionLost = true;
    renderNotices();
  });
}

// PR state changes without touching any file, so check again every minute while the tab is visible.
setInterval(() => {
  if (document.visibilityState === 'visible' && !state.dragging) loadBoard();
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastLoad > 30_000) loadBoard();
});

readUrl();
loadBoard();
connect();
