import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { NotFoundError, Repo } from '../src/repo.js';

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uiev-repo-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const newRepo = () => new Repo(openDb(':memory:'));
const base = { name: 'P', authorization: '自建站', allowedDomains: ['example.com'] };

describe('数据层', () => {
  it('项目、页面的增删改查', () => {
    const repo = newRepo();
    const p = repo.createProject(base);
    expect(p.allowAi).toBe(false); // AI 默认关闭
    expect(p.allowedDomains).toEqual(['example.com']);

    const page = repo.addPage(p.id, 'https://example.com/a');
    expect(repo.listPages(p.id)).toHaveLength(1);
    expect(() => repo.addPage(p.id, 'https://example.com/a')).toThrow(/UNIQUE/);

    repo.updateProject(p.id, { archived: true });
    expect(repo.listProjects()).toHaveLength(0);
    expect(repo.listProjects(true)).toHaveLength(1);

    repo.deletePage(page.id);
    expect(repo.listPages(p.id)).toHaveLength(0);
    expect(() => repo.getPage(page.id)).toThrow(NotFoundError);
  });

  it('证据编号按项目递增,互不影响', () => {
    const repo = newRepo();
    const a = repo.createProject(base);
    const b = repo.createProject(base);
    const mk = (projectId: number) => {
      const page = repo.addPage(projectId, `https://example.com/${Math.random()}`);
      const cap = repo.createCapture({
        projectId,
        pageId: page.id,
        url: page.url,
        viewport: { width: 1, height: 1 },
        wait: { timeoutMs: 1, waitSelector: null, networkIdleMs: 1 },
        interaction: null,
      });
      return repo.createEvidence(projectId, cap.id, { screenshot: null, dom: null, structure: null }).code;
    };
    expect([mk(a.id), mk(a.id), mk(b.id), mk(a.id)]).toEqual(['E-001', 'E-002', 'E-001', 'E-003']);
  });

  it('功能条目与页面、证据是多对多,且不能关联其他项目的对象', () => {
    const repo = newRepo();
    const a = repo.createProject(base);
    const b = repo.createProject(base);
    const pageA = repo.addPage(a.id, 'https://example.com/1');
    const pageA2 = repo.addPage(a.id, 'https://example.com/2');
    const pageB = repo.addPage(b.id, 'https://example.com/3');

    const f1 = repo.createFeature(a.id, { name: '列表', kind: 'observed', pageIds: [pageA.id, pageA2.id] });
    const f2 = repo.createFeature(a.id, { name: '筛选', kind: 'observed', pageIds: [pageA.id] });
    expect(f1.pageIds).toEqual([pageA.id, pageA2.id]);
    expect(f2.status).toBe('accepted');

    expect(() => repo.createFeature(a.id, { name: 'x', kind: 'observed', pageIds: [pageB.id] })).toThrow(NotFoundError);
    // 失败的创建不留下残余
    expect(repo.listFeatures(a.id)).toHaveLength(2);

    repo.deletePage(pageA.id);
    expect(repo.getFeature(f1.id).pageIds).toEqual([pageA2.id]);
  });

  it('四种功能类型都能保存,AI 条目默认可设为待采纳', () => {
    const repo = newRepo();
    const p = repo.createProject(base);
    for (const kind of ['observed', 'inferred', 'requirement', 'question'] as const) {
      repo.createFeature(p.id, { name: kind, kind });
    }
    const ai = repo.createFeature(p.id, { name: 'ai', kind: 'inferred', source: 'ai', status: 'pending' });
    expect(repo.listFeatures(p.id).map((f) => f.kind)).toEqual(['observed', 'inferred', 'requirement', 'question', 'inferred']);
    expect(ai.source).toBe('ai');
    expect(ai.status).toBe('pending');
    expect(repo.updateFeature(ai.id, { status: 'accepted' }).status).toBe('accepted');
  });

  it('删除项目会级联清理全部数据', () => {
    const repo = newRepo();
    const p = repo.createProject(base);
    const page = repo.addPage(p.id, 'https://example.com/1');
    repo.createFeature(p.id, { name: 'f', kind: 'observed', pageIds: [page.id] });
    repo.addGap({ projectId: p.id, type: 'manual', description: 'g' });
    repo.deleteProject(p.id);
    expect(repo.listPages(p.id)).toHaveLength(0);
    expect(repo.listFeatures(p.id)).toHaveLength(0);
    expect(repo.listGaps(p.id)).toHaveLength(0);
  });

  it('服务重启时把没跑完的采集标记为失败', () => {
    const repo = newRepo();
    const p = repo.createProject(base);
    const page = repo.addPage(p.id, 'https://example.com/1');
    const cap = repo.createCapture({
      projectId: p.id,
      pageId: page.id,
      url: page.url,
      viewport: { width: 1, height: 1 },
      wait: { timeoutMs: 1, waitSelector: null, networkIdleMs: 1 },
      interaction: null,
    });
    repo.markCaptureRunning(cap.id);
    expect(repo.failInterruptedCaptures()).toBe(1);
    expect(repo.getCapture(cap.id).status).toBe('failed');
    expect(repo.getCapture(cap.id).error).toMatch(/中断/);
  });

  // 验收 10(数据库部分):重新打开后数据完整
  it('关闭后重新打开数据库,记录仍然完整', () => {
    const file = path.join(tmp(), 'x.db');
    const first = new Repo(openDb(file));
    const p = first.createProject(base);
    const page = first.addPage(p.id, 'https://example.com/1');
    first.createFeature(p.id, { name: '保留我', kind: 'question', pageIds: [page.id] });
    first.db.close();

    const second = new Repo(openDb(file));
    expect(second.getProject(p.id).name).toBe('P');
    expect(second.listFeatures(p.id)[0]).toMatchObject({ name: '保留我', kind: 'question', pageIds: [page.id] });
    second.db.close();
  });
});
