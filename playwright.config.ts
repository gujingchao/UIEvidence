import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const dataDir = path.join(os.tmpdir(), `uiev-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4390',
    // 使用本机 Chrome,不下载浏览器
    channel: 'chrome',
    headless: true,
  },
  webServer: {
    // 示例项目的测试站由服务自己启动,不需要另开进程
    command: 'npm run build && npm run start -w @uievidence/server',
    env: { PORT: '4390', UIEV_DATA_DIR: dataDir },
    url: 'http://127.0.0.1:4390/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
