// 零依赖 Node mock 服务器：用于复现各类异常链路。
//   node mock-server.js            （默认 8787 端口）
// 端点：
//   GET /ok               100ms 后返回 JSON
//   GET /flaky            按 ?force=500 或随机返回 500（重试可观察）
//   GET /slow?ms=5000     延迟 ms 毫秒（配合超时验证）
//   GET /error            恒返回 500
//   GET /notfound         恒返回 404
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8787;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const u = url.parse(req.url, true);
  const send = (status, body) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
  };

  switch (u.pathname) {
    case '/ok':
      setTimeout(() => send(200, { ok: true, at: new Date().toISOString() }), 100);
      break;
    case '/flaky': {
      const force = parseInt(u.query.force, 10);
      const fail = Number.isFinite(force) ? force >= 500 : Math.random() < 0.6;
      send(fail ? 500 : 200, fail
        ? { ok: false, error: 'flaky failure, retry me' }
        : { ok: true, at: new Date().toISOString() });
      break;
    }
    case '/slow': {
      const ms = Math.min(30000, parseInt(u.query.ms, 10) || 5000);
      setTimeout(() => send(200, { ok: true, delayedMs: ms }), ms);
      break;
    }
    case '/error':
      send(500, { ok: false, error: 'server error' });
      break;
    case '/notfound':
      send(404, { ok: false, error: 'not found' });
      break;
    default:
      send(404, { error: 'unknown endpoint' });
  }
});

server.listen(PORT, () => {
  console.log(`mock server on http://localhost:${PORT}`);
});
