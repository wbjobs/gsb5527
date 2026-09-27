export function calculateBaseDelay({ attempt, baseDelayMs, maxDelayMs }) {
  const base = Number(baseDelayMs);
  const max = Number(maxDelayMs);
  const safeBase = Math.max(0, Number.isFinite(base) ? base : 0);
  const safeMax = Math.max(0, Number.isFinite(max) ? max : 0);
  const exponential = safeBase * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, safeMax || exponential);
}

export function calculateJitteredDelay(options) {
  const baseDelay = calculateBaseDelay(options);
  const ratio = Math.min(1, Math.max(0, Number(options.jitter) || 0));
  const maxJitter = baseDelay * ratio;
  const jitter = maxJitter > 0 ? Math.random() * maxJitter : 0;
  return Math.round(baseDelay + jitter);
}

export function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function classifyError(error, status) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    if (error?.reason === 'unload') return 'unload';
    if (error?.reason === 'cancel') return 'cancelled';
    return 'timeout';
  }
  if (Number.isInteger(status) && status >= 400) return 'http-error';
  if (error?.name === 'TypeError' || error?.name === 'NetworkError') return 'network';
  return error?.name ? `error:${error.name}` : 'unknown';
}

export function isRetryableFailure({ kind, status }) {
  if (kind === 'network' || kind === 'timeout') return true;
  if (kind === 'http-error') return isRetryableHttpStatus(status);
  return false;
}
