/* ============================================================
   DeepSeek 额度台账 — 逻辑
   唯一网络请求：GET https://api.deepseek.com/user/balance（官方接口）
   密钥只保存在浏览器 localStorage，绝不上传
   ============================================================ */
'use strict';

/* ---------- 常量 ---------- */
const API_URL = 'https://api.deepseek.com/user/balance';
const STORE_KEY = 'dsbb.v1';

const STATUS = {
  idle:       { label: '未查询', cls: 'st-idle' },
  checking:   { label: '查询中', cls: 'st-checking' },
  ok:         { label: '可用',   cls: 'st-ok' },
  unavailable:{ label: '欠费',   cls: 'st-unavailable', tip: '接口返回 is_available: false（通常是余额为 0）' },
  invalid:    { label: '无效',   cls: 'st-invalid' },
  error:      { label: '失败',   cls: 'st-error' },
};

const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$', SGD: 'S$' };

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  keyInput: $('keyInput'), parseHint: $('parseHint'), btnQueryNew: $('btnQueryNew'),
  concurrency: $('concurrency'),
  progressPanel: $('progressPanel'), progressFill: $('progressFill'),
  progressBar: $('progressBar'), progressText: $('progressText'), btnStop: $('btnStop'),
  summary: $('summary'),
  searchInput: $('searchInput'), statusFilter: $('statusFilter'), sortSelect: $('sortSelect'),
  btnRefreshAll: $('btnRefreshAll'),
  btnExportJson: $('btnExportJson'), btnExportCsv: $('btnExportCsv'),
  btnImport: $('btnImport'), fileInput: $('fileInput'),
  btnMask: $('btnMask'), btnClear: $('btnClear'),
  ledgerBody: $('ledgerBody'), selAll: $('selAll'),
  emptyState: $('emptyState'), emptyText: $('emptyText'),
  batchBar: $('batchBar'), selCount: $('selCount'),
  btnDeleteSelected: $('btnDeleteSelected'), btnClearSelection: $('btnClearSelection'),
  themeBtn: $('themeBtn'),
  backdrop: $('modalBackdrop'), modalTitle: $('modalTitle'), modalBody: $('modalBody'),
  modalOk: $('modalOk'), modalCancel: $('modalCancel'), modalX: $('modalX'),
  toasts: $('toasts'),
};

/* ---------- 状态 ---------- */
const state = {
  entries: [],          // { id, key, remark, addedAt, lastCheckedAt, status, isAvailable, balances[], lastError }
  settings: { concurrency: 3, mask: true, theme: 'auto' },
};
const ui = {
  search: '', statusFilter: 'all', sort: 'added_desc',
  selected: new Set(), revealed: new Set(),
  querying: false, stopFlag: false, abortCtrl: null,
};

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 1,
        entries: state.entries,
        settings: state.settings,
      }));
    } catch (e) {
      console.warn('保存到 localStorage 失败', e);
      toast('本地保存失败：浏览器存储不可用', 'bad');
    }
  }, 250);
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!data) return;
    if (Array.isArray(data.entries)) {
      state.entries = data.entries.filter((e) => e && typeof e.key === 'string');
      // 补齐缺失字段（兼容旧版本备份）
      for (const e of state.entries) {
        e.id = e.id || genId();
        e.remark = typeof e.remark === 'string' ? e.remark : '';
        e.addedAt = Number(e.addedAt) || Date.now();
        e.balances = Array.isArray(e.balances) ? e.balances : [];
        e.lastError = typeof e.lastError === 'string' ? e.lastError : '';
        e.isAvailable = typeof e.isAvailable === 'boolean' ? e.isAvailable : null;
        // 页面刷新后不残留「查询中」的中间态
        if (e.status === 'checking') e.status = e.balances.length ? 'ok' : 'idle';
      }
    }
    Object.assign(state.settings, data.settings || {});
  } catch { /* 忽略损坏的存量数据 */ }
}

/* ---------- 小工具 ---------- */
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const genId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

function keyDisplay(entry, revealed) {
  if (revealed) return entry.key;
  const tail = entry.key.slice(-4);
  const head = entry.key.startsWith('sk-') ? 'sk-' : entry.key.slice(0, 2);
  return `${head}${'•'.repeat(8)}${tail}`;
}

function fmtMoney(n, currency) {
  if (n == null || Number.isNaN(n)) return '—';
  const num = n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = CURRENCY_SYMBOL[currency] ?? '';
  return sym ? `${sym}${num}` : `${num} ${currency || ''}`.trim();
}

function fmtRel(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 45e3) return '刚刚';
  if (diff < 36e5) return `${Math.round(diff / 6e4)} 分钟前`;
  if (diff < 864e5) return `${Math.round(diff / 36e5)} 小时前`;
  if (diff < 25.92e8) return `${Math.round(diff / 864e5)} 天前`;
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const fmtAbs = (ts) => ts ? new Date(ts).toLocaleString('zh-CN') : '';

/* ---------- 密钥解析 ---------- */
function parseKeys(text) {
  const tokens = String(text).split(/[\s,;，；、]+/).map((t) => t.trim()).filter(Boolean);
  const keys = new Set();
  for (const t of tokens) {
    if (/^sk-[A-Za-z0-9]{16,}$/.test(t)) keys.add(t);                 // 标准格式
    else if (/^[A-Za-z0-9_-]{32,64}$/.test(t)) keys.add(t);           // 容错：缺失前缀
  }
  return [...keys];
}

/* ---------- 查询 ---------- */
function friendlyError(httpStatus, serverMsg) {
  if (httpStatus === 401) return '密钥无效或已被删除';
  if (httpStatus === 429) return '请求过于频繁，请降低并发后重试';
  if (httpStatus === 402) return '账号已被封禁或欠费';
  if (httpStatus >= 500) return `DeepSeek 服务端错误（HTTP ${httpStatus}）`;
  return serverMsg || `请求失败（HTTP ${httpStatus}）`;
}

async function fetchBalance(key, signal) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    return { ok: false, message: '网络错误：无法连接 api.deepseek.com（检查网络或代理）' };
  }

  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 响应 */ }

  if (res.ok && body && Array.isArray(body.balance_infos)) {
    return {
      ok: true,
      isAvailable: !!body.is_available,
      balances: body.balance_infos.map((b) => ({
        currency: b.currency || '—',
        total: Number.parseFloat(b.total_balance),
        granted: Number.parseFloat(b.granted_balance),
        tossed: Number.parseFloat(b.tossed_balance),
      })),
      raw: body,
    };
  }
  const serverMsg = body && body.error && body.error.message ? body.error.message : '';
  return {
    ok: false,
    httpStatus: res.status,
    message: friendlyError(res.status, serverMsg),
    serverMsg,
    raw: body,
  };
}

function applyResult(entry, result) {
  entry.lastCheckedAt = Date.now();
  if (result.ok) {
    entry.isAvailable = result.isAvailable;
    entry.balances = result.balances;
    entry.lastError = '';
    entry.status = result.isAvailable ? 'ok' : 'unavailable';
    if (!result.balances.length) {
      entry.status = 'error';
      entry.lastError = '接口未返回余额信息';
    }
  } else {
    entry.status = 'invalid';
    if (result.httpStatus !== 401) entry.status = 'error';
    entry.balances = [];
    entry.isAvailable = null;
    entry.lastError = [result.message, result.serverMsg].filter(Boolean).join(' · ');
  }
}

async function queryEntries(list) {
  if (!list.length || ui.querying) return;
  const total = list.length;
  let done = 0, okCount = 0, failCount = 0;

  ui.querying = true;
  ui.stopFlag = false;
  ui.abortCtrl = new AbortController();
  els.progressPanel.hidden = false;
  els.btnRefreshAll.disabled = true;
  updateProgress(0, total, 0, 0);
  render();

  let cursor = 0;
  const worker = async () => {
    while (!ui.stopFlag) {
      const i = cursor++;
      if (i >= list.length) break;
      const entry = list[i];
      entry.status = 'checking';
      renderRow(entry);

      let result;
      try {
        result = await fetchBalance(entry.key, ui.abortCtrl.signal);
      } catch (err) {
        result = { ok: false, message: '已手动取消' };
      }
      applyResult(entry, result);
      if (result.ok) okCount++; else failCount++;
      done++;
      updateProgress(done, total, okCount, failCount);
      renderRow(entry);
      save();
    }
  };

  const n = Math.max(1, Math.min(Number(els.concurrency.value) || 3, 8, total));
  await Promise.all(Array.from({ length: n }, worker));

  ui.querying = false;
  els.progressPanel.hidden = true;
  els.btnRefreshAll.disabled = false;
  render();
  save();
  toast(`查询完成：成功 ${okCount} · 失败 ${failCount}`, failCount && !okCount ? 'bad' : 'ok');
}

function updateProgress(done, total, ok, fail) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = `${pct}%`;
  els.progressBar.setAttribute('aria-valuenow', String(pct));
  els.progressText.textContent = `${done} / ${total}（成功 ${ok} · 失败 ${fail}）`;
}

/* ---------- 派生：过滤 + 排序 ---------- */
function visibleEntries() {
  const q = ui.search.trim().toLowerCase();
  let list = state.entries.filter((e) => {
    if (ui.statusFilter !== 'all' && e.status !== ui.statusFilter) return false;
    if (q && !(e.remark || '').toLowerCase().includes(q) && !e.key.toLowerCase().includes(q)) return false;
    return true;
  });
  const primaryBalance = (e) => (e.balances && e.balances[0] ? e.balances[0].total : null);
  const cmp = {
    added_desc: (a, b) => b.addedAt - a.addedAt,
    checked_desc: (a, b) => (b.lastCheckedAt || 0) - (a.lastCheckedAt || 0),
    balance_desc: (a, b) => {
      const ba = primaryBalance(a), bb = primaryBalance(b);
      if (ba == null && bb == null) return 0;
      if (ba == null) return 1;
      if (bb == null) return -1;
      return bb - ba;
    },
    remark_asc: (a, b) => (a.remark || '').localeCompare(b.remark || '', 'zh-CN'),
  }[ui.sort] || ((a, b) => 0);
  return list.sort(cmp);
}

function counts() {
  const c = { total: state.entries.length, ok: 0, unavailable: 0, invalid: 0, error: 0, idle: 0 };
  const sums = new Map(); // currency -> total
  for (const e of state.entries) {
    if (e.status in c) c[e.status]++;
    if ((e.status === 'ok' || e.status === 'unavailable') && e.balances && e.balances[0]) {
      const cur = e.balances[0].currency || '—';
      sums.set(cur, (sums.get(cur) || 0) + (e.balances[0].total || 0));
    }
  }
  return { c, sums };
}

/* ---------- 渲染 ---------- */
function renderSummary() {
  const { c, sums } = counts();
  const chips = [];
  chips.push(`<span class="chip">密钥 <span class="mono">${c.total}</span></span>`);
  if (c.ok) chips.push(`<span class="chip"><i class="dot ok"></i>可用 <span class="mono">${c.ok}</span></span>`);
  if (c.unavailable) chips.push(`<span class="chip"><i class="dot unavailable"></i>欠费 <span class="mono">${c.unavailable}</span></span>`);
  if (c.invalid) chips.push(`<span class="chip"><i class="dot invalid"></i>无效 <span class="mono">${c.invalid}</span></span>`);
  if (c.error) chips.push(`<span class="chip"><i class="dot error"></i>失败 <span class="mono">${c.error}</span></span>`);
  if (c.idle) chips.push(`<span class="chip"><i class="dot idle"></i>未查询 <span class="mono">${c.idle}</span></span>`);
  for (const [cur, sum] of sums) {
    chips.push(`<span class="chip"><i class="dot sum"></i>${escapeHtml(cur)} 合计 <span class="mono">${fmtMoney(sum, cur)}</span></span>`);
  }
  els.summary.innerHTML = chips.join('');
}

function balanceCellHtml(entry) {
  const b = entry.balances && entry.balances[0];
  if (!b || entry.status === 'checking') return '<span class="num-dim">—</span>';
  return `
    <span class="balance-main">${fmtMoney(b.total, b.currency)}</span>
    <div class="balance-bar" title="充值 ${fmtMoney(Math.max(b.tossed || 0, 0), b.currency)} / 赠送 ${fmtMoney(Math.max(b.granted || 0, 0), b.currency)}" aria-hidden="true">
      <i class="seg-paid"></i><i class="seg-grant"></i>
    </div>`;
}

function rowHtml(entry) {
  const st = STATUS[entry.status] || STATUS.idle;
  const revealed = ui.revealed.has(entry.id);
  const b = entry.balances && entry.balances[0];
  const multi = entry.balances && entry.balances.length > 1 ? ` +${entry.balances.length - 1}` : '';
  const title = entry.lastError ? escapeHtml(entry.lastError) : (st.tip || st.label);
  const checkedTitle = entry.lastCheckedAt
    ? `${fmtAbs(entry.lastCheckedAt)}${entry.lastError ? ' · ' + escapeHtml(entry.lastError) : ''}`
    : '尚未查询';

  return `
  <tr data-id="${entry.id}" class="${entry.status === 'checking' ? 'checking' : ''}">
    <td class="cell-sel" data-label="选择"><input type="checkbox" class="sel-box" data-act="sel" ${ui.selected.has(entry.id) ? 'checked' : ''} aria-label="选择该密钥"></td>
    <td data-label="备注">
      <span class="remark-cell">
        <span class="remark-name ${entry.remark ? '' : 'empty'}" data-act="rename" title="点击设置备注">${entry.remark ? escapeHtml(entry.remark) : '未命名'}</span>
      </span>
    </td>
    <td data-label="密钥">
      <button type="button" class="key-chip ${revealed ? 'revealed' : ''}" data-act="copy" title="点击复制完整密钥">${escapeHtml(keyDisplay(entry, revealed))}</button>
    </td>
    <td data-label="状态">
      <span class="st-badge ${st.cls}" title="${title}"><i class="dot"></i>${st.label}</span>
      ${(entry.status === 'error' || entry.status === 'invalid') && entry.lastError ? `<div class="err-detail" title="${title}">${escapeHtml(entry.lastError)}</div>` : ''}
    </td>
    <td class="num col-total" data-label="总余额">${balanceCellHtml(entry)}</td>
    <td class="num" data-label="充值余额">${b ? `<span class="balance-main">${fmtMoney(b.tossed, b.currency)}</span>` : '<span class="num-dim">—</span>'}</td>
    <td class="num" data-label="赠送余额">${b ? `<span class="balance-main">${fmtMoney(b.granted, b.currency)}</span>` : '<span class="num-dim">—</span>'}</td>
    <td data-label="币种">${b ? `<span class="currency-tag">${escapeHtml(b.currency)}</span>${multi ? `<span class="num-dim" title="该密钥包含多个币种，点「原始数据」查看全部">${multi}</span>` : ''}` : '<span class="num-dim">—</span>'}</td>
    <td data-label="最近查询"><span class="time-cell" title="${checkedTitle}">${fmtRel(entry.lastCheckedAt)}</span></td>
    <td class="col-ops">
      <div class="row-ops">
        <button type="button" class="icon-btn" data-act="refresh" title="重新查询" ${ui.querying ? 'disabled' : ''}><svg class="ic"><use href="#i-refresh"/></svg></button>
        <button type="button" class="icon-btn" data-act="copy" title="复制密钥"><svg class="ic"><use href="#i-copy"/></svg></button>
        <button type="button" class="icon-btn" data-act="reveal" title="${revealed ? '隐藏密钥' : '显示密钥'}"><svg class="ic"><use href="#i-${revealed ? 'eye-off' : 'eye'}"/></svg></button>
        <button type="button" class="icon-btn" data-act="rename" title="备注"><svg class="ic"><use href="#i-pencil"/></svg></button>
        <button type="button" class="icon-btn" data-act="raw" title="查看原始返回数据"><svg class="ic"><use href="#i-braces"/></svg></button>
        <button type="button" class="icon-btn danger" data-act="delete" title="删除"><svg class="ic"><use href="#i-trash"/></svg></button>
      </div>
    </td>
  </tr>`;
}

function renderRow(entry) {
  const tr = els.ledgerBody.querySelector(`tr[data-id="${entry.id}"]`);
  if (!tr) { render(); return; }
  tr.outerHTML = rowHtml(entry);
}

function render() {
  renderSummary();
  const list = visibleEntries();
  els.ledgerBody.innerHTML = list.map(rowHtml).join('');

  const empty = state.entries.length === 0;
  els.emptyState.hidden = !empty && list.length > 0;
  if (!empty && list.length === 0) {
    els.emptyText.textContent = '没有匹配的密钥——试试调整搜索词或状态筛选。';
  } else {
    els.emptyText.textContent = '台账还是空的——把 sk- 开头的密钥粘贴到上方输入框，开始第一次查询。';
  }

  // 全选框状态
  const selectable = list.filter((e) => e.status !== 'checking');
  const selCount = list.filter((e) => ui.selected.has(e.id)).length;
  els.selAll.checked = selectable.length > 0 && selCount === selectable.length;
  els.selAll.indeterminate = selCount > 0 && selCount < selectable.length;

  els.batchBar.hidden = ui.selected.size === 0;
  els.selCount.textContent = String(ui.selected.size);

  // 全局隐藏按钮图标
  els.btnMask.querySelector('use').setAttribute('href', state.settings.mask ? '#i-eye-off' : '#i-eye');
  els.btnMask.setAttribute('aria-pressed', String(!state.settings.mask));

  // 余额构成条宽度（CSSOM 设置，避免内联样式被 CSP 拦截）
  for (const tr of els.ledgerBody.querySelectorAll('tr')) {
    const entry = state.entries.find((e) => e.id === tr.dataset.id);
    if (!entry) continue;
    const paid = tr.querySelector('.seg-paid');
    const grant = tr.querySelector('.seg-grant');
    if (paid && grant) {
      const b = entry.balances && entry.balances[0];
      const g = Math.max((b && b.granted) || 0, 0), t = Math.max((b && b.tossed) || 0, 0);
      const denom = g + t;
      const paidPct = denom > 0 ? (t / denom) * 100 : ((b && b.total) > 0 ? 100 : 0);
      paid.style.width = `${paidPct.toFixed(1)}%`;
      grant.style.width = denom > 0 ? `${(100 - paidPct).toFixed(1)}%` : '0%';
    }
  }
}

/* ---------- 增删改 ---------- */
function addKeys(keys) {
  const known = new Set(state.entries.map((e) => e.key));
  const fresh = [], updated = [];
  for (const key of keys) {
    const exist = state.entries.find((e) => e.key === key);
    if (exist) { updated.push(key); continue; }
    known.add(key);
    state.entries.push({
      id: genId(), key,
      remark: '',
      addedAt: Date.now(), lastCheckedAt: null,
      status: 'idle', isAvailable: null, balances: [], lastError: '',
    });
    fresh.push(key);
  }
  save();
  return { fresh, updated };
}

async function deleteEntries(ids) {
  const n = ids.length;
  const ok = await confirmModal('删除密钥', `将删除 <strong>${n}</strong> 个密钥及其全部查询记录，此操作无法恢复。<br>删除前建议先导出备份。`, '删除');
  if (!ok) return;
  const idSet = new Set(ids);
  state.entries = state.entries.filter((e) => !idSet.has(e.id));
  for (const id of ids) ui.selected.delete(id);
  save(); render();
  toast(`已删除 ${n} 个密钥`);
}

/* ---------- 复制 ---------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'svg-defs';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
    return ok;
  }
}

/* ---------- 导入 / 导出 ---------- */
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const stampName = () => {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
};

function exportJson() {
  const payload = {
    app: 'deepseek-balance-checker',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: state.entries.length,
    entries: state.entries,
  };
  download(`deepseek_台账_${stampName()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast(`已导出 ${state.entries.length} 条（JSON，含完整密钥）`);
}

function exportCsv() {
  const head = ['备注', '密钥', '状态', '币种', '总余额', '充值余额', '赠送余额', '是否可用', '最近查询', '错误信息'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(',')];
  for (const e of state.entries) {
    const b = e.balances && e.balances[0];
    lines.push([
      e.remark || '', e.key, STATUS[e.status]?.label ?? e.status,
      b ? b.currency : '', b ? b.total ?? '' : '', b ? b.tossed ?? '' : '', b ? b.granted ?? '' : '',
      e.isAvailable == null ? '' : (e.isAvailable ? '是' : '否'),
      e.lastCheckedAt ? new Date(e.lastCheckedAt).toLocaleString('zh-CN') : '',
      e.lastError || '',
    ].map(q).join(','));
  }
  download(`deepseek_台账_${stampName()}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  toast(`已导出 ${state.entries.length} 条（CSV，含完整密钥）`);
}

async function importFile(file) {
  const text = await file.text();
  let imported = 0, updated = 0;
  try {
    const data = JSON.parse(text);
    const entries = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : null);
    if (!entries) throw new Error('bad');
    for (const e of entries) {
      if (!e || typeof e.key !== 'string' || !e.key) continue;
      const exist = state.entries.find((x) => x.key === e.key);
      if (exist) {
        if (!exist.remark && e.remark) exist.remark = String(e.remark);
        updated++;
        continue;
      }
      const balances = Array.isArray(e.balances)
        ? e.balances
            .filter((b) => b && typeof b.currency === 'string' && Number.isFinite(Number(b.total)))
            .map((b) => ({ currency: b.currency, total: Number(b.total), granted: Number(b.granted) || 0, tossed: Number(b.tossed) || 0 }))
        : [];
      state.entries.push({
        id: genId(), key: e.key,
        remark: String(e.remark || ''),
        addedAt: Number(e.addedAt) || Date.now(),
        lastCheckedAt: Number(e.lastCheckedAt) || null,
        status: balances.length ? (e.status === 'unavailable' ? 'unavailable' : 'ok')
              : (e.status === 'invalid' || e.status === 'error' ? e.status : 'idle'),
        isAvailable: typeof e.isAvailable === 'boolean' ? e.isAvailable : null,
        balances,
        lastError: String(e.lastError || ''),
      });
      imported++;
    }
  } catch {
    // 不是 JSON —— 按纯文本密钥列表处理
    const keys = parseKeys(text);
    if (!keys.length) { toast('导入失败：文件既不是备份 JSON，也没有可识别的密钥', 'bad'); return; }
    const r = addKeys(keys);
    imported = r.fresh.length; updated = r.updated.length;
  }
  save(); render();
  toast(`导入完成：新增 ${imported} · 已存在 ${updated}`, 'ok');
}

/* ---------- 弹窗 ---------- */
let modalResolve = null;
let modalOnOk = null;
function openModal({ title, body, okText = '确定', okClass = 'primary', cancelText = '取消', showCancel = true, onOk = null }) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = body;
  els.modalOk.textContent = okText;
  els.modalOk.className = `btn ${okClass}`;
  els.modalCancel.hidden = !showCancel;
  els.modalCancel.textContent = cancelText;
  modalOnOk = onOk;
  els.backdrop.hidden = false;
  const focusTarget = els.modalBody.querySelector('input, textarea') || els.modalOk;
  requestAnimationFrame(() => focusTarget.focus());
  return new Promise((resolve) => { modalResolve = resolve; });
}
function closeModal(result) {
  els.backdrop.hidden = true;
  els.modalBody.innerHTML = '';
  modalOnOk = null;
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
const confirmModal = (title, bodyHtml, okText) =>
  openModal({ title, body: `<p class="modal-text">${bodyHtml}</p>`, okText, okClass: 'danger' });

/* ---------- Toast ---------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

/* ---------- 主题 ---------- */
const media = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = state.settings.theme;
  const dark = t === 'dark' || (t === 'auto' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  els.themeBtn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  els.themeBtn.title = `当前：${
    { auto: '跟随系统', light: '浅色', dark: '深色' }[t]
  }，点击切换`;
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  applyTheme(); save();
}
media.addEventListener('change', () => { if (state.settings.theme === 'auto') applyTheme(); });

/* ---------- 原始数据弹窗 ---------- */
function showRaw(entry) {
  const data = {
    key: entry.key,
    remark: entry.remark || undefined,
    status: entry.status,
    is_available: entry.isAvailable,
    balance_infos: (entry.balances || []).map((b) => ({
      currency: b.currency,
      total_balance: b.total,
      granted_balance: b.granted,
      tossed_balance: b.tossed,
    })),
    last_error: entry.lastError || undefined,
    last_checked_at: entry.lastCheckedAt ? new Date(entry.lastCheckedAt).toISOString() : undefined,
  };
  openModal({
    title: '查询结果（台账字段）',
    body: `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`,
    okText: '关闭', showCancel: false,
  });
}

/* ---------- 事件 ---------- */
function bindEvents() {
  // 输入解析提示
  let hintTimer = null;
  els.keyInput.addEventListener('input', () => {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      const keys = parseKeys(els.keyInput.value);
      if (!els.keyInput.value.trim()) {
        els.parseHint.textContent = '';
        els.parseHint.className = 'parse-hint';
      } else if (keys.length) {
        els.parseHint.textContent = `识别到 ${keys.length} 个密钥`;
        els.parseHint.className = 'parse-hint ok';
      } else {
        els.parseHint.textContent = '未识别到密钥（通常以 sk- 开头）';
        els.parseHint.className = 'parse-hint warn';
      }
    }, 150);
  });

  const queryFromInput = () => {
    const keys = parseKeys(els.keyInput.value);
    if (!keys.length) { toast('没有可查询的密钥，请检查输入', 'bad'); return; }
    const { fresh, updated } = addKeys(keys);
    els.keyInput.value = '';
    els.parseHint.textContent = '';
    els.parseHint.className = 'parse-hint';
    render();
    const targets = state.entries.filter((e) => fresh.includes(e.key) || updated.includes(e.key));
    const extra = keys.length - fresh.length - updated.length;
    if (extra > 0) toast(`输入中忽略 ${extra} 个无法识别的内容`);
    if (ui.querying) { toast('已有批量查询在进行，新密钥稍后可用「刷新全部」查询'); return; }
    queryEntries(targets);
  };
  els.btnQueryNew.addEventListener('click', queryFromInput);
  els.keyInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); queryFromInput(); }
  });

  els.btnStop.addEventListener('click', () => {
    ui.stopFlag = true;
    if (ui.abortCtrl) ui.abortCtrl.abort();
    toast('正在停止…');
  });

  els.concurrency.addEventListener('change', () => {
    state.settings.concurrency = Number(els.concurrency.value);
    save();
  });

  // 工具栏
  els.searchInput.addEventListener('input', () => { ui.search = els.searchInput.value; render(); });
  els.statusFilter.addEventListener('change', () => { ui.statusFilter = els.statusFilter.value; render(); });
  els.sortSelect.addEventListener('change', () => { ui.sort = els.sortSelect.value; render(); });
  els.btnRefreshAll.addEventListener('click', () => queryEntries([...state.entries]));
  els.btnExportJson.addEventListener('click', exportJson);
  els.btnExportCsv.addEventListener('click', exportCsv);
  els.btnImport.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = '';
    if (f) await importFile(f);
  });
  els.btnMask.addEventListener('click', () => {
    state.settings.mask = !state.settings.mask;
    ui.revealed.clear();
    save(); render();
  });
  els.btnClear.addEventListener('click', async () => {
    if (!state.entries.length) { toast('台账已经是空的'); return; }
    const ok = await confirmModal('清空台账', `将删除全部 <strong>${state.entries.length}</strong> 个密钥及查询记录，且无法恢复。<br>建议先导出 JSON 备份。`, '全部删除');
    if (!ok) return;
    state.entries = [];
    ui.selected.clear(); ui.revealed.clear();
    save(); render();
    toast('台账已清空');
  });

  // 全选
  els.selAll.addEventListener('change', () => {
    const list = visibleEntries();
    if (els.selAll.checked) for (const e of list) ui.selected.add(e.id);
    else for (const e of list) ui.selected.delete(e.id);
    render();
  });

  // 批量条
  els.btnDeleteSelected.addEventListener('click', () => deleteEntries([...ui.selected]));
  els.btnClearSelection.addEventListener('click', () => { ui.selected.clear(); render(); });

  // 表格事件委托
  els.ledgerBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const entry = state.entries.find((x) => x.id === tr.dataset.id);
    if (!entry) return;
    const act = btn ? btn.dataset.act : null;

    if (act === 'sel') return; // checkbox 走 change
    if (act === 'copy' || (e.target.closest('.key-chip') && !btn)) {
      const ok = await copyText(entry.key);
      toast(ok ? '密钥已复制到剪贴板' : '复制失败，请手动复制', ok ? 'ok' : 'bad');
      return;
    }
    if (!act) return;
    switch (act) {
      case 'refresh':
        if (!ui.querying) queryEntries([entry]);
        break;
      case 'reveal': {
        if (ui.revealed.has(entry.id)) ui.revealed.delete(entry.id);
        else ui.revealed.add(entry.id);
        render();
        break;
      }
      case 'rename': {
        const remark = await openModal({
          title: '设置备注',
          body: `<p class="modal-text">给 <code class="mono">${escapeHtml(keyDisplay(entry, false))}</code> 设置一个方便识别的备注：</p>
                 <input type="text" id="remarkInput" maxlength="60" value="${escapeHtml(entry.remark || '')}" placeholder="例如：公司主号 / 个人测试">`,
          okText: '保存',
          onOk: () => {
            const input = els.modalBody.querySelector('#remarkInput');
            return input ? input.value.trim() : undefined;
          },
        });
        if (remark !== null && remark !== undefined) {
          entry.remark = remark;
          save(); render();
          toast('备注已保存');
        }
        break;
      }
      case 'raw': showRaw(entry); break;
      case 'delete': deleteEntries([entry.id]); break;
    }
  });

  els.ledgerBody.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-act="sel"]');
    if (!box) return;
    const tr = box.closest('tr[data-id]');
    if (!tr) return;
    if (box.checked) ui.selected.add(tr.dataset.id);
    else ui.selected.delete(tr.dataset.id);
    render();
  });

  // 弹窗
  els.modalOk.addEventListener('click', () => {
    const value = modalOnOk ? modalOnOk() : true;   // onOk 需在关闭、清空 DOM 之前读取输入
    closeModal(value);
  });
  els.modalCancel.addEventListener('click', () => closeModal(null));
  els.modalX.addEventListener('click', () => closeModal(null));
  els.backdrop.addEventListener('click', (e) => { if (e.target === els.backdrop) closeModal(null); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.backdrop.hidden) closeModal(null);
  });

  els.themeBtn.addEventListener('click', cycleTheme);
}

/* ---------- 初始化 ---------- */
function init() {
  load();
  els.concurrency.value = String(state.settings.concurrency || 3);
  if (els.concurrency.value !== String(state.settings.concurrency)) {
    state.settings.concurrency = Number(els.concurrency.value) || 3;
  }
  applyTheme();
  bindEvents();
  render();
}
init();
