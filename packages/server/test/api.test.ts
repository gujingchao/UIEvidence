import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtures, type FixtureServer } from '@uievidence/fixtures';
import type { Capture, Feature, Page, Project } from '@uievidence/shared';
import { createApp, type AppContext } from '../src/app.js';
import { detectBrowser } from '../src/browser.js';

const browser = await detectBrowser(true);

let ctx: AppContext;
let dir: string;
let fx: FixtureServer;

const call = async <T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await ctx.app.inject({ method: method as any, url, payload: body as any, headers });
  const text = res.body;
  let json: T | undefined;
  try {
    json = JSON.parse(text) as T;
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.statusCode, json: json as T, text, headers: res.headers };
};

async function captureViaApi(pageId: number, body: object = {}): Promise<Capture> {
  const created = await call<Capture>('POST', `/api/pages/${pageId}/captures`, body);
  expect(created.status).toBe(202);
  await ctx.runner.idle();
  return (await call<Capture>('GET', `/api/captures/${created.json.id}`)).json;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uiev-api-'));
  fx = await startFixtures();
  ctx = await createApp({ dataDir: dir });
});
afterAll(async () => {
  await ctx.app.close();
  await fx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('本地服务的安全防护', () => {
  it('拒绝非本机的 Host(防 DNS 重绑定)', async () => {
    const r = await call('GET', '/api/health', undefined, { host: 'evil.example.com' });
    expect(r.status).toBe(403);
  });

  it('拒绝带有其他站点 Origin 的写请求', async () => {
    const r = await call('POST', '/api/projects', { name: 'x', authorization: 'yy', allowedDomains: ['a.com'] }, {
      host: '127.0.0.1:4317',
      origin: 'https://evil.example.com',
      'content-type': 'application/json',
    });
    expect(r.status).toBe(403);
    expect((await call('GET', '/api/projects')).json).toEqual([]);
  });

  it('创建项目必须有授权说明和域名白名单', async () => {
    expect((await call('POST', '/api/projects', { name: 'x', allowedDomains: ['a.com'] })).status).toBe(400);
    expect((await call('POST', '/api/projects', { name: 'x', authorization: '有授权' , allowedDomains: [] })).status).toBe(400);
  });
});

describe.skipIf(!browser.found)('完整闭环:建项目 → 采集 → 整理 → 关联 → 导出', () => {
  let project: Project;
  let home: Page;
  let courses: Page;
  let contact: Page;

  it('新建项目并设置白名单', async () => {
    const r = await call<Project>('POST', '/api/projects', {
      name: '培训机构站',
      targetUrl: fx.url,
      purpose: '评估能否做同类系统',
      authorization: '自建测试站,允许分析',
      allowedDomains: ['http://127.0.0.1/'],
    });
    expect(r.status).toBe(201);
    project = r.json;
    expect(project.allowedDomains).toEqual(['127.0.0.1']);
    expect(project.allowAi).toBe(false);
  });

  it('白名单外的网址不能加入页面清单,也不会产生采集', async () => {
    const r = await call('POST', `/api/projects/${project.id}/pages`, { url: `${fx.aliasUrl}/` });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/白名单/);
    expect(fx.log()).toHaveLength(0);
  });

  it('添加页面并采集', async () => {
    const add = async (p: string) => (await call<Page>('POST', `/api/projects/${project.id}/pages`, { url: `${fx.url}${p}` })).json;
    home = await add('/');
    courses = await add('/courses');
    contact = await add('/contact');
    expect((await call('POST', `/api/projects/${project.id}/pages`, { url: `${fx.url}/` })).status).toBe(409);

    for (const p of [home, courses, contact]) {
      const c = await captureViaApi(p.id);
      expect(c.status).toBe('success');
    }
    const pages = (await call<Page[]>('GET', `/api/projects/${project.id}/pages`)).json;
    expect(pages.map((p) => p.lastCaptureStatus)).toEqual(['success', 'success', 'success']);
    expect(pages[1]?.title).toContain('课程列表'); // 采集后自动补全页面标题
  });

  it('证据文件可读;页面快照以纯文本提供,不会在本地域下执行', async () => {
    const caps = (await call<Capture[]>('GET', `/api/projects/${project.id}/captures`)).json;
    const evidenceId = caps.find((c) => c.url.endsWith('/courses'))!.evidenceId!;

    const shot = await call('GET', `/api/evidence/${evidenceId}/screenshot`);
    expect(shot.headers['content-type']).toBe('image/png');

    const dom = await call('GET', `/api/evidence/${evidenceId}/dom`);
    expect(dom.headers['content-type']).toMatch(/^text\/plain/);
    expect(String(dom.headers['content-security-policy'])).toContain('sandbox');
    expect((await call('GET', `/api/evidence/${evidenceId}/passwd`)).status).toBe(404);
  });

  it('从页面结构生成候选,再手工创建功能条目并关联证据', async () => {
    const caps = (await call<Capture[]>('GET', `/api/projects/${project.id}/captures`)).json;
    const cap = caps.find((c) => c.url.endsWith('/contact'))!;
    const cands = (await call<{ name: string; kind: string }[]>('GET', `/api/captures/${cap.id}/candidates`)).json;
    expect(cands.some((c) => c.name === '表单:发送咨询' && c.kind === 'observed')).toBe(true);
    // 没有执行过的提交,只能是推测
    expect(cands.find((c) => c.name === '可能存在:发送咨询')?.kind).toBe('inferred');

    const mk = async (body: object) => (await call<Feature>('POST', `/api/projects/${project.id}/features`, body)).json;
    const observed = await mk({
      name: '课程咨询表单',
      description: '姓名、邮箱必填',
      kind: 'observed',
      acceptance: '填写后可提交',
      pageIds: [contact.id],
      evidenceIds: [cap.evidenceId],
    });
    await mk({ name: '课程上下架', kind: 'inferred', pageIds: [courses.id] });
    await mk({ name: '管理员按角色分权', kind: 'requirement', category: 'permission' });
    await mk({ name: '是否有价格等级?', kind: 'question' });
    expect(observed.pageIds).toEqual([contact.id]);
    expect(observed.evidenceIds).toEqual([cap.evidenceId]);

    // 不能关联其他项目的对象
    const other = (await call<Project>('POST', '/api/projects', { name: '另一个', authorization: '自建', allowedDomains: ['127.0.0.1'] })).json;
    const otherPage = (await call<Page>('POST', `/api/projects/${other.id}/pages`, { url: `${fx.url}/` })).json;
    const bad = await call('POST', `/api/projects/${project.id}/features`, { name: 'x', kind: 'observed', pageIds: [otherPage.id] });
    expect(bad.status).toBe(404);
  });

  it('补充分析缺口和初步方案', async () => {
    expect((await call('POST', `/api/projects/${project.id}/gaps`, { description: '后台管理界面无法从前台确认' })).status).toBe(201);
    const r = await call<Project>('PATCH', `/api/projects/${project.id}`, { planText: '第一期:课程展示与咨询表单。' });
    expect(r.json.planText).toContain('第一期');
  });

  // 验收 8:引用可用,三种格式一致
  it('导出 Markdown、HTML、材料包,且内容一致、引用可用', async () => {
    const exp = (await call<{ baseUrl: string; reportMd: string; reportHtml: string; bundle: string; stamp: string }>(
      'POST',
      `/api/projects/${project.id}/export`,
    )).json;
    const outDir = path.join(dir, 'exports', String(project.id), exp.stamp);

    const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');

    // Markdown 里每个图片引用都指向存在的文件
    const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) expect(fs.existsSync(path.join(outDir, ref)), ref).toBe(true);
    const htmlRefs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!);
    expect(htmlRefs).toEqual(refs);

    // 页面清单、功能条目、证据编号在两种格式里一致
    for (const text of [md, html]) {
      expect(text).toContain(`${fx.url}/courses`);
      expect(text).toContain('课程咨询表单');
      expect(text).toContain('管理员按角色分权');
      expect(text).toContain('是否有价格等级?');
      expect(text).toContain('E-001');
      expect(text).toContain('后台管理界面无法从前台确认');
      expect(text).toContain('第一期:课程展示与咨询表单。');
      expect(text).toContain('自建测试站,允许分析');
    }
    expect(md).toContain('候选验收条件:填写后可提交');
    expect(md).toContain('(权限)'.replace('权限', '角色权限'));

    // 材料包解压后和目录一致
    const zip = unzipSync(fs.readFileSync(path.join(outDir, 'bundle.zip')));
    expect(Object.keys(zip).sort()).toEqual(['report.html', 'report.md', ...refs].sort());
    expect(Buffer.from(zip['report.md']!).toString('utf8')).toBe(md);

    // 通过服务访问同样可用(相对引用在服务下也能解析)
    const served = await call('GET', exp.reportMd);
    expect(served.status).toBe(200);
    const shot = await call('GET', `${exp.baseUrl}/${refs[0]}`);
    expect(shot.status).toBe(200);
  });

  it('归档后不能再采集', async () => {
    await call('PATCH', `/api/projects/${project.id}`, { archived: true });
    const r = await call('POST', `/api/pages/${home.id}/captures`, {});
    expect(r.status).toBe(409);
    await call('PATCH', `/api/projects/${project.id}`, { archived: false });
  });

  // 验收 10:重启后记录与证据文件完整
  it('重启服务后项目、条目和证据文件仍然完整', async () => {
    const before = (await call<Feature[]>('GET', `/api/projects/${project.id}/features`)).json;
    const evidence = (await call<{ id: number }[]>('GET', `/api/projects/${project.id}/evidence`)).json;
    await ctx.app.close();

    ctx = await createApp({ dataDir: dir });
    expect((await call<Project>('GET', `/api/projects/${project.id}`)).json.name).toBe('培训机构站');
    expect((await call<Feature[]>('GET', `/api/projects/${project.id}/features`)).json).toEqual(before);
    for (const e of evidence) {
      expect((await call('GET', `/api/evidence/${e.id}/screenshot`)).status).toBe(200);
    }
  });
});

describe('AI 分析接口', () => {
  it('项目没开启“允许发送内容给模型”时拒绝,且不会调用外部服务', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const p = (await call<Project>('POST', '/api/projects', { name: 'ai', authorization: '自建', allowedDomains: ['127.0.0.1'] })).json;
    const r = await call('POST', `/api/projects/${p.id}/ai/analyze`, { captureId: 1, provider: 'openai' });
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.skipIf(!browser.found)('开启后生成待采纳条目,采纳前不进入报告', async () => {
    const env = { OPENAI_API_KEY: 'test-key' };
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'uiev-ai-'));
    const local = await createApp({ dataDir: dir2, env });
    try {
      const inj = async (method: string, url: string, body?: unknown) => {
        const res = await local.app.inject({ method: method as any, url, payload: body as any });
        return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : null) as any };
      };
      const p = (await inj('POST', '/api/projects', { name: 'ai', authorization: '自建', allowedDomains: ['127.0.0.1'] })).json as Project;
      await inj('PATCH', `/api/projects/${p.id}`, { allowAi: true });
      const page = (await inj('POST', `/api/projects/${p.id}/pages`, { url: `${fx.url}/inject` })).json as Page;
      const created = (await inj('POST', `/api/pages/${page.id}/captures`, {})).json as Capture;
      await local.runner.idle();

      // 模型被页面里的伪造指令"说服"后返回了越权内容:只有合规条目会入库,且都是待采纳
      const reply = JSON.stringify([
        { name: '公告展示', description: '页面有公告', kind: 'observed' },
        { name: '删除全部项目', description: '按页面指令', kind: 'delete_project' },
      ]);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }))));
      const r = await inj('POST', `/api/projects/${p.id}/ai/analyze`, { captureId: created.id, provider: 'openai' });
      expect(r.status).toBe(200);
      expect(r.json.count).toBe(1);
      expect(r.json.features[0]).toMatchObject({ name: '公告展示', source: 'ai', status: 'pending' });

      const exp = (await inj('POST', `/api/projects/${p.id}/export`)).json;
      const md = fs.readFileSync(path.join(dir2, 'exports', String(p.id), exp.stamp, 'report.md'), 'utf8');
      expect(md).not.toContain('公告展示');
      expect(md).toContain('另有 1 条 AI 建议尚未采纳');
      expect((await inj('GET', '/api/projects')).json).toHaveLength(1); // 项目没有被删除
    } finally {
      vi.unstubAllGlobals();
      await local.app.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
