import { chromium, type Browser } from 'playwright-core';

export interface LaunchedBrowser {
  browser: Browser;
  /** 例如 "chrome 130.0.6723.58",写入每条采集记录 */
  label: string;
}

interface Attempt {
  label: string;
  options: { channel?: string; executablePath?: string };
}

function attempts(): Attempt[] {
  const custom = process.env.UIEV_CHROME_PATH;
  if (custom) return [{ label: 'custom', options: { executablePath: custom } }];
  return [
    { label: 'chrome', options: { channel: 'chrome' } },
    { label: 'msedge', options: { channel: 'msedge' } },
  ];
}

/**
 * 启动本机 Chrome(找不到时回退 Edge)。
 * 不使用持久化用户目录:每次启动都是全新的临时配置,
 * 不会读取或修改使用者日常浏览器的 Cookie 和登录状态。
 */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  const errors: string[] = [];
  for (const attempt of attempts()) {
    try {
      const browser = await chromium.launch({ ...attempt.options, headless: true });
      return { browser, label: `${attempt.label} ${browser.version()}` };
    } catch (err) {
      errors.push(`${attempt.label}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(
    `找不到可用的 Chrome 或 Edge。请安装 Chrome,或用环境变量 UIEV_CHROME_PATH 指定浏览器路径。(${errors.join(' | ')})`,
  );
}

export interface BrowserInfo {
  found: boolean;
  channel: string | null;
  version: string | null;
}

let cached: { at: number; info: BrowserInfo } | null = null;

export async function detectBrowser(force = false): Promise<BrowserInfo> {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.info;
  let info: BrowserInfo;
  try {
    const { browser, label } = await launchBrowser();
    await browser.close();
    const [channel = null, version = null] = label.split(' ');
    info = { found: true, channel, version };
  } catch {
    info = { found: false, channel: null, version: null };
  }
  cached = { at: Date.now(), info };
  return info;
}
