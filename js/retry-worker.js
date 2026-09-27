import { calculateJitteredDelay } from './backoff.js';

const timers = new Map();

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer.timeout);
    clearInterval(timer.interval);
    timers.delete(id);
  }
}

function postTick(id, runAt, kind = 'waiting') {
  const remaining = Math.max(0, runAt - Date.now());
  self.postMessage({ type: 'retryTick', id, runAt, remaining, kind });
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'scheduleRetry') {
    clearTimer(data.id);
    const delay = calculateJitteredDelay({
      attempt: data.attempt,
      baseDelayMs: data.baseDelayMs,
      maxDelayMs: data.maxDelayMs,
      jitter: data.jitter
    });
    const runAt = Date.now() + delay;
    self.postMessage({ type: 'retryScheduled', id: data.id, attempt: data.attempt, delay, runAt });
    const interval = setInterval(() => postTick(data.id, runAt, 'waiting'), 80);
    const timeout = setTimeout(() => {
      clearTimer(data.id);
      self.postMessage({ type: 'retryDue', id: data.id, attempt: data.attempt, scheduledDelay: delay });
    }, delay);
    timers.set(data.id, { timeout, interval });
    postTick(data.id, runAt, 'waiting');
  }

  if (data.type === 'cancelRetry') {
    clearTimer(data.id);
    self.postMessage({ type: 'retryCancelled', id: data.id });
  }

  if (data.type === 'cancelAll') {
    for (const id of timers.keys()) clearTimer(id);
    self.postMessage({ type: 'allRetriesCancelled' });
  }
};
