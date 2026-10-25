import { detectBrowser, findBrowserExecutable } from '../packages/server/src/browser.js';

// 在 Node 中检查真实浏览器;CI 不能因为缺少浏览器而悄悄跳过采集与登录用例。
if (process.env.CI || process.env.UIEV_REQUIRE_BROWSER === '1') {
  const browser = await detectBrowser(true);
  if (!browser.found || !findBrowserExecutable()) {
    throw new Error('完整测试需要可用的 Chrome/Edge。请先安装浏览器,或设置 UIEV_CHROME_PATH;CI 不允许跳过浏览器测试。');
  }
}
