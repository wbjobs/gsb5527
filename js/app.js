import { classifyError, isRetryableFailure } from './backoff.js';
import {
  cacheKey,
  clearCacheStore,
  clearHistoryStore,
  getAllHistory,
  getCache,
  putCache,
  putHistory
} from './db.js';
import { TimelineCanvas } from './timeline.js';

const PRESETS = {
  success: 'https://httpbingo.org/get?scenario=success',
  http503: 'https://httpbingo.org/status/503',
  http404: 'https://httpbingo.org/status/404',
  timeout: 'https://httpbingo.org/delay/8',
  offline: 'https://this-domain-should-not-exist-gsb5527.invalid/network-failure'
};

const STATUS_TEXT = {
  running: '进行中',
  success: '成功',
  error: '失败',
  cache: '缓存降级',
  placeholder: '占位数据',
  cancelled: '已取消',
  unloaded: '页面卸载'
};

const form = document.querySelector('#requestForm');
const presetSelect = document.querySelector('#preset');
const urlInput = document.querySelector('#url');
const methodInput = document.querySelector('#method');
const timeoutInput = document.querySelector('#timeoutMs');
const retriesInput = document.querySelector('#retries');
const baseDelayInput = document.querySelector('#baseDelayMs');
const maxDelayInput = document.querySelector('#maxDelayMs');
const jitterInput = document.querySelector('#jitter');
const cacheTtlInput = document.querySelector('#cacheTtlMs');
const useCacheInput = document.querySelector('#useCache');
const historyList = document.querySelector('#historyList');
const timelineSummary = document.querySelector('#timelineSummary');
const itemTemplate = document.querySelector('#historyItemTemplate');
const cancelAllButton = document.querySelector('#cancelAll');
const clearHistoryButton = document.querySelector('#clearHistory');
const clearCacheButton = document.querySelector('#clearCache');

const timeline = new TimelineCanvas(document.querySelector('#timelineCanvas'), document.querySelector('#tooltip'));
let requests = [];
let worker = createWorker();
let persistQueued = false;
let historySignature = '';
let lastElapsedUpdate = 0;

function createWorker() {
  const retryWorker = new Worker('./js/retry-worker.js', { type: 'module' });
  retryWorker.onmessage = handleWorkerMessage;
  return retryWorker;
}

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function numberValue(input, fallback, min, max) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readOptions() {
  return {
    url: urlInput.value.trim(),
    method: methodInput.value,
    timeoutMs: numberValue(timeoutInput, 6000, 100, 30000),
    retries: numberValue(retriesInput, 0, 0, 8),
    baseDelayMs: numberValue(baseDelayInput, 0, 0, 10000),
    maxDelayMs: numberValue(maxDelayInput, 0, 0, 30000),
    jitter: numberValue(jitterInput, 0, 0, 1),
    cacheTtlMs: numberValue(cacheTtlInput, 0, 0, 600000),
    useCache: useCacheInput.checked
  };
}

function addEvent(request, type, detail = {}) {
  request.events.push({ at: Date.now(), type, ...detail });
}

function schedulePersist() {
  if (persistQueued) return;
  persistQueued = true;
  setTimeout(async () => {
    persistQueued = false;
    const terminal = requests.filter((request) => request.endedAt);
    await Promise.all(terminal.slice(0, 50).map((request) => putHistory(request).catch(() => {})));
  }, 300);
}

function patchRequest(id, patch) {
  const request = requests.find((item) => item.id === id);
  if (!request) return null;
  Object.assign(request, patch);
  return request;
}

function updateWaitingEvent(id, attempt, patch) {
  const request = requests.find((item) => item.id === id);
  if (!request) return;
  for (let index = request.events.length - 1; index >= 0; index -= 1) {
    const event = request.events[index];
    if (event.attempt === attempt && (event.type === 'retryScheduled' || event.type === 'retryWaiting')) {
      Object.assign(event, patch);
      return;
    }
  }
}

function handleWorkerMessage(event) {
  const data = event.data || {};
  const request = requests.find((item) => item.id === data.id);
  if (!request || request.endedAt) return;

  if (data.type === 'retryScheduled') {
    addEvent(request, 'retryScheduled', {
      attempt: data.attempt,
      delay: data.delay,
      runAt: data.runAt,
      remaining: data.delay
    });
    request.status = 'waiting';
  }

  if (data.type === 'retryTick') {
    updateWaitingEvent(data.id, data.attempt, { remaining: data.remaining, runAt: data.runAt });
  }

  if (data.type === 'retryDue') {
    addEvent(request, 'retryDue', { attempt: data.attempt, at: data.runAt || Date.now() });
    void executeRequest(request, data.attempt + 1);
  }

  if (data.type === 'retryCancelled') {
    addEvent(request, 'retryWaitCancelled', { attempt: data.attempt });
  }
}

async function readResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();
  if (contentType.includes('application/json')) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

async function runAttempt(request, attempt) {
  const controller = new AbortController();
  request.activeController = controller;
  const startedAt = Date.now();
  const attemptRecord = {
    attempt,
    startedAt,
    endedAt: null,
    ok: null,
    status: null,
    kind: 'running',
    error: null
  };
  request.attempts.push(attemptRecord);
  request.status = 'running';
  request.attemptCount = attempt;
  addEvent(request, 'attemptStart', { attempt });

  const timeoutId = setTimeout(() => {
    controller.abort(Object.assign(new Error('请求超时'), { name: 'TimeoutError', reason: 'timeout' }));
  }, request.options.timeoutMs);

  try {
    const response = await fetch(request.url, {
      method: request.method,
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' }
    });
    clearTimeout(timeoutId);
    const endedAt = Date.now();
    const body = await readResponseBody(response);
    Object.assign(attemptRecord, {
      endedAt,
      ok: response.ok,
      status: response.status,
      kind: response.ok ? 'success' : 'http-error'
    });
    addEvent(request, response.ok ? 'attemptSuccess' : 'attemptHttpError', {
      attempt,
      status: response.status,
      duration: endedAt - startedAt
    });

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        body,
        contentType: response.headers.get('content-type') || '',
        headers: response.headers,
        duration: endedAt - startedAt
      };
    }
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    return {
      ok: false,
      status: response.status,
      body,
      kind: 'http-error',
      error,
      headers: response.headers,
      duration: endedAt - startedAt
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const endedAt = Date.now();
    const kind = classifyError(error);
    Object.assign(attemptRecord, { endedAt, ok: false, kind, error: String(error.message || error) });
    addEvent(request, kind === 'cancelled' || kind === 'unload' ? 'attemptCancelled' : 'attemptFailed', {
      attempt,
      kind,
      duration: endedAt - startedAt
    });
    return { ok: false, kind, error, duration: endedAt - startedAt };
  } finally {
    if (request.activeController === controller) request.activeController = null;
  }
}

function retryAfterDelay(result) {
  const header = result?.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function scheduleRetry(request, attempt, result) {
  request.status = 'waiting';
  const override = retryAfterDelay(result);
  const payload = {
    type: 'scheduleRetry',
    id: request.id,
    attempt,
    baseDelayMs: override === null ? request.options.baseDelayMs : override,
    maxDelayMs: override === null ? request.options.maxDelayMs : override,
    jitter: override === null ? request.options.jitter : 0
  };
  worker.postMessage(payload);
}

async function finishWithFallback(request, result, attempt) {
  const key = cacheKey(request.method, request.url);
  let cached = null;
  if (request.options.useCache && request.method === 'GET') {
    try {
      cached = await getCache(key);
    } catch {
      cached = null;
    }
  }

  if (cached) {
    const expired = cached.expiresAt <= Date.now();
    request.status = 'cache';
    request.fallbackUsed = 'stale-cache';
    request.response = {
      source: expired ? 'stale-cache' : 'fresh-cache',
      status: cached.status,
      body: cached.body,
      cachedAt: cached.cachedAt,
      expiresAt: cached.expiresAt
    };
    addEvent(request, 'fallbackCache', { attempt, expired });
  } else {
    request.status = 'placeholder';
    request.fallbackUsed = 'placeholder';
    request.response = {
      source: 'placeholder',
      status: result.status || 0,
      body: JSON.stringify({
        placeholder: true,
        message: '所有请求尝试均失败，且没有可用缓存；当前返回占位数据。',
        failure: result.kind || classifyError(result.error, result.status),
        httpStatus: result.status || null,
        attemptedAt: new Date().toISOString()
      }, null, 2)
    };
    addEvent(request, 'fallbackPlaceholder', { attempt });
  }

  request.error = result.error ? String(result.error.message || result.error) : `HTTP ${result.status}`;
  finalizeRequest(request);
}

async function finishFailure(request, result, attempt) {
  const kind = result.kind || classifyError(result.error, result.status);
  if (kind === 'cancelled') {
    request.status = 'cancelled';
    request.error = '请求已取消';
    addEvent(request, 'requestCancelled', { attempt });
    finalizeRequest(request);
    return;
  }
  if (kind === 'unload') {
    request.status = 'unloaded';
    request.error = '页面卸载导致请求取消';
    addEvent(request, 'requestUnloaded', { attempt });
    finalizeRequest(request);
    return;
  }

  request.status = 'error';
  request.error = result.error ? String(result.error.message || result.error) : `HTTP ${result.status}`;
  addEvent(request, 'retriesExhausted', { attempt });
  await finishWithFallback(request, result, attempt);
}

function finalizeRequest(request) {
  if (request.endedAt) return;
  request.endedAt = Date.now();
  request.durationMs = request.endedAt - request.startedAt;
  addEvent(request, 'requestEnd', { status: request.status });
  schedulePersist();
}

async function executeRequest(request, attempt = 1) {
  if (request.endedAt) return;
  const result = await runAttempt(request, attempt);
  if (request.endedAt) return;

  if (result.ok) {
    request.status = 'success';
    request.response = {
      source: 'network',
      status: result.status,
      body: result.body,
      contentType: result.contentType
    };
    if (request.method === 'GET') {
      const now = Date.now();
      await putCache({
        key: cacheKey(request.method, request.url),
        method: request.method,
        url: request.url,
        status: result.status,
        body: result.body,
        cachedAt: now,
        expiresAt: now + request.options.cacheTtlMs
      }).catch(() => {});
    }
    finalizeRequest(request);
    return;
  }

  const kind = result.kind || classifyError(result.error, result.status);
  const canRetry = isRetryableFailure({ kind, status: result.status }) && attempt <= request.options.retries;
  if (canRetry) {
    addEvent(request, 'retryDecision', {
      attempt,
      reason: kind,
      status: result.status || null,
      nextAttempt: attempt + 1
    });
    scheduleRetry(request, attempt, result);
  } else {
    await finishFailure(request, { ...result, kind }, attempt);
  }
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false }) +
    `.${String(new Date(timestamp).getMilliseconds()).padStart(3, '0')}`;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function statusClass(status) {
  if (status === 'success') return 'status-success';
  if (status === 'cache') return 'status-cache';
  if (status === 'placeholder') return 'status-placeholder';
  if (status === 'cancelled' || status === 'unloaded') return 'status-cancelled';
  if (status === 'running' || status === 'waiting') return 'status-running';
  return 'status-error';
}

function buildDetails(request) {
  const events = request.events.map((event) => {
    const name = {
      attemptStart: '开始尝试',
      attemptSuccess: '尝试成功',
      attemptHttpError: 'HTTP 错误',
      attemptFailed: '尝试失败',
      attemptCancelled: '尝试取消',
      retryDecision: '判定可重试',
      retryScheduled: '退避开始',
      retryDue: '退避结束',
      retryWaitCancelled: '退避取消',
      fallbackCache: '降级缓存',
      fallbackPlaceholder: '降级占位数据',
      retriesExhausted: '达到重试上限',
      requestCancelled: '请求取消',
      requestUnloaded: '页面卸载取消',
      requestEnd: '请求结束'
    }[event.type] || event.type;
    return `${formatTime(event.at)} ${name}${event.attempt ? ` #${event.attempt}` : ''}${event.duration !== undefined ? ` ${formatMs(event.duration)}` : ''}${event.delay !== undefined ? ` 延迟 ${formatMs(event.delay)}` : ''}${event.status ? ` HTTP ${event.status}` : ''}`;
  });
  const response = request.response ? `\n\n响应来源：${request.response.source}\n${request.response.body || ''}` : '';
  return `配置：${JSON.stringify(request.options, null, 2)}\n\n事件时序：\n${events.join('\n')}${response}${request.error ? `\n\n错误：${request.error}` : ''}`;
}

function createHistoryElement(request) {
  const element = itemTemplate.content.firstElementChild.cloneNode(true);
  element.dataset.id = request.id;
  element.querySelector('.history-main').addEventListener('click', (event) => {
    if (event.target.classList.contains('cancel-button')) return;
    const details = element.querySelector('.details');
    details.hidden = !details.hidden;
  });
  element.querySelector('.cancel-button').addEventListener('click', () => cancelRequest(request.id, 'cancel'));
  return element;
}

function updateHistoryElement(element, request, includeDetails) {
  element.querySelector('.method-badge').textContent = request.method;
  element.querySelector('.history-url').textContent = request.url;
  const badge = element.querySelector('.status-badge');
  badge.textContent = STATUS_TEXT[request.status] || request.status;
  badge.className = `status-badge ${statusClass(request.status)}`;
  element.querySelector('.attempt-count').textContent = `尝试 ${request.attemptCount}/${request.options.retries + 1}`;
  element.querySelector('.elapsed').textContent = request.endedAt
    ? `总耗时 ${formatMs(request.durationMs)}`
    : `已耗时 ${formatMs(Date.now() - request.startedAt)}`;
  element.querySelector('.created-at').textContent = formatTime(request.startedAt);
  element.querySelector('.cancel-button').disabled = Boolean(request.endedAt);
  if (includeDetails) element.querySelector('.details').textContent = buildDetails(request);
}

function calculateHistorySignature() {
  return requests.map((request) => {
    const lastEvent = request.events[request.events.length - 1];
    return [
      request.id,
      request.status,
      request.attemptCount,
      request.endedAt,
      request.durationMs,
      request.events.length,
      lastEvent?.type,
      lastEvent?.at,
      request.response?.source,
      request.error
    ].join('|');
  }).join('||');
}

function reconcileHistory(includeDetails) {
  const active = requests.filter((request) => !request.endedAt).length;
  timelineSummary.textContent = requests.length === 0
    ? '暂无请求'
    : `${requests.length} 条请求 · ${active} 条进行中 · Canvas 按真实时间绘制`;
  cancelAllButton.disabled = active === 0;

  if (requests.length === 0) {
    historyList.className = 'history-list empty';
    historyList.textContent = '暂无请求历史';
    historySignature = '';
    return;
  }

  historyList.className = 'history-list';
  const existing = new Map(Array.from(historyList.children).map((element) => [element.dataset.id, element]));
  const visibleIds = new Set();

  requests.forEach((request, index) => {
    visibleIds.add(request.id);
    let element = existing.get(request.id);
    if (!element) element = createHistoryElement(request);
    updateHistoryElement(element, request, includeDetails);
    if (historyList.children[index] !== element) historyList.insertBefore(element, historyList.children[index] || null);
  });

  Array.from(historyList.children).forEach((element) => {
    if (!visibleIds.has(element.dataset.id)) element.remove();
  });
}

function renderHistory(now) {
  const signature = calculateHistorySignature();
  const signatureChanged = signature !== historySignature;
  const active = requests.some((request) => !request.endedAt);
  const elapsedDue = active && now - lastElapsedUpdate > 200;
  if (signatureChanged || elapsedDue) {
    reconcileHistory(signatureChanged);
    historySignature = signature;
    lastElapsedUpdate = now;
  }
}

function renderLoop(now = performance.now()) {
  timeline.setRequests(requests);
  timeline.render();
  renderHistory(now);
  requestAnimationFrame(renderLoop);
}

function abortRequest(request, reason) {
  if (request.endedAt) return;
  const message = reason === 'unload' ? '页面卸载，取消请求' : '请求已取消';
  if (request.activeController) {
    request.activeController.abort(Object.assign(new Error(message), {
      name: 'AbortError',
      reason
    }));
  } else {
    worker.postMessage({ type: 'cancelRetry', id: request.id });
  }

  request.status = reason === 'unload' ? 'unloaded' : 'cancelled';
  request.error = message;
  addEvent(request, reason === 'unload' ? 'requestUnloaded' : 'requestCancelled', {});
  finalizeRequest(request);
}

function cancelRequest(id, reason = 'cancel') {
  const request = requests.find((item) => item.id === id);
  if (!request || request.endedAt) return;
  abortRequest(request, reason);
}

function cancelAll(reason = 'cancel') {
  requests.filter((request) => !request.endedAt).forEach((request) => cancelRequest(request.id, reason));
}

function applyPreset() {
  if (presetSelect.value === 'custom') return;
  urlInput.value = PRESETS[presetSelect.value];
  if (presetSelect.value === 'timeout') timeoutInput.value = 1600;
  if (presetSelect.value === 'http404') retriesInput.value = 0;
  if (presetSelect.value === 'http503' || presetSelect.value === 'offline') retriesInput.value = 3;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const options = readOptions();
  if (!options.url) {
    urlInput.focus();
    return;
  }

  const request = {
    id: createId(),
    method: options.method.toUpperCase(),
    url: options.url,
    options,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    attemptCount: 0,
    attempts: [],
    events: [],
    response: null,
    error: null,
    fallbackUsed: null,
    activeController: null
  };
  requests = [request, ...requests].slice(0, 50);
  addEvent(request, 'requestStart');
  await executeRequest(request, 1);
});

presetSelect.addEventListener('change', () => {
  applyPreset();
});

cancelAllButton.addEventListener('click', () => cancelAll('cancel'));

clearHistoryButton.addEventListener('click', async () => {
  requests = [];
  await clearHistoryStore().catch(() => {});
});

clearCacheButton.addEventListener('click', async () => {
  await clearCacheStore().catch(() => {});
});

window.addEventListener('pagehide', () => {
  requests.filter((request) => !request.endedAt).forEach((request) => abortRequest(request, 'unload'));
  worker.postMessage({ type: 'cancelAll' });
  worker.terminate();
}, { once: true });

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    worker = createWorker();
  }
});

applyPreset();
getAllHistory()
  .then((history) => {
    requests = history.map((request) => request.endedAt ? request : {
      ...request,
      status: 'unloaded',
      endedAt: Date.now(),
      durationMs: null,
      error: '上次页面卸载时请求仍在进行'
    });
  })
  .catch(() => {
    requests = [];
  })
  .finally(() => {
    renderLoop();
  });
