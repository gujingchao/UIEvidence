import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Capture, PageStructure, Project } from '@uievidence/shared';
import { CaptureRunner } from '../src/capture.js';
import { openDb } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { Storage } from '../src/storage.js';

export interface TestEnv {
  dir: string;
  repo: Repo;
  storage: Storage;
  runner: CaptureRunner;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uiev-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  const repo = new Repo(db);
  const storage = new Storage(dir);
  const runner = new CaptureRunner(repo, storage);
  return {
    dir,
    repo,
    storage,
    runner,
    cleanup() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeProject(env: TestEnv, allowedDomains: string[]): Project {
  return env.repo.createProject({
    name: '测试项目',
    authorization: '自建测试站,可随意分析',
    allowedDomains,
  });
}

export interface CaptureArgs {
  timeoutMs?: number;
  waitSelector?: string | null;
  interaction?: { type: 'tab' | 'pagination' | 'modal'; selector: string } | null;
}

/** 创建并同步执行一次采集,返回最终记录 */
export async function captureUrl(env: TestEnv, project: Project, url: string, args: CaptureArgs = {}): Promise<Capture> {
  const pages = env.repo.listPages(project.id);
  const page = pages.find((p) => p.url === url) ?? env.repo.addPage(project.id, url);
  const capture = env.repo.createCapture({
    projectId: project.id,
    pageId: page.id,
    url,
    viewport: { width: 1280, height: 800 },
    wait: { timeoutMs: args.timeoutMs ?? 30_000, waitSelector: args.waitSelector ?? null, networkIdleMs: 8000 },
    interaction: args.interaction ?? null,
  });
  await env.runner.execute(capture.id);
  return env.repo.getCapture(capture.id);
}

export function readStructure(env: TestEnv, capture: Capture): PageStructure {
  if (!capture.evidenceId) throw new Error('采集没有证据');
  const rel = env.repo.evidenceFilePath(capture.evidenceId, 'structure');
  if (!rel) throw new Error('没有结构文件');
  return JSON.parse(env.storage.read(rel).toString('utf8')) as PageStructure;
}
