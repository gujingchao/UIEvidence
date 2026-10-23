import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import type { LoginState, Project } from '@uievidence/shared';
import { findBrowserExecutable } from './browser.js';
import { now } from './db.js';
import { ConflictError, type Repo } from './repo.js';
import { assertUrlAllowed, isHostAllowed, isUrlAllowed } from './scope.js';
import { type Storage } from './storage.js';

type Spawner = (command: string, args: string[]) => ChildProcess;
type Connector = (port: number) => Promise<Browser>;

const defaultSpawn: Spawner = (command, args) => spawn(command, args, { stdio: 'ignore', windowsHide: false });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome 启动后调试端口要过一会儿才可用,重试连接 */
export const connectOverCdp: Connector = async (port) => {
  let lastError: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw lastError;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

interface WindowSession {
  child: ChildProcess;
  /** 窗口进程退出时完成 */
  exited: Promise<void>;
  browser: Browser | null;
  timer: NodeJS.Timeout | null;
  /** 已经保存过登录状态 */
  saved: boolean;
  closed: boolean;
}

export interface LoginOptions {
  spawn?: Spawner;
  findExe?: () => string | null;
  connect?: Connector;
  /** 额外的浏览器启动参数,测试里用来让窗口无界面运行 */
  extraArgs?: string[];
  /** 保存登录状态的间隔,毫秒 */
  snapshotMs?: number;
}

/**
 * 登录窗口:用本机 Chrome 打开一个可见窗口,由使用者亲自登录。
 *
 *  - 窗口是普通的浏览器进程,不经过 Playwright 的自动化模式:
 *    自动化浏览器带有自动化标记,部分站点(验证码、风控)会拒绝在里面登录。
 *  - 密码、验证码、二次验证都由使用者在窗口里完成,本工具从不接触,也不保存任何账号密码。
 *  - 登录状态(Cookie、本地存储)在窗口开着的时候就保存下来,而不是靠浏览器配置目录:
 *    很多网站用的是"会话 Cookie",浏览器一关就丢,窗口关了再复用配置目录是行不通的。
 *  - 保存时只保留白名单域名下的内容。
 *  - 窗口开着时会短暂开放一个只监听本机的调试端口,窗口关闭后随即消失。
 */
export class LoginManager {
  private sessions = new Map<number, WindowSession>();
  private spawnFn: Spawner;
  private findExe: () => string | null;
  private connect: Connector;
  private extraArgs: string[];
  private snapshotMs: number;

  constructor(
    private repo: Repo,
    private storage: Storage,
    options: LoginOptions = {},
  ) {
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.findExe = options.findExe ?? findBrowserExecutable;
    this.connect = options.connect ?? connectOverCdp;
    this.extraArgs = options.extraArgs ?? [];
    this.snapshotMs = options.snapshotMs ?? 1500;
  }

  isOpen(projectId: number): boolean {
    return this.sessions.has(projectId);
  }

  state(project: Project): LoginState {
    return { open: this.isOpen(project.id), setAt: project.loginSetAt };
  }

  async start(project: Project, url: string): Promise<void> {
    if (this.isOpen(project.id)) throw new ConflictError('登录窗口已经打开了,请在那个窗口里完成登录');
    // 起始网址必须在白名单内,并且只接受 http(s);传给浏览器前用解析后的网址,避免被当成命令行参数
    assertUrlAllowed(url, project.allowedDomains);
    const target = new URL(url).href;

    const exe = this.findExe();
    if (!exe) throw new Error('找不到 Chrome 或 Edge,无法打开登录窗口。请安装 Chrome,或设置环境变量 UIEV_CHROME_PATH');

    const dir = this.storage.loginWindowDir(project.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const port = await freePort();

    const child = this.spawnFn(exe, [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...this.extraArgs,
      target,
    ]);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const session: WindowSession = { child, exited, browser: null, timer: null, saved: false, closed: false };
    this.sessions.set(project.id, session);

    void exited.then(() => this.cleanup(project.id, session));
    child.once('error', () => this.cleanup(project.id, session));
    void this.attach(project, session, port);
  }

  private async attach(project: Project, session: WindowSession, port: number): Promise<void> {
    try {
      const browser = await this.connect(port);
      if (session.closed) {
        await browser.close().catch(() => {});
        return;
      }
      session.browser = browser;
      session.timer = setInterval(() => void this.snapshot(project, session), this.snapshotMs);
    } catch {
      /* 连不上调试端口:窗口仍可使用,但无法保存登录状态,finish 时会提示 */
    }
  }

  /** 把窗口里当前的登录状态保存到项目目录;内容为空时不覆盖已有的 */
  private async snapshot(project: Project, session: WindowSession): Promise<boolean> {
    const browser = session.browser;
    if (!browser || session.closed) return false;
    try {
      const context = browser.contexts()[0];
      if (!context) return false;
      const state = await context.storageState();
      const cookies = state.cookies.filter((c) => isHostAllowed(c.domain, project.allowedDomains));
      const origins = state.origins.filter((o) => isUrlAllowed(o.origin, project.allowedDomains));
      if (!cookies.length && !origins.some((o) => o.localStorage.length)) return false;
      fs.writeFileSync(this.storage.authStatePath(project.id), JSON.stringify({ cookies, origins }), { mode: 0o600 });
      session.saved = true;
      return true;
    } catch {
      return false;
    }
  }

  private cleanup(projectId: number, session: WindowSession): void {
    if (this.sessions.get(projectId) !== session) return;
    session.closed = true;
    if (session.timer) clearInterval(session.timer);
    this.sessions.delete(projectId);
    fs.rmSync(this.storage.loginWindowDir(projectId), { recursive: true, force: true });
    // 只有真的保存过登录状态,才算"已登录"
    if (session.saved || fs.existsSync(this.storage.authStatePath(projectId))) {
      try {
        this.repo.updateProject(projectId, { loginSetAt: now() });
      } catch {
        /* 项目已被删除 */
      }
    }
  }

  /** 使用者点了"我已登录":保存最终的登录状态,并关闭登录窗口 */
  async finish(project: Project): Promise<LoginState> {
    const session = this.sessions.get(project.id);
    if (!session) throw new ConflictError('登录窗口没有打开');
    if (!session.browser) await sleep(1000); // 刚打开,调试连接可能还没建立好
    const saved = await this.snapshot(project, session);

    // connectOverCDP 的 close() 只是断开连接,不会关掉浏览器本身,所以要通过调试协议让 Chrome 自己退出
    try {
      const cdp = await session.browser?.newBrowserCDPSession();
      await cdp?.send('Browser.close');
    } catch {
      /* 浏览器可能已经退出 */
    }
    await session.browser?.close().catch(() => {});
    const exited = await Promise.race([session.exited.then(() => true), sleep(4000).then(() => false)]);
    if (!exited) session.child.kill();
    this.cleanup(project.id, session);

    if (!saved && !session.saved) {
      throw new Error('没有在登录窗口里检测到登录状态(没有 Cookie)。请确认已经登录成功,再点“我已登录”');
    }
    return this.state(this.repo.getProject(project.id));
  }

  /** 清除登录状态:删除保存的 Cookie */
  clear(projectId: number): void {
    if (this.isOpen(projectId)) throw new ConflictError('登录窗口还开着,请先点“我已登录”或关闭它');
    this.storage.removeAuth(projectId);
    this.repo.updateProject(projectId, { loginSetAt: null });
  }

  /** 服务关闭时结束还开着的登录窗口,避免留下带调试端口的孤儿进程 */
  forget(): void {
    for (const [projectId, session] of [...this.sessions]) {
      session.child.kill();
      this.cleanup(projectId, session);
    }
  }
}
