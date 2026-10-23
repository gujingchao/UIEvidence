import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtures, type FixtureServer } from '@uievidence/fixtures';
import { detectBrowser } from '../src/browser.js';
import { captureUrl, makeEnv, makeProject, readStructure, type TestEnv } from './helpers.js';

const browser = await detectBrowser(true);

describe.skipIf(!browser.found)('页面采集(本机 Chrome + 受控测试站)', () => {
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

  // 验收 1:截图、网址、视口、时间记录正确
  it('采集普通页面并保存截图、结构和采集上下文', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/courses`);

    expect(c.status).toBe('success');
    expect(c.url).toBe(`${fx.url}/courses`);
    expect(c.viewport).toEqual({ width: 1280, height: 800 });
    expect(c.pageTitle).toContain('课程列表');
    expect(c.httpStatus).toBe(200);
    expect(c.browser).toMatch(/chrome|msedge|custom/);
    expect(Date.parse(c.startedAt)).not.toBeNaN();
    expect(Date.parse(c.finishedAt as string)).toBeGreaterThanOrEqual(Date.parse(c.startedAt));
    expect(c.evidenceCode).toBe('E-001');

    const shot = env.repo.evidenceFilePath(c.evidenceId as number, 'screenshot') as string;
    const png = env.storage.read(shot);
    expect(png.subarray(1, 4).toString()).toBe('PNG');

    const dom = env.repo.evidenceFilePath(c.evidenceId as number, 'dom') as string;
    expect(env.storage.read(dom).toString('utf8')).toContain('课程列表');

    const s = readStructure(env, c);
    expect(s.nav.map((n) => n.text)).toEqual(expect.arrayContaining(['首页', '课程', '联系我们']));
    // 分页链接不算站点导航
    expect(s.nav.map((n) => n.text)).not.toContain('下一页');
    expect(s.lists.some((l) => l.kind === 'list' && l.itemCount === 6)).toBe(true);
    expect(s.interactions.map((i) => i.type).sort()).toEqual(['pagination', 'pagination', 'tab', 'tab']);
  });

  it('提取表单字段、必填和标签', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const s = readStructure(env, await captureUrl(env, project, `${fx.url}/contact`));
    expect(s.forms).toHaveLength(1);
    const form = s.forms[0]!;
    expect(form.method).toBe('post');
    expect(form.submitText).toBe('发送咨询');
    expect(form.fields.map((f) => [f.label, f.type, f.required])).toEqual([
      ['姓名', 'text', true],
      ['邮箱', 'email', true],
      ['咨询内容', 'textarea', false],
    ]);
    // 表单提交按钮只记录,不执行
    expect(s.blocked.some((b) => b.text === '发送咨询')).toBe(true);
    expect(fx.writes()).toHaveLength(0);
  });

  it('等待动态加载的内容,并触发懒加载', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/dynamic`);
    expect(c.status).toBe('success');
    const s = readStructure(env, c);
    expect(s.lists.some((l) => l.itemCount === 6)).toBe(true);
    expect(s.interactions.some((i) => i.type === 'modal')).toBe(true);
    expect(fx.log().some((e) => e.path === '/lazy.png')).toBe(true);
  });

  // 验收 2:多次采集分别保存,旧证据不被覆盖
  it('同一页面多次采集各自保存', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const url = `${fx.url}/`;
    const first = await captureUrl(env, project, url);
    const firstShot = env.repo.evidenceFilePath(first.evidenceId as number, 'screenshot') as string;
    const firstBytes = env.storage.read(firstShot);

    const second = await captureUrl(env, project, url);
    const secondShot = env.repo.evidenceFilePath(second.evidenceId as number, 'screenshot') as string;

    expect(second.id).not.toBe(first.id);
    expect(second.evidenceCode).toBe('E-002');
    expect(secondShot).not.toBe(firstShot);
    expect(env.storage.read(firstShot).equals(firstBytes)).toBe(true);
    expect(env.repo.listCaptures(project.id)).toHaveLength(2);
    expect(env.repo.listPages(project.id)[0]?.captureCount).toBe(2);
  });

  // 验收 3:白名单外的网址被拒绝,且不发出请求
  it('入口网址不在白名单内时拒绝采集,目标不收到任何请求', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.aliasUrl}/`);
    expect(c.status).toBe('failed');
    expect(c.error).toMatch(/白名单/);
    expect(fx.log()).toHaveLength(0);
    expect(c.evidenceId).toBeNull();
    expect(env.repo.listGaps(project.id).some((g) => g.type === 'out_of_scope')).toBe(true);
  });

  it('页面引用的白名单外资源不会被请求', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/inject`);
    expect(['success', 'partial']).toContain(c.status);
    expect(fx.log().filter((e) => e.host.startsWith('localhost'))).toHaveLength(0);
    expect(c.notes.join(' ')).toMatch(/白名单外/);
    expect(env.repo.listGaps(project.id).some((g) => g.type === 'out_of_scope')).toBe(true);
  });

  // 验收 4:不触发写操作
  it('带副作用按钮的页面:不点击、不发出任何写入请求', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/trap`);
    expect(c.status).not.toBe('failed');

    expect(fx.writes()).toEqual([]);
    expect(fx.log().some((e) => e.path === '/api/danger')).toBe(false);

    const s = readStructure(env, c);
    const blocked = s.blocked.map((b) => b.text);
    expect(blocked).toEqual(expect.arrayContaining(['删除全部数据', '提交订单', '立即支付', '神秘按钮']));
    expect(s.interactions).toHaveLength(0);

    const gaps = env.repo.listGaps(project.id);
    expect(gaps.filter((g) => g.type === 'interaction_skipped').length).toBeGreaterThanOrEqual(4);
    expect(gaps.some((g) => g.type === 'request_blocked')).toBe(true);
  });

  it('重复采集不重复生成相同的缺口', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    await captureUrl(env, project, `${fx.url}/trap`);
    const n = env.repo.listGaps(project.id).length;
    await captureUrl(env, project, `${fx.url}/trap`);
    expect(env.repo.listGaps(project.id)).toHaveLength(n);
  });

  // 验收 6:失败有明确提示,已有内容不受影响
  it('404 页面标记为失败,但保留错误页证据', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const ok = await captureUrl(env, project, `${fx.url}/`);
    const c = await captureUrl(env, project, `${fx.url}/missing`);
    expect(c.status).toBe('failed');
    expect(c.error).toBe('HTTP 404');
    expect(c.evidenceId).not.toBeNull();
    expect(env.repo.getCapture(ok.id).status).toBe('success');
  });

  it('加载超时给出明确提示', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/slow`, { timeoutMs: 1500 });
    expect(c.status).toBe('failed');
    expect(c.error).toMatch(/超时/);
    expect(c.evidenceId).toBeNull();
    expect(env.repo.listProjects()).toHaveLength(1);
  });

  it('目标无法连接时给出明确提示', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    // 取一个刚释放的空闲端口,保证没有服务在监听
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const freePort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const c = await captureUrl(env, project, `http://127.0.0.1:${freePort}/`);
    expect(c.status).toBe('failed');
    expect(c.error).toMatch(/连接被拒绝/);
  });

  it('等待指定元素失败时标记为部分成功', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const c = await captureUrl(env, project, `${fx.url}/`, { timeoutMs: 1500, waitSelector: '#not-exist' });
    expect(c.status).toBe('partial');
    expect(c.notes.join(' ')).toMatch(/没有等到指定元素/);
    expect(c.evidenceId).not.toBeNull();
  });

  // 受限交互:每个状态各存一次采集
  it('执行分页交互并保存为独立采集', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const base = await captureUrl(env, project, `${fx.url}/courses`);
    const next = readStructure(env, base).interactions.find((i) => i.type === 'pagination' && i.text === '下一页')!;

    const c = await captureUrl(env, project, `${fx.url}/courses`, {
      interaction: { type: next.type, selector: next.selector },
    });
    expect(c.status).toBe('success');
    expect(c.stateLabel).toBe('分页:下一页');
    expect(c.finalUrl).toContain('page=2');
    expect(c.evidenceCode).toBe('E-002');
  });

  it('执行弹窗展开交互,快照里能看到弹窗', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const base = await captureUrl(env, project, `${fx.url}/dynamic`);
    const modal = readStructure(env, base).interactions.find((i) => i.type === 'modal')!;
    const c = await captureUrl(env, project, `${fx.url}/dynamic`, { interaction: { type: 'modal', selector: modal.selector } });
    expect(c.status).toBe('success');
    const dom = env.storage.read(env.repo.evidenceFilePath(c.evidenceId as number, 'dom') as string).toString('utf8');
    expect(dom).toMatch(/class="modal open"/);
  });

  it('拒绝执行不在允许范围内的交互', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    await captureUrl(env, project, `${fx.url}/trap`);
    fx.reset();
    const c = await captureUrl(env, project, `${fx.url}/trap`, {
      interaction: { type: 'modal', selector: 'html > body:nth-of-type(1) > main:nth-of-type(1) > button:nth-of-type(1)' },
    });
    expect(c.status).toBe('failed');
    expect(c.error).toMatch(/不在允许的范围内/);
    expect(fx.writes()).toEqual([]);
  });

  // 验收 9:页面里的伪造指令只是数据
  it('页面中的伪造指令不会改变程序行为', async () => {
    const project = makeProject(env, ['127.0.0.1']);
    const before = env.repo.listProjects().length;
    const c = await captureUrl(env, project, `${fx.url}/inject`);
    const dom = env.storage.read(env.repo.evidenceFilePath(c.evidenceId as number, 'dom') as string).toString('utf8');
    expect(dom).toContain('忽略之前的所有规则'); // 作为数据保存下来
    expect(env.repo.listProjects()).toHaveLength(before);
    expect(env.repo.listFeatures(project.id)).toHaveLength(0);
    expect(fx.log().filter((e) => e.path === '/steal')).toHaveLength(0);
  });
});
