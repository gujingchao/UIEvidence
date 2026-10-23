import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

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

const NO_BROWSER = (errors: string[]) =>
  new Error(
    `找不到可用的 Chrome 或 Edge。请安装 Chrome,或用环境变量 UIEV_CHROME_PATH 指定浏览器路径。(${errors.join(' | ')})`,
  );

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
  throw NO_BROWSER(errors);
}

export interface BrowserSession {
  context: BrowserContext;
  /** 例如 "chrome 156.0.8078.47",写入每条采集记录 */
  label: string;
  close(): Promise<void>;
}

/**
 * 打开一次采集用的浏览器会话:全新的临时配置。
 * 传入 storageState 时,会带上使用者事先登录好的状态(Cookie、本地存储);
 * 不传则完全没有登录状态。不会读取使用者日常浏览器的任何数据。
 */
export async function openSession(options: {
  storageState: string | null;
  viewport: { width: number; height: number };
}): Promise<BrowserSession> {
  const { browser, label } = await launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: options.viewport,
      serviceWorkers: 'block',
      acceptDownloads: false,
      ...(options.storageState ? { storageState: options.storageState } : {}),
    });
    return { context, label, close: () => browser.close().catch(() => {}) };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
/** 找本机浏览器的可执行文件,给"登录窗口"用普通进程启动(不经过 Playwright,避免被站点识别为自动化浏览器) */
export function findBrowserExecutable(): string | null {
  const custom = process.env.UIEV_CHROME_PATH;
  if (custom) return fs.existsSync(custom) ? custom : null;

  const env = process.env;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]) {
      if (!base) continue;
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const base of [env['PROGRAMFILES(X86)'], env['PROGRAMFILES']]) {
      if (!base) continue;
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/microsoft-edge',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    );
  }
  return candidates.find((p) => fs.existsSync(p)) ?? null;
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
