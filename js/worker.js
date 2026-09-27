// 请求引擎（Web Worker）：fetch + AbortController 实现超时、重试、退避抖动、缓存降级。
// 每个任务独立的 controller 与状态，并发任务通过 id 隔离，互不干扰。
import { cacheGet, cacheSet, historyAdd } from './db.js';

const tasks = new Map(); // id -> { controller, cancelled, rejectSleep }

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'start') {
    runTask(msg.task).catch((err) => {
      post({ type: 'error', id: msg.task.id, message: String(err && err.message || err) });
    });
  } else if (msg.type === 'cancel') {
    cancelTask(msg.id);
  } else if (msg.type === 'cancelAll') {
    for (const id of tasks.keys()) cancelTask(id);
  }
};

function post(msg) {
  self.postMessage(msg);
}

function cancelTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  t.cancelled = true;
  if (t.rejectSleep) t.rejectSleep(new DOMException('cancelled', 'AbortError'));
  if (t.controller) t.controller.abort();
}

// 计算第 attempt 次重试前的等待时间（attempt 从 1 开始）
export function backoffDelay(cfg, attempt) {
  const { strategy, baseDelay, maxDelay, jitter } = cfg;
  let delay;
  if (strategy === 'fixed') delay = baseDelay;
  else if (strategy === 'linear') delay = baseDelay * attempt;
  else delay = baseDelay * Math.pow(2, attempt - 1); // exponential
  delay = Math.min(delay, maxDelay);
  if (jitter) delay = Math.random() * delay; // full jitter: [0, delay]
  return Math.round(delay);
}

function sleep(ms, task) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      task.rejectSleep = null;
      resolve();
    }, ms);
    task.rejectSleep = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });
}

// 单次尝试：返回 { ok, kind, status, durationMs, body?, error? }
async function attemptOnce(task, attemptNo) {
  const state = tasks.get(task.id);
  const controller = new AbortController();
  state.controller = controller;

  const start = performance.now();
  const wallStart = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, task.timeout);

  try {
    const res = await fetch(task.url, {
      method: task.method,
      headers: task.headers,
      body: task.method === 'GET' || task.method === 'HEAD' ? undefined : task.body,
      signal: controller.signal,
    });
    const durationMs = Math.round(performance.now() - start);
    if (!res.ok) {
      return { attempt: attemptNo, ok: false, kind: 'http', status: res.status, durationMs, wallStart, wallEnd: Date.now(), error: `HTTP ${res.status} ${res.statusText}` };
    }
    const text = await res.text();
    return { attempt: attemptNo, ok: true, kind: 'ok', status: res.status, durationMs, wallStart, wallEnd: Date.now(), body: text.slice(0, 4096) };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    if (state.cancelled) {
      return { attempt: attemptNo, ok: false, kind: 'cancelled', durationMs, wallStart, wallEnd: Date.now(), error: '已取消' };
    }
    if (timedOut) {
      return { attempt: attemptNo, ok: false, kind: 'timeout', durationMs, wallStart, wallEnd: Date.now(), error: `超时（>${task.timeout}ms）` };
    }
    // fetch 网络层失败（DNS/断网/CORS 等）抛 TypeError
    return { attempt: attemptNo, ok: false, kind: 'network', durationMs, wallStart, wallEnd: Date.now(), error: `网络错误：${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function placeholderData(task) {
  return JSON.stringify({
    placeholder: true,
    reason: '请求失败且无可用缓存，返回占位数据',
    url: task.url,
    generatedAt: new Date().toISOString(),
  }, null, 2);
}

async function runTask(task) {
  const state = { controller: null, cancelled: false, rejectSleep: null };
  tasks.set(task.id, state);

  const record = {
    id: task.id,
    url: task.url,
    method: task.method,
    status: 'running', // running | ok | cache | placeholder | failed | cancelled
    retries: 0,
    maxRetries: task.retries,
    startTime: Date.now(),
    endTime: null,
    durationMs: null,
    attempts: [],
    waits: [], // 退避等待段 { afterAttempt, delayMs, wallStart, wallEnd }
    body: null,
    error: null,
    config: {
      timeout: task.timeout,
      backoff: task.backoff,
      cacheTtl: task.cacheTtl,
    },
  };
  post({ type: 'update', record: snapshot(record) });

  try {
    for (let attempt = 1; attempt <= task.retries + 1; attempt++) {
      const result = await attemptOnce(task, attempt);
      record.attempts.push(result);

      if (result.kind === 'cancelled') {
        record.status = 'cancelled';
        finish(record);
        return;
      }

      if (result.ok) {
        record.status = 'ok';
        record.body = result.body;
        record.retries = attempt - 1;
        // 成功写缓存
        try { await cacheSet(cacheKey(task), result.body, task.cacheTtl); } catch (_) {}
        finish(record);
        return;
      }

      record.error = result.error;
      record.retries = attempt - 1;

      if (attempt <= task.retries) {
        const delayMs = backoffDelay(task.backoff, attempt);
        const wait = { afterAttempt: attempt, delayMs, wallStart: Date.now(), wallEnd: Date.now() + delayMs };
        record.waits.push(wait);
        record.status = 'retrying';
        post({ type: 'update', record: snapshot(record) });
        await sleep(delayMs, state); // 取消时会 reject AbortError
        record.status = 'running';
        post({ type: 'update', record: snapshot(record) });
      }
    }

    // 重试次数上限已到仍失败 → 缓存降级
    record.retries = task.retries;
    let cached = null;
    try { cached = await cacheGet(cacheKey(task)); } catch (_) {}

    if (cached && cached.hit && !cached.expired) {
      record.status = 'cache';
      record.body = cached.data;
      record.cacheInfo = { storedAt: cached.storedAt, ttlMs: cached.ttlMs };
    } else if (cached && cached.hit && cached.expired) {
      record.status = 'placeholder';
      record.body = placeholderData(task);
      record.cacheInfo = { storedAt: cached.storedAt, ttlMs: cached.ttlMs, expired: true };
    } else {
      record.status = 'placeholder';
      record.body = placeholderData(task);
    }
    finish(record);
  } catch (err) {
    if (state.cancelled || (err && err.name === 'AbortError')) {
      record.status = 'cancelled';
    } else {
      record.status = 'failed';
      record.error = String(err && err.message || err);
    }
    finish(record);
  } finally {
    tasks.delete(task.id);
  }
}

function cacheKey(task) {
  return `${task.method} ${task.url}`;
}

function finish(record) {
  record.endTime = Date.now();
  record.durationMs = record.endTime - record.startTime;
  post({ type: 'update', record: snapshot(record) });
  // 历史持久化（取消的也记录，便于排查）
  historyAdd(record).catch(() => {});
}

function snapshot(record) {
  return JSON.parse(JSON.stringify(record));
}
