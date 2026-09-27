import { historyAll, historyClear, cacheClear } from './db.js';

const worker = new Worker('./js/worker.js', { type: 'module' });
const records = new Map(); // id -> record（含进行中的）
let idSeq = 0;

const $ = (sel) => document.querySelector(sel);
const listEl = $('#request-list');
const canvas = $('#timeline');
const ctx = canvas.getContext('2d');

const STATUS_LABEL = {
  running: '请求中', retrying: '等待重试', ok: '成功', cache: '缓存降级',
  placeholder: '占位降级', failed: '失败', cancelled: '已取消',
};
const KIND_LABEL = {
  ok: '成功', http: 'HTTP 错误', timeout: '超时', network: '网络错误', cancelled: '已取消',
};

// ---------- 发起请求 ----------
$('#send-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const task = {
    id: `req-${Date.now()}-${idSeq++}`,
    url: $('#url').value.trim(),
    method: $('#method').value,
    body: $('#body').value || undefined,
    headers: { 'Content-Type': 'application/json' },
    retries: clampInt($('#retries').value, 0, 10),
    timeout: clampInt($('#timeout').value, 100, 60000),
    cacheTtl: clampInt($('#cache-ttl').value, 0, 86400000),
    backoff: {
      strategy: $('#strategy').value,
      baseDelay: clampInt($('#base-delay').value, 10, 60000),
      maxDelay: clampInt($('#max-delay').value, 100, 120000),
      jitter: $('#jitter').checked,
    },
  };
  worker.postMessage({ type: 'start', task });
});

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

// ---------- 取消 / 清空 ----------
$('#cancel-all').addEventListener('click', () => worker.postMessage({ type: 'cancelAll' }));
$('#clear-history').addEventListener('click', async () => {
  worker.postMessage({ type: 'cancelAll' });
  records.clear();
  await historyClear();
  await cacheClear();
  render();
});

// ---------- Worker 消息 ----------
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'update') {
    records.set(msg.record.id, msg.record);
    render();
  }
};

// ---------- 历史加载 ----------
(async () => {
  try {
    const all = await historyAll();
    for (const r of all) records.set(r.id, r);
    render();
  } catch (_) {}
})();

// ---------- 页面卸载：取消所有请求 ----------
window.addEventListener('pagehide', () => {
  worker.postMessage({ type: 'cancelAll' });
  worker.terminate();
});
window.addEventListener('beforeunload', () => {
  worker.postMessage({ type: 'cancelAll' });
});

// ---------- 渲染 ----------
function render() {
  renderList();
  renderTimeline();
}

function renderList() {
  const items = [...records.values()].sort((a, b) => b.startTime - a.startTime);
  if (!items.length) {
    listEl.innerHTML = '<p class="empty">暂无请求记录</p>';
    return;
  }
  listEl.innerHTML = '';
  for (const r of items) {
    const card = document.createElement('div');
    card.className = 'card';
    const active = r.status === 'running' || r.status === 'retrying';
    const attemptsHtml = r.attempts.map((a) => {
      const cls = a.ok ? 'ok' : a.kind;
      return `<span class="attempt ${cls}" title="${escapeHtml(a.error || '')}">#${a.attempt} ${KIND_LABEL[a.kind]}${a.status ? ' ' + a.status : ''} ${a.durationMs}ms</span>`;
    }).join('');
    card.innerHTML = `
      <div class="card-head">
        <span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span>
        <span class="url">${escapeHtml(r.method)} ${escapeHtml(r.url)}</span>
        ${active ? `<button class="cancel-btn" data-id="${r.id}">取消</button>` : ''}
      </div>
      <div class="meta">
        重试 ${r.retries}/${r.maxRetries} 次
        ${r.durationMs != null ? ` · 总耗时 ${r.durationMs}ms` : ' · 进行中…'}
        ${r.error ? ` · <span class="err">${escapeHtml(r.error)}</span>` : ''}
        ${r.cacheInfo ? ` · 缓存${r.cacheInfo.expired ? '已过期' : '命中'}（${new Date(r.cacheInfo.storedAt).toLocaleTimeString()}）` : ''}
      </div>
      <div class="attempts">${attemptsHtml}</div>
      ${r.body ? `<details><summary>响应体</summary><pre>${escapeHtml(r.body)}</pre></details>` : ''}
    `;
    listEl.appendChild(card);
  }
  listEl.querySelectorAll('.cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => worker.postMessage({ type: 'cancel', id: btn.dataset.id }));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Canvas 请求时序 ----------
const COLORS = {
  ok: '#2da44e', http: '#cf222e', timeout: '#d4a72c',
  network: '#8250df', cancelled: '#6e7781', wait: '#bf8700',
};

function renderTimeline() {
  const items = [...records.values()].sort((a, b) => a.startTime - b.startTime);
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const rowH = 30;
  const axisH = 24;
  const height = Math.max(60, items.length * rowH + axisH + 8);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!items.length) return;

  const t0 = Math.min(...items.map((r) => r.startTime));
  const now = Date.now();
  const t1 = Math.max(...items.map((r) => r.endTime || now), t0 + 100);
  const labelW = 130;
  const padR = 12;
  const x = (t) => labelW + ((t - t0) / (t1 - t0)) * (width - labelW - padR);

  // 时间轴刻度
  ctx.fillStyle = '#57606a';
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'top';
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    const tx = x(t);
    ctx.fillText(`+${Math.round(t - t0)}ms`, Math.min(tx, width - 60), height - axisH + 6);
    ctx.strokeStyle = '#d0d7de';
    ctx.beginPath();
    ctx.moveTo(tx, 0);
    ctx.lineTo(tx, height - axisH);
    ctx.stroke();
  }

  items.forEach((r, i) => {
    const y = i * rowH + 6;
    const barY = y + 6;
    const barH = 12;
    ctx.fillStyle = '#24292f';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    const label = `${r.id.slice(-4)} ${STATUS_LABEL[r.status]}`;
    ctx.fillText(label, 4, barY + barH / 2, labelW - 8);

    // 退避等待段（斜纹底色）
    for (const w of r.waits || []) {
      ctx.fillStyle = COLORS.wait;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(x(w.wallStart), barY, Math.max(1, x(w.wallEnd) - x(w.wallStart)), barH);
      ctx.globalAlpha = 1;
    }
    // 尝试段
    for (const a of r.attempts) {
      const end = a.wallEnd || now;
      ctx.fillStyle = COLORS[a.kind] || COLORS.ok;
      const sx = x(a.wallStart);
      ctx.fillRect(sx, barY, Math.max(2, x(end) - sx), barH);
    }
    // 进行中动画条
    if (!r.endTime) {
      const last = r.attempts.length ? r.attempts[r.attempts.length - 1].wallEnd : r.startTime;
      ctx.fillStyle = '#0969da';
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x(last), barY, Math.max(2, x(now) - x(last)), barH);
      ctx.globalAlpha = 1;
    }
  });
}

// 进行中的记录让时间轴持续前进
setInterval(() => {
  for (const r of records.values()) {
    if (!r.endTime) { renderTimeline(); return; }
  }
}, 250);
