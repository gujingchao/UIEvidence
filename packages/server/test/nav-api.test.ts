import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { startFixtures, type FixtureServer } from '@uievidence/fixtures';
import type { BulkAddResult, Capture, DiscoveryResult, LoginState, Page, Project } from '@uievidence/shared';
import { createApp, type AppContext } from '../src/app.js';
import { detectBrowser } from '../src/browser.js';

const browser = await detectBrowser(true);

async function makeApp(options: Parameters<typeof createApp>[0] extends infer T ? Partial<T> : never = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uiev-nav-'));
  const ctx = await createApp({ dataDir: dir, ...options });
  const call = async <T = any>(method: string, url: string, body?: unknown) => {
    const res = await ctx.app.inject({ method: method as any, url, payload: body as any });
    let json: T | undefined;
    try {
      json = JSON.parse(res.body) as T;
    } catch {
      /* 无响应体 */
    }
    return { status: res.statusCode, json: json as T };
  };
  const dispose = async () => {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ctx, call, dir, dispose };
}

describe.skipIf(!browser.found)('页面发现与批量加入', () => {
  let fx: FixtureServer;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let project: Project;

  beforeAll(async () => {
    fx = await startFixtures();
    app = await makeApp();
    project = (await app.call<Project>('POST', '/api/projects', { name: '发现', authorization: '自建', allowedDomains: ['127.0.0.1'] })).json;
  });
  afterAll(async () => {
    await app.dispose();
    await fx.close();
  });

  it('只给一个入口页,采集后能发现站内的其他页面', async () => {
    const home = (await app.call<Page>('POST', `/api/projects/${project.id}/pages`, { url: `${fx.url}/` })).json;
    expect((await app.call<DiscoveryResult>('GET', `/api/projects/${project.id}/discovered`)).json.links).toEqual([]); // 还没采集,什么都没发现

    await app.call<Capture>('POST', `/api/pages/${home.id}/captures`, {});
    await app.ctx.runner.idle();

    const found = (await app.call<DiscoveryResult>('GET', `/api/projects/${project.id}/discovered`)).json.links;
    const paths = found.map((f) => new URL(f.url).pathname);
    expect(paths).toEqual(expect.arrayContaining(['/courses', '/contact', '/dynamic', '/trap', '/inject', '/members', '/missing']));
    expect(paths).not.toContain('/'); // 入口页自己不算
    expect(found.every((f) => f.pageIds.includes(home.id))).toBe(true);
    // 同一个页面里重复出现的链接(导航和站点地图里都有)只算一次
    expect(found.every((f) => f.count === 1)).toBe(true);
  });

  it('批量加入:白名单外、重复、非网页、无效的网址都被跳过并说明原因', async () => {
    const r = (
      await app.call<BulkAddResult>('POST', `/api/projects/${project.id}/pages/bulk`, {
        urls: [
          `${fx.url}/courses`,
          `${fx.url}/contact#form`, // 锚点会被去掉
          `${fx.url}/courses/`, // 和已加入的 /courses 是同一个页面
          `${fx.aliasUrl}/members`, // 白名单外
          `${fx.url}/brochure.pdf`, // 文件
          'not a url',
          'javascript:alert(1)',
        ],
      })
    ).json;

    expect(r.added.map((p) => new URL(p.url).pathname + new URL(p.url).hash)).toEqual(['/courses', '/contact']);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.url, s.reason]));
    expect(reasons[`${fx.url}/courses/`]).toMatch(/已在页面清单/);
    expect(reasons[`${fx.aliasUrl}/members`]).toMatch(/白名单/);
    expect(reasons[`${fx.url}/brochure.pdf`]).toMatch(/文件/);
    expect(reasons['not a url']).toMatch(/有效的网址/);
    expect(reasons['javascript:alert(1)']).toMatch(/有效的网址/);
    expect(fx.log().filter((e) => e.host.startsWith('localhost'))).toHaveLength(0);
  });

  it('加入后,这些链接不再出现在"发现"里;再采集新页面会发现更多', async () => {
    const found = (await app.call<DiscoveryResult>('GET', `/api/projects/${project.id}/discovered`)).json.links;
    const paths = found.map((f) => new URL(f.url).pathname);
    expect(paths).not.toContain('/courses');
    expect(paths).not.toContain('/contact');
    expect(paths).not.toEqual(expect.arrayContaining(['/courses/1']));

    const courses = (await app.call<Page[]>('GET', `/api/projects/${project.id}/pages`)).json.find((p) => p.url.endsWith('/courses'))!;
    await app.call('POST', `/api/pages/${courses.id}/captures`, {});
    await app.ctx.runner.idle();
    const more = (await app.call<DiscoveryResult>('GET', `/api/projects/${project.id}/discovered`)).json.links.map((f) => new URL(f.url).pathname);
    expect(more).toEqual(expect.arrayContaining(['/courses/1', '/courses/6']));
  });
});

describe.skipIf(!browser.found)('排除会改变状态的链接', () => {
  it('退出登录、删除、支付这类链接不会被发现,也不能被批量加入', async () => {
    const fx = await startFixtures();
    const app = await makeApp();
    try {
      const project = (await app.call<Project>('POST', '/api/projects', { name: '风险链接', authorization: '自建', allowedDomains: ['127.0.0.1'] })).json;
      const trap = (await app.call<Page>('POST', `/api/projects/${project.id}/pages`, { url: `${fx.url}/trap` })).json;
      await app.call('POST', `/api/pages/${trap.id}/captures`, {});
      await app.ctx.runner.idle();

      const r = (await app.call<DiscoveryResult>('GET', `/api/projects/${project.id}/discovered`)).json;
      expect(r.links.map((l) => new URL(l.url).pathname)).not.toContain('/api/danger');
      expect(r.excluded.map((e) => e.text)).toContain('退出登录');
      expect(fx.log().some((e) => e.path === '/api/danger')).toBe(false); // 从头到尾没人访问过它
      // 描述性的链接文字(哪怕提到"删除")不会被误排除
      expect(r.excluded.map((e) => e.text)).toEqual(['退出登录']);

      const bulk = (
        await app.call<BulkAddResult>('POST', `/api/projects/${project.id}/pages/bulk`, {
          urls: [`${fx.url}/account/logout`, `${fx.url}/orders/delete/3`, `${fx.url}/members/orders`],
        })
      ).json;
      expect(bulk.added.map((p) => new URL(p.url).pathname)).toEqual(['/members/orders']);
      expect(bulk.skipped.every((s) => /改变状态/.test(s.reason))).toBe(true);
      expect(bulk.skipped).toHaveLength(2);
    } finally {
      await app.dispose();
      await fx.close();
    }
  });
});

describe('登录接口', () => {
  const fakeChild = () => Object.assign(new EventEmitter(), { kill: () => true, exitCode: null }) as unknown as ChildProcess;

  async function setup() {
    let child = fakeChild();
    const app = await makeApp({
      login: {
        spawn: () => (child = fakeChild()),
        findExe: () => 'fake-chrome',
        connect: async () =>
          ({
            contexts: () => [{ storageState: async () => ({ cookies: [{ name: 'sid', value: '1', domain: 'example.com', path: '/', expires: -1 }], origins: [] }) }],
            newBrowserCDPSession: async () => ({ send: async () => void child.emit('exit', 0) }),
            close: async () => {},
          }) as unknown as Browser,
        snapshotMs: 20,
      },
    });
    const project = (
      await app.call<Project>('POST', '/api/projects', { name: 'p', targetUrl: 'https://example.com', authorization: '自建', allowedDomains: ['example.com'] })
    ).json;
    return { app, project };
  }

  it('打开窗口 → 我已登录 → 记录登录时间 → 清除', async () => {
    const { app, project } = await setup();
    try {
      expect((await app.call<LoginState>('GET', `/api/projects/${project.id}/login`)).json).toEqual({ open: false, setAt: null });

      const started = await app.call<LoginState>('POST', `/api/projects/${project.id}/login`, {});
      expect(started.status).toBe(200);
      expect(started.json.open).toBe(true);
      expect((await app.call('POST', `/api/projects/${project.id}/login`, {})).status).toBe(409); // 不能重复打开
      expect((await app.call('DELETE', `/api/projects/${project.id}/login`)).status).toBe(409); // 窗口开着不能清除

      const finished = await app.call<LoginState>('POST', `/api/projects/${project.id}/login/finish`);
      expect(finished.status).toBe(200);
      expect(finished.json.open).toBe(false);
      expect(finished.json.setAt).not.toBeNull();
      expect((await app.call<Project>('GET', `/api/projects/${project.id}`)).json.loginSetAt).not.toBeNull();

      const cleared = await app.call<LoginState>('DELETE', `/api/projects/${project.id}/login`);
      expect(cleared.json).toEqual({ open: false, setAt: null });
    } finally {
      await app.dispose();
    }
  });

  it('没打开窗口就点"我已登录"会得到明确的错误', async () => {
    const { app, project } = await setup();
    try {
      const r = await app.call('POST', `/api/projects/${project.id}/login/finish`);
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/没有打开/);
    } finally {
      await app.dispose();
    }
  });

  it('登录窗口的网址必须在白名单内', async () => {
    const { app, project } = await setup();
    try {
      const r = await app.call('POST', `/api/projects/${project.id}/login`, { url: 'https://evil.com/login' });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/白名单/);
    } finally {
      await app.dispose();
    }
  });

  it('既没有目标网站也没有页面时,提示先补充', async () => {
    const { app } = await setup();
    try {
      const p = (await app.call<Project>('POST', '/api/projects', { name: 'q', authorization: '自建', allowedDomains: ['example.com'] })).json;
      const r = await app.call('POST', `/api/projects/${p.id}/login`, {});
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/目标网站/);
    } finally {
      await app.dispose();
    }
  });

  it('登录状态文件不会出现在导出材料里', async () => {
    const { app, project } = await setup();
    try {
      await app.call('POST', `/api/projects/${project.id}/login`, {});
      await app.call('POST', `/api/projects/${project.id}/login/finish`);
      const authFile = path.join(app.dir, 'projects', String(project.id), 'auth-state.json');
      expect(fs.existsSync(authFile)).toBe(true);

      const exp = (await app.call<{ stamp: string }>('POST', `/api/projects/${project.id}/export`)).json;
      const outDir = path.join(app.dir, 'exports', String(project.id), exp.stamp);
      const files = fs.readdirSync(outDir, { recursive: true }).map(String);
      expect(files.some((f) => /auth-state|cookie|profile/i.test(f))).toBe(false);
      for (const f of files.filter((n) => /\.(md|html)$/.test(n))) {
        expect(fs.readFileSync(path.join(outDir, f), 'utf8')).not.toContain('"sid"');
      }

      // 删除项目时,登录状态一起删除
      await app.call('DELETE', `/api/projects/${project.id}`);
      expect(fs.existsSync(authFile)).toBe(false);
    } finally {
      await app.dispose();
    }
  });
});

describe('只读 POST 放行清单的设置', () => {
  it('保存时统一成路径写法,并去重', async () => {
    const app = await makeApp();
    try {
      const p = (await app.call<Project>('POST', '/api/projects', { name: 'p', authorization: '自建', allowedDomains: ['example.com'] })).json;
      expect(p.allowedPost).toEqual([]); // 默认为空
      const r = await app.call<Project>('PATCH', `/api/projects/${p.id}`, {
        allowedPost: ['api/list', '/api/list', 'https://example.com/graphql?x=1', '  '],
      });
      expect(r.json.allowedPost).toEqual(['/api/list', '/graphql']);
    } finally {
      await app.dispose();
    }
  });
});

describe.skipIf(!browser.found)('示例项目', () => {
  it('一键创建示例项目:只有入口页,自带白名单,能直接采集并发现其他页面', async () => {
    const app = await makeApp();
    try {
      const p = (await app.call<Project>('POST', '/api/demo')).json;
      expect(p.name).toMatch(/示例/);
      expect(p.allowedDomains).toHaveLength(1);
      expect(p.allowedDomains[0]).toMatch(/^127\.0\.0\.1:\d+$/);
      const pages = (await app.call<Page[]>('GET', `/api/projects/${p.id}/pages`)).json;
      expect(pages).toHaveLength(1);

      await app.call('POST', `/api/pages/${pages[0]!.id}/captures`, {});
      await app.ctx.runner.idle();
      const cap = (await app.call<Capture[]>('GET', `/api/projects/${p.id}/captures`)).json[0]!;
      expect(cap.status).toBe('success');
      const found = (await app.call<DiscoveryResult>('GET', `/api/projects/${p.id}/discovered`)).json.links;
      expect(found.length).toBeGreaterThanOrEqual(7);

      // 再建一个示例项目,复用同一个测试站
      const p2 = (await app.call<Project>('POST', '/api/demo')).json;
      expect(p2.allowedDomains).toEqual(p.allowedDomains);
    } finally {
      await app.dispose();
    }
  });
});
