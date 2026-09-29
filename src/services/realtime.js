// 即時同步：主持人一按，檢錄和裁判的手機大約 1 秒內跟著動。
// Live sync: when the host presses a button, the check-in and judge phones follow within about a second.
//
// 用 Server-Sent Events，因為它只要一條普通的 HTTP 連線，Docker、Railway、自架主機都能跑，
// 手機端斷線會自動重連，會場網路不穩時比 WebSocket 好照顧。
// Server-Sent Events: one ordinary HTTP connection, so it works on Docker, Railway and a self-hosted box.
// Browsers reconnect on their own, which matters on flaky venue wifi.

import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(0);

let sequence = 0;

export function publish(competitionId, event) {
  sequence += 1;
  const payload = { ...event, seq: sequence, at: new Date().toISOString() };
  bus.emit(`competition:${competitionId}`, payload);
  return payload;
}

export function subscribe(competitionId, listener) {
  const channel = `competition:${competitionId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}

// 掛在 Express 上的 SSE 端點。
// The SSE endpoint mounted on Express.
export function sseHandler(req, res, competitionId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const unsubscribe = subscribe(competitionId, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // 有些代理伺服器會把久沒動靜的連線切掉，所以固定送一個空白心跳。
  // Some proxies drop an idle connection, so send a comment as a heartbeat.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  return cleanup;
}

export default { publish, subscribe, sseHandler };
