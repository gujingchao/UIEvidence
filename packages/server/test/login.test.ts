import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { startFixtures, type FixtureServer } from '@uievidence/fixtures';
import { detectLoginWall } from '../src/auth.js';
import { detectBrowser, findBrowserExecutable } from '../src/browser.js';
import { now } from '../src/db.js';
import { connectOverCdp, LoginManager } from '../src/login.js';
import { isPostAllowed, normalizePostPatterns } from '../src/scope.js';
import { captureUrl, makeEnv, makeProject, readStructure, type TestEnv } from './helpers.js';

const browser = await detectBrowser(true);

describe('登录墙识别', () => {
  const base = { requested: 'http://x/members', finalUrl: 'http://x/members', httpStatus: 200 };
  const withPassword = {
    title: '',
    lang: '',
    headings: [],
    nav: [],
    links: [],
    forms: [{ action: '', method: 'post', submitText: '登录', fields: [{ name: 'p', type: 'password', label: '', required: true, placeholder: '' }] }],
    lists: [],
    dialogs: [],
    interactions: [],
    blocked: [],
  };

  it('401 一定是需要登录', () => {
    expect(detectLoginWall({ ...base, httpStatus: 401, structure: null })?.reason).toMatch(/401/);
  });

  it('被跳转到带密码框的页面,是需要登录', () => {
    const wall = detectLoginWall({ ...base, finalUrl: 'http://x/login?next=/members', structure: withPassword });
    expect(wall?.reason).toMatch(/跳转到了登录页\(\/login\)/);
  });

  it('使用者故意加入的登录页本身,不算被挡住', () => {
    expect(detectLoginWall({ requested: 'http://x/login', finalUrl: 'http://x/login', httpStatus: 200, structure: withPassword })).toBeNull();
  });

  it('只是尾部斜杠的差别,不算跳转', () => {
    expect(detectLoginWall({ requested: 'http://x/a', finalUrl: 'http://x/a/', httpStatus: 200, structure: withPassword })).toBeNull();
  });

  it('跳转了但页面没有密码框,不能断定是登录页', () => {
    expect(detectLoginWall({ ...base, finalUrl: 'http://x/home', structure: { ...withPassword, forms: [] } })).toBeNull();
  });
});

describe('只读 POST 放行清单', () => {
  it('只放行清单里的 POST,其他方法永远不放行', () => {
    const list = normalizePostPatterns(['/api/orders', 'graphql/*', 'http://x.com/search?q=1']);
    expect(list).toEqual(['/api/orders', '/graphql/*', '/search']);
    expect(isPostAllowed('POST', 'http://x/api/orders', list)).toBe(true);
    expect(isPostAllowed('POST', 'http://x/api/orders/1', list)).toBe(false);
    expect(isPostAllowed('POST', 'http://x/graphql/query', list)).toBe(true);
    expect(isPostAllowed('PUT', 'http://x/api/orders', list)).toBe(false);
    expect(isPostAllowed('DELETE', 'http://x/api/orders', list)).toBe(false);
    expect(isPostAllowed('POST', 'http://x/api/delete', list)).toBe(false);
  });
});

describe('登录窗口(不启动真实浏览器)', () => {
  const fakeChild = () => Object.assign(new EventEmitter(), { kill: () => true, exitCode: null }) as unknown as ChildProcess;

  /** 假的调试连接:返回预设的登录状态 */
  function fakeBrowser(state: { cookies: unknown[]; origins: unknown[] }, onClose: () => void): Browser {
    return {
      contexts: () => [{ storageState: async () => state }],
      newBrowserCDPSession: async () => ({ send: async () => onClose() }),
      close: async () => {},
    } as unknown as Browser;
  }

  function setup(state = { cookies: [{ name: 'sid', value: 'v', domain: 'example.com', path: '/', expires: -1 }], origins: [] as unknown[] }) {
    const env = makeEnv();
    const calls: { cmd: string; args: string[] }[] = [];
    let child = fakeChild();
    const manager = new LoginManager(env.repo, env.storage, {
      spawn: (cmd, args) => {
        calls.push({ cmd, args });
        child = fakeChild();
        return child;
      },
      findExe: () => 'C:\\fake\\chrome.exe',
      connect: async () => fakeBrowser(state, () => child.emit('exit', 0)),
      snapshotMs: 20,
    });
    const project = makeProject(env, ['example.com']);
    return { env, manager, project, calls, child: () => child };
  }

  it('用独立的临时目录和调试端口启动窗口', async () => {
    const { env, manager, project, calls } = setup();
    try {
      await manager.start(project, 'https://example.com/login');
      expect(manager.isOpen(project.id)).toBe(true);
      const { cmd, args } = calls[0]!;
      expect(cmd).toBe('C:\\fake\\chrome.exe');
      expect(args).toContain(`--user-data-dir=${env.storage.loginWindowDir(project.id)}`);
      expect(args.some((a) => /^--remote-debugging-port=\d+$/.test(a))).toBe(true);
      expect(args.at(-1)).toBe('https://example.com/login');
      expect(env.repo.getProject(project.id).loginSetAt).toBeNull();
      await manager.finish(env.repo.getProject(project.id));
    } finally {
      env.cleanup();
    }
  });

  it('点"我已登录":保存登录状态、关闭窗口、记录时间,并清理临时目录', async () => {
    const { env, manager, project } = setup();
    try {
      await manager.start(project, 'https://example.com/');
      const state = await manager.finish(env.repo.getProject(project.id));
      expect(state.open).toBe(false);
      expect(state.setAt).not.toBeNull();
      expect(manager.isOpen(project.id)).toBe(false);

      const saved = JSON.parse(fs.readFileSync(env.storage.authStatePath(project.id), 'utf8'));
      expect(saved.cookies[0].name).toBe('sid');
      expect(fs.existsSync(env.storage.loginWindowDir(project.id))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('只保存白名单域名下的 Cookie 和本地存储', async () => {
    const { env, manager, project } = setup({
      cookies: [
        { name: 'keep', value: '1', domain: '.example.com', path: '/', expires: -1 },
        { name: 'drop', value: '2', domain: 'tracker.other.com', path: '/', expires: -1 },
      ],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'token', value: 't' }] },
        { origin: 'https://other.com', localStorage: [{ name: 'x', value: 'y' }] },
      ],
    });
    try {
      await manager.start(project, 'https://example.com/');
      await manager.finish(env.repo.getProject(project.id));
      const saved = JSON.parse(fs.readFileSync(env.storage.authStatePath(project.id), 'utf8'));
      expect(saved.cookies.map((c: { name: string }) => c.name)).toEqual(['keep']);
      expect(saved.origins.map((o: { origin: string }) => o.origin)).toEqual(['https://example.com']);
    } finally {
      env.cleanup();
    }
  });

  it('使用者直接关掉窗口,已自动保存的登录状态不丢', async () => {
    const { env, manager, project, child } = setup();
    try {
      await manager.start(project, 'https://example.com/');
      await new Promise((r) => setTimeout(r, 200)); // 等自动保存跑几轮
      child().emit('exit', 0);
      await new Promise((r) => setTimeout(r, 20));
      expect(manager.isOpen(project.id)).toBe(false);
      expect(fs.existsSync(env.storage.authStatePath(project.id))).toBe(true);
      expect(env.repo.getProject(project.id).loginSetAt).not.toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('窗口里没有登录状态时,提示使用者确认登录成功', async () => {
    const { env, manager, project } = setup({ cookies: [], origins: [] });
    try {
      await manager.start(project, 'https://example.com/');
      await expect(manager.finish(env.repo.getProject(project.id))).rejects.toThrow(/没有在登录窗口里检测到登录状态/);
      expect(env.repo.getProject(project.id).loginSetAt).toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('窗口开着时不能重复打开,也不能清除', async () => {
    const { env, manager, project } = setup();
    try {
      await manager.start(project, 'https://example.com/');
      await expect(manager.start(project, 'https://example.com/')).rejects.toThrow(/已经打开/);
      expect(() => manager.clear(project.id)).toThrow(/还开着/);
      await manager.finish(env.repo.getProject(project.id));
    } finally {
      env.cleanup();
    }
  });

  it('起始网址必须在白名单内,且只接受 http(s);失败时不启动任何进程', async () => {
    const { env, manager, project, calls } = setup();
    try {
      await expect(manager.start(project, 'https://evil.com/')).rejects.toThrow(/白名单/);
      await expect(manager.start(project, 'file:///etc/passwd')).rejects.toThrow();
      await expect(manager.start(project, '--remote-debugging-port=1')).rejects.toThrow();
      expect(calls).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  it('找不到浏览器时给出明确提示', async () => {
    const env = makeEnv();
    try {
      const manager = new LoginManager(env.repo, env.storage, { spawn: () => fakeChild(), findExe: () => null });
      const project = makeProject(env, ['example.com']);
      await expect(manager.start(project, 'https://example.com/')).rejects.toThrow(/找不到 Chrome/);
    } finally {
      env.cleanup();
    }
  });

  it('清除登录状态会删除保存的文件', async () => {
    const { env, manager, project } = setup();
    try {
      await manager.start(project, 'https://example.com/');
      await manager.finish(env.repo.getProject(project.id));
      manager.clear(project.id);
      expect(fs.existsSync(env.storage.authStatePath(project.id))).toBe(false);
      expect(env.repo.getProject(project.id).loginSetAt).toBeNull();
    } finally {
      env.cleanup();
    }
  });
});

const hasChrome = browser.found && !!findBrowserExecutable();

describe.skipIf(!hasChrome)('登录后的采集(真实 Chrome + 测试站的登录页,登录状态为会话 Cookie)', () => {
  let fx: FixtureServer;
  let env: TestEnv;

  beforeAll(async () => {
    fx = await startFixtures();
  });
  afterAll(async () => {
    await fx.close();
  });
  beforeEach(() => {
    env?.cleanup();
    env = makeEnv();
    fx.reset();
  });
  afterAll(() => env?.cleanup());

  /**
   * 走真实的登录窗口流程:真的启动一个(无界面的)Chrome 进程,
   * 通过调试连接在里面登录,然后调用 finish,和使用者点"我已登录"一样。
   */
  async function userLogsIn(projectId: number): Promise<void> {
    let handle: Browser | null = null;
    const manager = new LoginManager(env.repo, env.storage, {
      extraArgs: ['--headless=new'],
      snapshotMs: 300,
      connect: async (port) => {
        handle = await connectOverCdp(port);
        return handle;
      },
    });
    const project = env.repo.getProject(projectId);
    await manager.start(project, `${fx.url}/login`);
    for (let i = 0; i < 100 && !handle; i++) await new Promise((r) => setTimeout(r, 100));
    const ctx = (handle as unknown as Browser).contexts()[0]!;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.waitForURL('**/login');
    await page.fill('input[name=user]', 'demo');
    await page.fill('input[name=pass]', 'demo123');
    await page.click('button[type=submit]');
    await page.waitForURL('**/members');
    await manager.finish(env.repo.getProject(projectId));
    expect(manager.isOpen(projectId)).toBe(false);
  }

  it('没有登录状态时,受保护的页面被识别为"需要登录",并指引去登录', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/members`);
    expect(c.status).toBe('login_required');
    expect(c.error).toMatch(/跳转到了登录页/);
    expect(c.error).toMatch(/点“登录”/);
    expect(c.finalUrl).toContain('/login');
    expect(c.evidenceId).not.toBeNull(); // 登录页的截图留作证据
    expect(env.repo.listGaps(project.id).some((g) => g.type === 'auth_required')).toBe(true);
    expect(env.repo.listPages(project.id)[0]?.lastCaptureStatus).toBe('login_required');
  });

  it('401 页面被识别为需要登录', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/private`);
    expect(c.status).toBe('login_required');
    expect(c.error).toMatch(/401/);
  });

  it('登录后重新采集成功,之前"需要登录"的缺口自动标为已解决', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    expect((await captureUrl(env, project, `${fx.url}/members`)).status).toBe('login_required');
    const before = env.repo.listGaps(project.id).filter((g) => g.type === 'auth_required');
    expect(before).toHaveLength(1);
    expect(before[0]!.resolved).toBe(false);

    await userLogsIn(project.id);
    expect((await captureUrl(env, project, `${fx.url}/members`)).status).toBe('success');
    expect(env.repo.listGaps(project.id).filter((g) => g.type === 'auth_required').every((g) => g.resolved)).toBe(true);
    // 历史采集记录还在,只是缺口不再挂着
    expect(env.repo.listCaptures(project.id).map((c) => c.status).sort()).toEqual(['login_required', 'success']);
  });

  it('使用者在窗口里登录后,会话 Cookie 被保存下来,采集能拿到登录后的内容', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    await userLogsIn(project.id);

    const saved = JSON.parse(fs.readFileSync(env.storage.authStatePath(project.id), 'utf8'));
    expect(saved.cookies.map((c: { name: string }) => c.name)).toContain('sid');
    expect(fs.existsSync(env.storage.loginWindowDir(project.id))).toBe(false);

    const c = await captureUrl(env, project, `${fx.url}/members/orders`);
    expect(c.status).toBe('success');
    expect(c.finalUrl).toContain('/members/orders');
    expect(readStructure(env, c).lists.some((l) => l.kind === 'table' && l.itemCount >= 3)).toBe(true);
  });

  it('登录状态只属于创建它的项目', async () => {
    const a = makeProject(env, ['127.0.0.1']);
    const b = makeProject(env, ['127.0.0.1']);
    await userLogsIn(a.id);
    expect((await captureUrl(env, a, `${fx.url}/members`)).status).toBe('success');
    expect((await captureUrl(env, b, `${fx.url}/members`)).status).toBe('login_required');
  });

  it('清除登录状态后,再采集又会被挡在登录页外', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    await userLogsIn(project.id);
    const { LoginManager: LM } = await import('../src/login.js');
    new LM(env.repo, env.storage).clear(project.id);
    expect((await captureUrl(env, project, `${fx.url}/members`)).status).toBe('login_required');
  });

  it('登录状态过期(服务端不认了)时,提示重新登录而不是"先登录"', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    // 有登录记录,但 Cookie 已经无效
    fs.mkdirSync(env.dir + `/projects/${project.id}`, { recursive: true });
    fs.writeFileSync(
      env.storage.authStatePath(project.id),
      JSON.stringify({ cookies: [{ name: 'sid', value: 'expired', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }),
    );
    env.repo.updateProject(project.id, { loginSetAt: now() });
    const c = await captureUrl(env, project, `${fx.url}/members`);
    expect(c.status).toBe('login_required');
    expect(c.error).toMatch(/已过期/);
  });

  it('用 POST 读数据的页面:默认被拦截并记入缺口,放行该接口后能读到数据', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    await userLogsIn(project.id);
    fx.reset();

    const blocked = await captureUrl(env, project, `${fx.url}/members-spa`);
    expect(readStructure(env, blocked).lists.filter((l) => l.kind === 'table')).toHaveLength(0);
    const gap = env.repo.listGaps(project.id).find((g) => g.type === 'request_blocked');
    expect(gap?.meta).toEqual({ method: 'POST', path: '/api/orders' });
    expect(fx.writes().filter((w) => w.path === '/api/orders')).toHaveLength(0);

    env.repo.updateProject(project.id, { allowedPost: ['/api/orders'] });
    const ok = await captureUrl(env, project, `${fx.url}/members-spa`);
    const tables = readStructure(env, ok).lists.filter((l) => l.kind === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0]!.itemCount).toBeGreaterThanOrEqual(3);
    // 只放行了读订单的接口,其他写入请求仍然被拦截
    expect(fx.writes().map((w) => w.path)).toEqual(['/api/orders']);
  });

  it('放行清单不会放行其他路径的 POST', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    env.repo.updateProject(project.id, { allowedPost: ['/api/orders'] });
    await captureUrl(env, project, `${fx.url}/trap`);
    expect(fx.writes()).toEqual([]);
  });
});
