import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 采集测试会启动真实浏览器,串行执行更稳
    fileParallelism: false,
  },
});
