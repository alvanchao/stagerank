import config from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { flushReports } from './services/stats.js';
import { scheduleRemoteIds } from './payments/remoteIds.js';

const app = createApp();

async function start() {
  // 一鍵部署：啟動時自動把資料庫升級到最新，主辦不用做任何事。
  // One-click deploy: the schema upgrades itself on boot so the organiser does nothing.
  if (process.env.SKIP_MIGRATE !== '1') {
    await migrate();
  }

  app.listen(config.port, () => {
    console.log(`StageRank listening on ${config.baseUrl} (${config.env})`);
    if (!config.adminToken) console.warn('[stagerank] ADMIN_TOKEN is not set: the back office is disabled.');
  });

  // 夥伴 ID 開機抓一次、之後每天一次。抓不到就留空，交易照跑。
  // Partner ids: fetched on boot, then daily. Unreachable means blank, and transactions proceed.
  scheduleRemoteIds();

  // 統計回報每 6 小時試送一次，失敗只記錄、不影響比賽。
  // Usage reports retry every 6 hours; failures are logged and never affect a competition.
  if (config.telemetry.enabled) {
    const timer = setInterval(() => {
      flushReports().catch((err) => console.warn('[stats]', err.message));
    }, 6 * 60 * 60 * 1000);
    timer.unref();
  }
}

start().catch((err) => {
  console.error('[stagerank] failed to start:', err);
  process.exit(1);
});
