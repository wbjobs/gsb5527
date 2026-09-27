# 请求韧性观察台

纯静态、无框架的请求状态调试页面，使用 Fetch、AbortController、IndexedDB、Web Worker 与 Canvas 实现。

## 运行

必须通过 HTTP 服务打开，以便 ES Module 和 Web Worker 正常加载：

```bash
python3 -m http.server 8000
```

然后访问 `http://127.0.0.1:8000/`。

## 功能

- 可配置重试次数、基础退避、退避上限、抖动比例、单次请求超时和缓存 TTL。
- 区分网络中断、请求超时、可重试 HTTP 错误与不可重试 HTTP 错误。
- Web Worker 负责非阻塞退避等待；退避公式为 `min(base * 2^(attempt-1), max)`，再叠加正向随机抖动。
- AbortController 中断正在进行的 Fetch；等待退避时取消 Worker timer。
- GET 成功响应写入 IndexedDB；最终失败时优先返回缓存，缓存已过期则返回过期缓存，否则返回占位数据。
- 每个请求使用独立 ID、状态、事件、AbortController 和计时器，并发请求互不共享取消信号。
- Canvas 展示请求生命周期、每次网络尝试、退避等待和终态，悬停可查看耗时。
- 历史持久化到 IndexedDB，可展开查看完整事件时序；支持清空历史与缓存。
- `pagehide` 时统一中断活动请求并终止重试 Worker。

## 建议验收路径

1. **成功**：选择“成功场景”，状态为成功，Canvas 出现一次绿色尝试。
2. **HTTP 分类**：选择 503 会重试；选择 404 因重试次数为 0 立即失败。
3. **超时**：选择“超时场景”，默认 1.6 秒中断，达到重试上限后走缓存或占位数据。
4. **网络中断**：选择“网络中断”，失败被归类为 `network`，按指数退避重试。
5. **缓存过期**：先发起一次成功 GET，把 TTL 设为 1000ms，等待过期后请求离线或 503 场景的同一 URL；响应来源显示 `stale-cache`。
6. **并发隔离**：快速连续发起多个请求，分别取消其中一个，其余请求仍继续。
7. **取消**：在网络尝试或黄色退避段点击取消，请求终态为“已取消”。
8. **页面卸载**：请求中刷新或关闭页面，活动 Fetch 收到 Abort 信号，Worker 被终止。

## 文件

- `index.html`：页面结构。
- `styles.css`：响应式布局和状态样式。
- `js/app.js`：请求状态机、取消、重试决策、缓存降级、历史渲染。
- `js/backoff.js`：退避、抖动和异常分类。
- `js/db.js`：IndexedDB 缓存与历史存储。
- `js/retry-worker.js`：Worker 退避计时器。
- `js/timeline.js`：Canvas 请求时序可视化。
