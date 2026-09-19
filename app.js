/* 위시태그 — GitHub Pages 프론트엔드
 * 백엔드: Google Apps Script 웹 앱 (JSONP 전용. fetch는 CORS 때문에 동작하지 않음)
 */
(() => {
'use strict';

// iOS 13 이하 웹뷰용 (카카오톡 인앱은 시스템 웹뷰를 씀)
if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function (...nodes) { this.textContent = ''; this.append(...nodes); };
}

const API = window.WISHTAG_API ||
  'https://script.google.com/macros/s/AKfycbwjo-6rG-OGLRbf6LMFCWunqXqn0AT4q4U1iPkRbezZdnFISkjDPsdq2RceJQtwuyCQ/exec';
const POLL_MS = 30000;
const TIMEOUT_MS = 20000;
const MAX_URL = 8000;          // Apps Script는 약 8KB를 넘는 GET을 400으로 거절함
const SS_ADMIN = 'wishtag_admin';
const SS_BANNER = 'wishtag_banner_closed';

const MESSAGES = {
  'already-claimed': '방금 다른 분이 선점했어요. 다른 항목을 골라주세요!',
  'wrong-secret': '선점 암호가 맞지 않아요',
  'wrong-pin': '관리자 PIN이 맞지 않아요',
  'pin-changed': '다른 기기에서 PIN이 바뀌었어요. 새 PIN으로 다시 들어와주세요',
  'not-found': '항목을 찾을 수 없어요. 방금 삭제됐을 수 있어요',
  'busy': '지금 사람이 몰렸어요. 잠시 후 다시 시도해주세요',
  'network': '연결이 불안정해요. 네트워크를 확인하고 다시 시도해주세요',
  'too-long': '내용이 너무 길어요. 조금 줄여주세요',
  'no-crypto': '보안 연결(https)에서만 사용할 수 있어요',
  'unknown-op': '요청을 처리하지 못했어요',
  'server-error': '서버에 문제가 생겼어요. 잠시 후 다시 시도해주세요',
};

/* ---------- utils ---------- */
const $ = sel => document.querySelector(sel);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class ApiError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES['server-error']); this.code = code; }
}
class FieldError extends Error {
  constructor(field, message) { super(message); this.field = field; }
}

function storage(area) {
  return {
    get(k) { try { return window[area].getItem(k); } catch (_) { return null; } },
    set(k, v) { try { window[area].setItem(k, v); } catch (_) {} },
    del(k) { try { window[area].removeItem(k); } catch (_) {} },
  };
}
const session = storage('sessionStorage');
// 예전 버전이 저장해 둔 닉네임 자동 채우기 값 정리
try { localStorage.removeItem('wishtag_nick'); } catch (_) {}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}
const ICON_EXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

async function sha256Hex(text) {
  if (!window.crypto || !crypto.subtle) throw new ApiError('no-crypto');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(String(u).trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (_) { return ''; }
}
function normalizeLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // 쇼핑앱 "공유하기" 문구("[쿠팡] 상품명 https://...")를 통째로 붙여 넣어도 링크만 뽑아 씀
  const found = s.match(/https?:\/\/[^\s<>"']+/i);
  if (found) return safeUrl(found[0]);
  return /\s/.test(s) ? '' : safeUrl('https://' + s);
}

function fmtMonthDay(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtClock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function newItemId() {
  return 'item-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- transport (JSONP) ---------- */
let cbSeq = 0;
function jsonp(params) {
  return new Promise((resolve, reject) => {
    const cb = '__wishtag' + Date.now().toString(36) + '_' + (cbSeq++);
    const qs = Object.entries({ ...params, callback: cb, _: Date.now().toString(36) })
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const src = `${API}?${qs}`;
    if (src.length > MAX_URL) { reject(new ApiError('too-long')); return; }

    const el = document.createElement('script');
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window[cb] = () => {};   // 타임아웃 뒤 한참 늦게 도착한 응답도 에러를 내지 않도록 그대로 둠
      el.remove();
      fn(value);
    };
    window[cb] = data => finish(resolve, data);
    el.onerror = () => finish(reject, new ApiError('network'));
    // 스크립트가 실행됐는데 콜백이 안 불렸다면 서버가 HTML 에러 페이지를 돌려준 것
    el.onload = () => setTimeout(() => finish(reject, new ApiError('server-error')), 0);
    const timer = setTimeout(() => finish(reject, new ApiError('network')), TIMEOUT_MS);
    el.async = true;
    el.src = src;
    document.head.appendChild(el);
  });
}

let reqSeq = 0;
let appliedSeq = 0;
async function call(params) {
  const seq = ++reqSeq;
  const res = await jsonp(params);
  if (!res || typeof res !== 'object') throw new ApiError('server-error');
  if (res.state) applyState(res.state, seq);
  if (!res.ok) throw new ApiError(res.error || 'server-error');
  return res;
}

let opsInFlight = 0;
async function runOp(op) {
  opsInFlight++;
  syncBusy();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call({ action: 'op', payload: JSON.stringify(op) });
      } catch (err) {
        if (err.code === 'busy' && attempt < 2) { await sleep(700 * (attempt + 1)); continue; }
        if (err.code === 'network' || err.code === 'server-error') refresh({ quiet: true, force: true });
        if (err.code === 'wrong-pin' && 'adminPinHash' in op) {
          dropStaleAdmin(false);
          throw new ApiError('pin-changed');
        }
        throw err;
      }
    }
  } finally {
    opsInFlight--;
    syncBusy();
  }
}

/* ---------- state ---------- */
let state = null;
let lastSync = null;
let loadFailed = false;
let adminHash = session.get(SS_ADMIN);
let pendingPinHash = null;
const drafts = Object.create(null);   // itemId -> 입력 중인 닉네임
const cardEls = new Map();            // itemId -> element

const isAdmin = () => !!(adminHash && state && adminHash === state.adminPinHash);
const findItem = id => (state && state.items || []).find(it => it.id === id);

// 응답 순서가 뒤바뀌어도 더 오래된 데이터로 덮어쓰지 않도록 함.
// 서버의 updatedAt을 우선 기준으로 쓰고, 없으면 요청 순서로 판단
function isStale(s, seq) {
  if (state && typeof s.updatedAt === 'number' && typeof state.updatedAt === 'number') {
    return s.updatedAt < state.updatedAt;
  }
  return seq < appliedSeq;
}

function applyState(s, seq) {
  if (isStale(s, seq)) { lastSync = new Date(); renderSync(false); return; }
  appliedSeq = Math.max(appliedSeq, seq);
  state = s;
  state.items = Array.isArray(s.items) ? s.items : [];
  lastSync = new Date();
  loadFailed = false;
  reconcileAdmin();
  render();
}

function setAdmin(hash) {
  adminHash = hash;
  if (hash) session.set(SS_ADMIN, hash); else session.del(SS_ADMIN);
}
function reconcileAdmin() {
  if (!adminHash || !state) return;
  if (state.adminPinHash === adminHash) return;
  if (pendingPinHash && state.adminPinHash === pendingPinHash) {
    // 내가 바꾼 PIN이 (응답이 늦었더라도) 서버에 반영된 것
    setAdmin(pendingPinHash);
    pendingPinHash = null;
    return;
  }
  dropStaleAdmin();
}
function dropStaleAdmin(showToast = true) {
  if (!adminHash) return;
  setAdmin(null);
  headingDirty = false;
  if (showToast) toast(MESSAGES['pin-changed'], 4000);
  render();
}

let refreshing = null;
function refresh({ quiet = false, force = false } = {}) {
  if (refreshing) return refreshing;
  if (!force && (opsInFlight || sheetOpen)) return Promise.resolve();
  refreshing = call({ action: 'state' })
    .catch(err => {
      if (!state) { loadFailed = true; render(); }
      if (!quiet) toast(err.message);
      else if (state) renderSync(true);
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/* ---------- render ---------- */
const grid = $('#grid');

function render() {
  renderHeader();
  renderAdminPanel();
  renderGrid();
  renderSync(false);
  syncBusy();
}

function renderHeader() {
  const hEl = $('#heading');
  const sEl = $('#subheading');
  if (!state) return;
  const heading = state.heading || '위시태그';
  hEl.textContent = heading;
  hEl.classList.remove('is-loading');
  hEl.removeAttribute('aria-label');
  sEl.textContent = state.subheading || '';
  document.title = heading;

  const total = state.items.length;
  const claimed = state.items.filter(it => it.claimedBy).length;
  $('#progress').hidden = total === 0;
  $('#progressText').textContent = `${claimed} / ${total}`;
  $('#progressFill').style.width = total ? `${(claimed / total) * 100}%` : '0';

  const toggle = $('#adminToggle');
  toggle.classList.toggle('is-admin', isAdmin());
  $('#adminToggleLabel').textContent = isAdmin() ? '관리자 모드' : '관리자';
  if (isAdmin()) { $('#pinForm').hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
}

function renderSync(stale) {
  const label = $('#syncLabel');
  if (!state) { label.textContent = loadFailed ? '불러오지 못했어요' : '불러오는 중…'; return; }
  label.textContent = (stale ? '연결 끊김 · ' : '') + (lastSync ? `마지막 확인 ${fmtClock(lastSync)}` : '');
}

function renderSkeleton() {
  grid.replaceChildren(...Array.from({ length: 6 }, () =>
    h('div', { class: 'card skeleton', 'aria-hidden': 'true' },
      h('span', { class: 'sk sk-num' }), h('span', { class: 'sk sk-title' }),
      h('span', { class: 'sk sk-line' }), h('span', { class: 'sk sk-btn' }))));
}

function renderGrid() {
  if (!state) {
    if (loadFailed) {
      cardEls.clear();
      grid.setAttribute('aria-busy', 'false');
      grid.replaceChildren(h('div', { class: 'state-msg' },
        h('p', {}, '위시리스트를 불러오지 못했어요.', h('br'), '네트워크를 확인하고 다시 시도해주세요.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { loadFailed = false; renderSkeleton(); renderSync(); refresh({ force: true }); } }, '다시 시도')));
    }
    return;
  }
  grid.setAttribute('aria-busy', 'false');
  grid.querySelectorAll('.skeleton, .state-msg').forEach(el => el.remove());

  const items = state.items;
  if (!items.length) {
    cardEls.forEach(el => el.remove());
    cardEls.clear();
    if (!grid.querySelector('.state-msg')) {
      grid.append(h('div', { class: 'state-msg' }, h('p', {}, '아직 등록된 항목이 없어요.')));
    }
    return;
  }

  const admin = isAdmin();
  const active = document.activeElement;
  const refocusId = active && active.classList.contains('nick') ? active.closest('.card').dataset.id : null;
  const caret = refocusId ? active.selectionStart : null;

  // 없어진 카드를 먼저 빼야 뒤 카드들이 불필요하게 옮겨지지 않음(옮기면 입력 포커스가 풀림)
  const ids = new Set(items.map(it => it.id));
  for (const [id, el] of cardEls) {
    if (!ids.has(id)) { el.remove(); cardEls.delete(id); }
  }

  let prev = null;
  items.forEach((it, i) => {
    const sig = JSON.stringify([i, it.name, it.note, it.link, it.claimedBy, it.claimedAt, !!it.example, admin]);
    let el = cardEls.get(it.id);
    if (!el || el.dataset.sig !== sig) {
      const next = buildCard(it, i, admin);
      next.dataset.sig = sig;
      if (el) el.replaceWith(next);
      el = next;
      cardEls.set(it.id, el);
    }
    const want = prev ? prev.nextSibling : grid.firstChild;
    if (want !== el) grid.insertBefore(el, want);
    prev = el;
  });

  if (refocusId) {
    const card = cardEls.get(refocusId);
    const input = card && card.querySelector('.nick');
    if (input && document.activeElement !== input) {
      try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
      if (caret != null) { try { input.setSelectionRange(caret, caret); } catch (_) {} }
    }
  }
}

function buildCard(it, index, admin) {
  const claimed = !!it.claimedBy;
  const link = safeUrl(it.link);
  const num = String(index + 1).padStart(2, '0');

  let claimArea;
  if (claimed) {
    const date = fmtMonthDay(it.claimedAt);
    claimArea = h('div', { class: 'claim' },
      h('p', { class: 'claimed-by' },
        h('b', {}, it.claimedBy), '님이 선물 예정',
        date ? [' · ', h('span', { class: 'mono' }, `${date} 결정`)] : null),
      h('button', { type: 'button', class: 'text-btn', dataset: { act: 'unclaim' } }, '선점 취소'));
  } else {
    const nickId = `nick-${it.id}`;
    claimArea = h('div', { class: 'claim' },
      h('label', { class: 'sr-only', for: nickId }, `${it.name} 선점할 닉네임`),
      h('input', {
        class: 'nick', id: nickId, type: 'text', maxlength: '20', placeholder: '내 닉네임',
        autocomplete: 'off', enterkeyhint: 'go', 'aria-describedby': `${nickId}-err`,
        value: drafts[it.id] || '',
      }),
      // 토스트는 화면 아래라 휴대폰 키보드에 가려질 수 있어서 칸 바로 아래에 안내
      h('p', { class: 'nick-error', id: `${nickId}-err`, hidden: true }, '닉네임을 먼저 적어주세요'),
      h('button', { type: 'button', class: 'btn btn-primary', dataset: { act: 'claim' } }, '선점하기'));
  }

  return h('article', { class: 'card' + (claimed ? ' is-claimed' : ''), dataset: { id: it.id } },
    claimed ? h('span', { class: 'ribbon' }, '선물 확정') : null,
    h('div', { class: 'card-num' }, `No.${num}`, it.example ? h('span', { class: 'tag-example' }, '예시') : null),
    h('h3', { class: 'card-name' }, it.name || '(이름 없음)'),
    it.note ? h('p', { class: 'card-note' }, it.note) : null,
    link ? h('a', { class: 'card-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, '상품 보기', svg(ICON_EXT)) : null,
    claimArea,
    admin ? h('div', { class: 'card-admin' },
      h('button', { type: 'button', class: 'mini-btn', dataset: { act: 'edit' } }, '수정'),
      claimed ? h('button', { type: 'button', class: 'mini-btn', dataset: { act: 'release', confirm: '정말 해제?' } }, '선점 해제') : null,
      h('button', { type: 'button', class: 'mini-btn', dataset: { act: 'delete', confirm: '정말 삭제?' } }, '삭제')) : null);
}

function syncBusy() {
  const busy = opsInFlight > 0;
  // 작업 중에 새로고침을 누르면 작업 결과보다 오래된 목록이 덮어쓸 수 있어서 같이 막음
  document.querySelectorAll('[data-act], #adminPanel button, #pinForm button, #refreshBtn').forEach(b => {
    if (b.classList.contains('is-loading')) return;
    b.disabled = busy;
  });
}

async function withLoading(btn, fn) {
  btn.classList.add('is-loading');
  btn.disabled = true;
  try { return await fn(); }
  finally {
    btn.classList.remove('is-loading');
    btn.disabled = opsInFlight > 0;
  }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

/* ---------- sheet (modal) ---------- */
let sheetOpen = false;
let sheetSubmitting = false;
let sheetOpenedAt = 0;
let sheetReturn = null;   // { el, cardId, act } — 닫은 뒤 포커스를 돌려줄 곳

function rememberReturnFocus() {
  const el = document.activeElement;
  const card = el && el.closest ? el.closest('.card') : null;
  sheetReturn = { el, cardId: card ? card.dataset.id : null, act: el && el.dataset ? el.dataset.act : null };
}
function restoreReturnFocus() {
  const r = sheetReturn;
  sheetReturn = null;
  if (!r) return;
  let target = r.el && document.contains(r.el) ? r.el : null;
  if (!target && r.cardId) {
    // 카드가 다시 그려졌으면 같은 카드 안의 같은 버튼(없으면 첫 버튼·링크)으로.
    // 입력칸은 제외함(휴대폰에서 키보드가 갑자기 올라오므로)
    const card = cardEls.get(r.cardId);
    if (card) target = (r.act && card.querySelector(`[data-act="${r.act}"]`)) || card.querySelector('button, a');
  }
  if (target) { try { target.focus({ preventScroll: true }); } catch (_) {} }
}

// 휴대폰 키보드가 올라오면 시트를 보이는 영역(visual viewport)에 맞춰 버튼이 가려지지 않게 함
function fitSheetToViewport() {
  const root = $('#sheet');
  const vv = window.visualViewport;
  if (!sheetOpen || !vv) { root.style.top = root.style.height = root.style.bottom = ''; return; }
  root.style.top = `${vv.offsetTop}px`;
  root.style.height = `${vv.height}px`;
  root.style.bottom = 'auto';
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitSheetToViewport);
  visualViewport.addEventListener('scroll', fitSheetToViewport);
}

function openSheet({ title, item, text, fields = [], submitLabel, danger = false, onSubmit }) {
  const root = $('#sheet');
  rememberReturnFocus();
  const errorEl = h('p', { class: 'sheet-error', role: 'alert', hidden: true });
  const submitBtn = h('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary') }, submitLabel);
  const inputs = {};

  const fieldEls = fields.map(f => {
    const id = `sheet-${f.name}`;
    const Tag = f.multiline ? 'textarea' : 'input';
    const input = h(Tag, {
      id, name: f.name, type: f.multiline ? null : (f.type || 'text'),
      value: f.value || '', placeholder: f.placeholder || '', maxlength: f.maxlength ? String(f.maxlength) : null,
      autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      inputmode: f.inputmode || null, required: !!f.required, enterkeyhint: 'go',
    });
    if (f.multiline) input.value = f.value || '';
    inputs[f.name] = input;
    const err = h('span', { class: 'field-error', hidden: true });
    input.addEventListener('input', () => { err.hidden = true; input.classList.remove('is-invalid'); });
    return h('div', { class: 'field', dataset: { field: f.name } },
      h('label', { class: 'field-label', for: id }, f.label),
      input,
      f.hint ? h('span', { class: 'field-hint' }, f.hint) : null,
      err);
  });

  const form = h('form', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheetTitle', novalidate: true },
    h('h2', { class: 'sheet-title', id: 'sheetTitle' }, title),
    item ? h('p', { class: 'sheet-item' }, item) : null,
    text ? h('p', { class: 'sheet-text' }, text) : null,
    fieldEls.length ? h('div', { class: 'sheet-fields' }, fieldEls) : null,
    errorEl,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => closeSheet() }, '닫기'),
      submitBtn));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (sheetSubmitting) return;
    errorEl.hidden = true;
    const values = {};
    for (const [k, el] of Object.entries(inputs)) values[k] = el.value;
    sheetSubmitting = true;
    submitBtn.classList.add('is-loading');
    form.querySelectorAll('button, input, textarea').forEach(el => { if (el !== submitBtn) el.disabled = true; });
    try {
      await onSubmit(values);
      sheetSubmitting = false;
      closeSheet();
    } catch (err) {
      sheetSubmitting = false;
      if (!sheetOpen) { toast(err.message || MESSAGES['server-error']); return; }
      if (err instanceof FieldError) {
        const wrap = form.querySelector(`[data-field="${err.field}"]`);
        const fe = wrap.querySelector('.field-error');
        fe.textContent = err.message;
        fe.hidden = false;
        inputs[err.field].classList.add('is-invalid');
        setTimeout(() => inputs[err.field].focus(), 0);
      } else if (err.code === 'already-claimed' || err.code === 'not-found' || err.code === 'pin-changed') {
        closeSheet();
        toast(err.message, 3500);
      } else {
        errorEl.textContent = err.message || MESSAGES['server-error'];
        errorEl.hidden = false;
      }
    } finally {
      submitBtn.classList.remove('is-loading');
      form.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = false; });
    }
  });

  // 선점하기를 두 번 톡톡 누르면 두 번째 탭이 배경에 떨어져 바로 닫히는 걸 막음
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: () => { if (Date.now() - sheetOpenedAt > 400) closeSheet(); } });
  root.replaceChildren(backdrop, form);
  root.hidden = false;
  sheetOpen = true;
  sheetSubmitting = false;
  sheetOpenedAt = Date.now();
  document.body.classList.add('sheet-open');
  fitSheetToViewport();
  // 클릭 핸들러 안에서 동기적으로 포커스해야 iOS가 키보드를 바로 띄움
  const first = form.querySelector('input, textarea') || submitBtn;
  try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); }
}

// 요청이 진행 중일 때는 닫지 않음(닫으면 결과·오류를 볼 수 없음)
function closeSheet() {
  if (!sheetOpen || sheetSubmitting) return;
  const root = $('#sheet');
  root.hidden = true;
  root.replaceChildren();
  sheetOpen = false;
  document.body.classList.remove('sheet-open');
  fitSheetToViewport();
  restoreReturnFocus();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheetOpen) closeSheet();
});

/* ---------- claim / unclaim ---------- */
function startClaim(item, card) {
  const input = card.querySelector('.nick');
  const nickname = (input.value || '').trim();
  if (!nickname) {
    input.classList.remove('is-invalid');
    void input.offsetWidth;
    input.classList.add('is-invalid');
    const hint = card.querySelector('.nick-error');
    if (hint) hint.hidden = false;
    input.focus();
    return;
  }
  openSheet({
    title: '선점하기',
    item: item.name,
    text: `${nickname}님 이름으로 선점할게요. 나중에 직접 취소할 때 쓸 암호를 정해주세요.`,
    fields: [{
      name: 'secret', label: '선점 암호', maxlength: 40, required: true,
      placeholder: '4자 이상', hint: '까먹지 않을 걸로! 취소할 때만 써요.',
    }],
    submitLabel: '선점 확정',
    async onSubmit({ secret }) {
      if (secret.trim().length < 4) throw new FieldError('secret', '암호는 4자 이상으로 정해주세요');
      const secretHash = await sha256Hex(secret.trim());
      try {
        await runOp({ type: 'claim', itemId: item.id, nickname, secretHash, claimedAt: Date.now() });
      } catch (err) {
        // 앞선 요청이 응답만 늦고 사실은 저장됐던 경우: 선점한 사람이 바로 나 자신
        const now = findItem(item.id);
        if (err.code !== 'already-claimed' || !now || now.claimSecretHash !== secretHash) throw err;
      }
      delete drafts[item.id];
      toast(`선점 완료! ${nickname}님 고마워요`);
    },
  });
}

function startUnclaim(item) {
  openSheet({
    title: '선점 취소',
    item: item.name,
    text: `${item.claimedBy}님이 선점한 항목이에요. 선점할 때 정한 암호를 넣어주세요.`,
    fields: [{ name: 'secret', label: '선점 암호', maxlength: 40, required: true }],
    submitLabel: '선점 취소하기',
    danger: true,
    async onSubmit({ secret }) {
      if (!secret.trim()) throw new FieldError('secret', '암호를 입력해주세요');
      const secretHash = await sha256Hex(secret.trim());
      try {
        await runOp({ type: 'unclaim', itemId: item.id, secretHash });
      } catch (err) {
        if (err.code === 'wrong-secret') throw new FieldError('secret', '암호가 맞지 않아요');
        throw err;
      }
      toast('선점을 취소했어요');
    },
  });
}

/* ---------- admin: card actions ---------- */
function startEdit(item) {
  openSheet({
    title: '항목 수정',
    fields: [
      { name: 'name', label: '이름', value: item.name, maxlength: 80, required: true },
      { name: 'note', label: '메모', value: item.note, maxlength: 120 },
      { name: 'link', label: '링크', value: item.link, maxlength: 600, inputmode: 'url' },
    ],
    submitLabel: '저장',
    async onSubmit({ name, note, link }) {
      if (!isAdmin()) throw new ApiError('pin-changed');
      if (!name.trim()) throw new FieldError('name', '이름을 입력해주세요');
      const clean = normalizeLink(link);
      if (link.trim() && !clean) throw new FieldError('link', '올바른 주소가 아니에요');
      await runOp({ type: 'edit-item', itemId: item.id, name: name.trim(), note: note.trim(), link: clean, adminPinHash: adminHash });
      toast('수정했어요');
    },
  });
}

const confirmTimers = new WeakMap();
function armConfirm(btn) {
  if (btn.classList.contains('is-confirm')) return true;
  btn.dataset.label = btn.textContent;
  btn.textContent = btn.dataset.confirm;
  btn.classList.add('is-confirm');
  confirmTimers.set(btn, setTimeout(() => disarmConfirm(btn), 4000));
  return false;
}
function disarmConfirm(btn) {
  clearTimeout(confirmTimers.get(btn));
  if (!btn.classList.contains('is-confirm')) return;
  btn.classList.remove('is-confirm');
  btn.textContent = btn.dataset.label;
}

async function adminCardAction(btn, item, op, doneMsg) {
  if (!armConfirm(btn)) return;
  disarmConfirm(btn);
  try {
    await withLoading(btn, () => runOp({ ...op, itemId: item.id, adminPinHash: adminHash }));
    toast(doneMsg);
  } catch (err) {
    toast(err.message);
  }
}

grid.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled || !state) return;
  const card = btn.closest('.card');
  const item = card && findItem(card.dataset.id);
  if (!item) return;
  switch (btn.dataset.act) {
    case 'claim': startClaim(item, card); break;
    case 'unclaim': startUnclaim(item); break;
    case 'edit': if (isAdmin()) startEdit(item); break;
    case 'release': if (isAdmin()) adminCardAction(btn, item, { type: 'admin-release' }, '선점을 해제했어요'); break;
    case 'delete': if (isAdmin()) adminCardAction(btn, item, { type: 'delete-item' }, '삭제했어요'); break;
  }
});
grid.addEventListener('input', e => {
  if (!e.target.classList.contains('nick')) return;
  const card = e.target.closest('.card');
  drafts[card.dataset.id] = e.target.value;
  e.target.classList.remove('is-invalid');
  const hint = card.querySelector('.nick-error');
  if (hint) hint.hidden = true;
});
grid.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  if (!e.target.classList.contains('nick')) return;
  e.preventDefault();
  const card = e.target.closest('.card');
  const item = findItem(card.dataset.id);
  if (item && !opsInFlight) startClaim(item, card);
});

/* ---------- admin: login ---------- */
const pinForm = $('#pinForm');
$('#adminToggle').addEventListener('click', () => {
  if (isAdmin()) {
    $('#adminPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  pinForm.hidden = !pinForm.hidden;
  $('#adminToggle').setAttribute('aria-expanded', String(!pinForm.hidden));
  if (!pinForm.hidden) $('#pinInput').focus();
});

pinForm.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#pinInput');
  const pin = input.value;
  if (!pin) { input.focus(); return; }
  if (!state) { toast('아직 불러오는 중이에요'); return; }
  let hash;
  try { hash = await sha256Hex(pin); } catch (err) { toast(err.message); return; }
  if (hash !== state.adminPinHash) {
    // 다른 기기에서 방금 PIN을 바꿨을 수 있으니 최신 상태로 한 번 더 확인
    await withLoading(submitButton(pinForm), () => refresh({ force: true, quiet: true }));
  }
  if (hash !== state.adminPinHash) {
    input.classList.remove('is-invalid');
    void input.offsetWidth;
    input.classList.add('is-invalid');
    input.select();
    toast('PIN이 맞지 않아요');
    return;
  }
  input.value = '';
  setAdmin(hash);
  headingDirty = false;
  render();
  toast('관리자 모드로 전환했어요');
  $('#adminPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#adminLogout').addEventListener('click', () => {
  setAdmin(null);
  render();
  toast('관리자 모드를 끝냈어요');
});

/* ---------- admin: panel ---------- */
let headingDirty = false;
const headingForm = $('#headingForm');
function updateSubCounter() {
  const ta = headingForm.subheading;
  $('#subCounter').textContent = `${ta.value.length} / ${ta.maxLength}`;
}
headingForm.addEventListener('input', () => { headingDirty = true; updateSubCounter(); });

function renderAdminPanel() {
  const panel = $('#adminPanel');
  const admin = isAdmin();
  panel.hidden = !admin;
  if (!admin) return;
  if (!headingDirty) {
    headingForm.heading.value = state.heading || '';
    headingForm.subheading.value = state.subheading || '';
    updateSubCounter();
  }
  const examples = state.items.filter(it => it.example).length;
  const btn = $('#clearExamples');
  btn.hidden = examples === 0;
  if (!btn.classList.contains('is-confirm')) btn.textContent = `예시 항목 ${examples}개 지우기`;
}

function submitButton(form) { return form.querySelector('button[type="submit"]'); }

function showCard(id) {
  const el = cardEls.get(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('is-new');
  void el.offsetWidth;
  el.classList.add('is-new');
}

// 응답이 늦어 실패로 보였지만 실제로는 저장된 경우, 다시 눌러도 중복으로 추가되지 않도록
// 같은 내용이면 같은 항목 id를 재사용하고 서버 목록에 이미 있는지 먼저 확인함
let pendingAdd = null;   // { key, id }

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const name = form.name.value.trim();
  const note = form.note.value.trim();
  const rawLink = form.link.value.trim();
  const link = normalizeLink(rawLink);
  if (!name) { form.name.focus(); toast('이름을 입력해주세요'); return; }
  if (rawLink && !link) { form.link.focus(); toast('링크 주소를 확인해주세요'); return; }
  const btn = submitButton(form);
  const key = JSON.stringify([name, note, link]);
  const retrying = pendingAdd && pendingAdd.key === key;
  if (!retrying) pendingAdd = { key, id: newItemId() };
  const id = pendingAdd.id;
  const done = msg => { pendingAdd = null; form.reset(); toast(msg); setTimeout(() => showCard(id), 50); };
  try {
    if (retrying) {
      // 진행 중인 느린 조회를 재사용하지 않고 새로 조회함. 조회가 실패하면 다시 보내지 않음(중복 방지)
      await withLoading(btn, () => call({ action: 'state' }));
      if (findItem(id)) { done(`이미 추가돼 있어요 (‘${name}’)`); return; }
    }
    await withLoading(btn, () => runOp({ type: 'add-item', item: { id, name, note, link }, adminPinHash: adminHash }));
    done(`‘${name}’ 추가했어요`);
  } catch (err) {
    if (err.code !== 'network' && err.code !== 'server-error') pendingAdd = null;
    toast(err.message);
  }
});

headingForm.addEventListener('submit', async e => {
  e.preventDefault();
  const heading = headingForm.heading.value.trim();
  const subheading = headingForm.subheading.value.replace(/\s+$/, '');
  if (!heading) { headingForm.heading.focus(); toast('제목을 입력해주세요'); return; }
  try {
    await withLoading(submitButton(headingForm), () =>
      runOp({ type: 'edit-heading', heading, subheading, adminPinHash: adminHash }));
    headingDirty = false;
    renderAdminPanel();
    toast('제목과 설명을 저장했어요');
  } catch (err) { toast(err.message); }
});

$('#pinChangeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const current = form.current.value;
  const next = form.next.value;
  if (!current || !next) { toast('PIN을 모두 입력해주세요'); return; }
  if (next.length < 4) { form.next.focus(); toast('새 PIN은 4자 이상으로 해주세요'); return; }
  if (next !== form.confirm.value) { form.confirm.focus(); toast('새 PIN이 서로 달라요'); return; }
  try {
    const currentPinHash = await sha256Hex(current);
    if (currentPinHash !== state.adminPinHash) { form.current.focus(); toast('현재 PIN이 맞지 않아요'); return; }
    const newHash = await sha256Hex(next);
    pendingPinHash = newHash;
    await withLoading(submitButton(form), () => runOp({ type: 'change-pin', currentPinHash, newHash }));
    pendingPinHash = null;
    setAdmin(newHash);
    form.reset();
    toast('PIN을 바꿨어요');
  } catch (err) {
    // 응답만 늦은 경우엔 서버에 반영됐을 수 있으니, 다음 동기화에서 확인되도록 pendingPinHash를 남겨 둠
    if (err.code !== 'network' && err.code !== 'server-error') pendingPinHash = null;
    toast(err.code === 'wrong-pin' ? '현재 PIN이 맞지 않아요' : err.message);
  }
});

$('#clearExamples').addEventListener('click', async e => {
  const btn = e.currentTarget;
  if (!btn.dataset.confirm) btn.dataset.confirm = '정말 지울까요?';
  if (!armConfirm(btn)) return;
  disarmConfirm(btn);
  try {
    await withLoading(btn, () => runOp({ type: 'clear-examples', adminPinHash: adminHash }));
    toast('예시 항목을 지웠어요');
  } catch (err) { toast(err.message); }
});

/* ---------- footer ---------- */
$('#refreshBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  await refresh({ force: true });
  btn.disabled = false;
});

/* ---------- in-app browser banner ---------- */
function setupInappBanner() {
  const ua = navigator.userAgent || '';
  const app =
    /KAKAOTALK/i.test(ua) ? { key: 'kakao', name: '카카오톡' } :
    /Instagram/i.test(ua) ? { key: 'instagram', name: '인스타그램' } :
    /FBAN|FBAV|FB_IAB|FBIOS/i.test(ua) ? { key: 'facebook', name: '페이스북' } :
    /\bLine\//i.test(ua) ? { key: 'line', name: '라인' } :
    /NAVER\(inapp|\bNAVER\b/.test(ua) ? { key: 'naver', name: '네이버 앱' } : null;
  if (!app || session.get(SS_BANNER)) return;

  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  // 안드로이드는 기본 브라우저가 크롬이 아닐 수도 있어서(삼성 인터넷 등) 특정 앱을 단정하지 않음
  const browserTo = isIOS ? '사파리로' : '크롬 같은 다른 브라우저로';
  const here = location.href;

  let openLabel = null;
  let openUrl = null;
  if (app.key === 'kakao') {
    openLabel = isIOS ? '사파리로 열기' : '다른 브라우저로 열기';
    openUrl = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(here);
  } else if (app.key === 'line') {
    openLabel = isIOS ? '사파리로 열기' : '다른 브라우저로 열기';
    const u = new URL(here);
    u.searchParams.set('openExternalBrowser', '1');
    openUrl = u.href;
  } else if (isAndroid) {
    openLabel = '크롬으로 열기';
    const u = new URL(here);
    openUrl = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(here)};end`;
  }

  const text = $('#inappText');
  text.replaceChildren(...[
    `${app.name} 안에서 열렸어요. 쇼핑몰 링크가 잘 안 열릴 수 있으니 `,
    h('b', {}, `${browserTo} 열어주세요.`),
    openUrl ? null : ' 오른쪽 위 ··· 메뉴에서 ‘외부 브라우저로 열기’를 눌러주세요.',
  ].filter(Boolean));

  const openBtn = $('#inappOpen');
  if (openUrl) {
    openBtn.textContent = openLabel;
    openBtn.hidden = false;
    openBtn.addEventListener('click', () => { location.href = openUrl; });
  }
  $('#inappCopy').addEventListener('click', () => copyText(here));
  $('#inappClose').addEventListener('click', () => {
    $('#inappBanner').hidden = true;
    session.set(SS_BANNER, '1');
  });
  $('#inappBanner').hidden = false;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('링크를 복사했어요');
    return;
  } catch (_) {}
  const ta = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  ta.remove();
  toast(ok ? '링크를 복사했어요' : '복사가 안 돼요. 주소창의 링크를 길게 눌러 복사해주세요');
}

/* ---------- lifecycle ---------- */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh({ quiet: true });
});
window.addEventListener('pageshow', e => { if (e.persisted) refresh({ quiet: true }); });
window.addEventListener('online', () => refresh({ quiet: true }));
setInterval(() => {
  if (document.visibilityState === 'visible') refresh({ quiet: true });
}, POLL_MS);

setupInappBanner();
renderSkeleton();
refresh({ force: true });

})();
