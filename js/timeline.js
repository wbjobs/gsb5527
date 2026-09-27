const COLORS = {
  running: '#6aa5ff',
  success: '#43d39e',
  waiting: '#ffc85a',
  error: '#ff6b7a',
  cache: '#b78cff',
  placeholder: '#ffc85a',
  cancelled: '#8c99b3',
  fresh: '#2d4268',
  grid: 'rgba(255,255,255,0.08)',
  text: '#93a1bd'
};

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function terminalColor(status, fallbackUsed) {
  if (status === 'success') return fallbackUsed ? COLORS.cache : COLORS.success;
  if (status === 'cache') return COLORS.cache;
  if (status === 'placeholder') return COLORS.placeholder;
  if (status === 'cancelled' || status === 'unloaded') return COLORS.cancelled;
  return COLORS.error;
}

export class TimelineCanvas {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.requests = [];
    this.hoverIndex = null;
    this.handleMouseMove = this.onMouseMove.bind(this);
    this.handleMouseLeave = this.onMouseLeave.bind(this);
    canvas.addEventListener('mousemove', this.handleMouseMove);
    canvas.addEventListener('mouseleave', this.handleMouseLeave);
  }

  setRequests(requests) {
    this.requests = requests;
  }

  render(now = Date.now()) {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const desiredHeight = Math.max(360, 34 + this.requests.length * 34 + 40);
    canvas.style.height = `${desiredHeight}px`;
    const height = canvas.clientHeight || desiredHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (this.requests.length === 0) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '14px system-ui';
      ctx.fillText('发起请求后，这里将按真实时间绘制每次网络尝试与退避等待。', 20, height / 2);
      return;
    }

    const margin = { top: 34, right: 28, bottom: 40, left: 178 };
    const plotWidth = Math.max(80, width - margin.left - margin.right);
    const rowHeight = 34;
    const contentHeight = margin.top + this.requests.length * rowHeight;
    const allTimes = this.requests.flatMap((request) => [
      request.startedAt,
      ...request.attempts.flatMap((attempt) => [attempt.startedAt, attempt.endedAt || now]),
      ...request.events.filter((event) => event.type === 'retryScheduled' || event.type === 'retryDue')
        .flatMap((event) => [event.at, event.runAt].filter(Number.isFinite)),
      request.endedAt || now
    ]);
    const minTime = Math.min(...allTimes);
    const maxTime = Math.max(...allTimes, now, minTime + 250);
    const span = Math.max(250, maxTime - minTime);
    const pointX = (time) => margin.left + ((time - minTime) / span) * plotWidth;

    ctx.font = '12px system-ui';
    ctx.textBaseline = 'middle';

    for (let tick = 0; tick <= 5; tick += 1) {
      const time = minTime + (span * tick) / 5;
      const x = pointX(time);
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, margin.top - 10);
      ctx.lineTo(x, Math.max(height - margin.bottom + 12, contentHeight));
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(formatDuration(time - minTime), x - 18, height - margin.bottom + 26);
    }

    this.hitAreas = [];

    this.requests.forEach((request, index) => {
      const y = margin.top + index * rowHeight + rowHeight / 2;
      const label = `${request.method} ${request.url.replace(/^https?:\/\//, '')}`;
      const clipped = label.length > 22 ? `${label.slice(0, 21)}…` : label;
      ctx.fillStyle = this.hoverIndex === index ? '#eef4ff' : COLORS.text;
      ctx.fillText(clipped, 12, y);

      const baselineStart = pointX(request.startedAt);
      const baselineEnd = pointX(request.endedAt || now);
      ctx.strokeStyle = COLORS.fresh;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(baselineStart, y);
      ctx.lineTo(baselineEnd, y);
      ctx.stroke();

      request.attempts.forEach((attempt) => {
        const attemptStart = pointX(attempt.startedAt);
        const attemptEnd = pointX(attempt.endedAt || now);
        const active = !attempt.endedAt && request.status === 'running';
        ctx.strokeStyle = active ? COLORS.running : attempt.ok ? COLORS.success : COLORS.error;
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(attemptStart, y);
        ctx.lineTo(attemptEnd, y);
        ctx.stroke();
        this.hitAreas.push({ index, x: attemptStart, width: Math.max(6, attemptEnd - attemptStart), y: y - 8, height: 16, kind: 'attempt', attempt });
      });

      request.events.forEach((event) => {
        if (event.type === 'retryScheduled' || event.type === 'retryWaiting') {
          const start = pointX(event.at);
          const end = event.runAt ? pointX(event.runAt) : start;
          ctx.strokeStyle = COLORS.waiting;
          ctx.lineWidth = 8;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(start, y);
          ctx.lineTo(end, y);
          ctx.stroke();
          ctx.setLineDash([]);
          this.hitAreas.push({ index, x: start, width: Math.max(6, end - start), y: y - 8, height: 16, kind: 'wait', event });
        }
      });

      const finalX = pointX(request.endedAt || now);
      const finalColor = request.endedAt ? terminalColor(request.status, request.fallbackUsed) : COLORS.running;
      ctx.fillStyle = finalColor;
      ctx.beginPath();
      ctx.arc(finalX, y, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  onMouseMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = (this.hitAreas || []).find((area) => x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height);
    if (!hit) {
      this.hoverIndex = null;
      this.tooltip.textContent = '';
      return;
    }
    this.hoverIndex = hit.index;
    const request = this.requests[hit.index];
    if (hit.kind === 'attempt') {
      const attempt = hit.attempt;
      const duration = attempt.endedAt ? formatDuration(attempt.endedAt - attempt.startedAt) : '进行中';
      this.tooltip.textContent = `${request.method} ${request.url}\n第 ${attempt.attempt} 次尝试 · ${attempt.kind || '运行中'} · ${duration}${attempt.status ? ` · HTTP ${attempt.status}` : ''}`;
    } else {
      this.tooltip.textContent = `${request.method} ${request.url}\n第 ${hit.event.attempt} 次重试退避 · 计划等待 ${formatDuration(hit.event.delay || 0)} · 剩余 ${formatDuration(hit.event.remaining || 0)}`;
    }
  }

  onMouseLeave() {
    this.hoverIndex = null;
    this.tooltip.textContent = '';
  }
}
