import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { HealthInfo, PageStructure } from '@uievidence/shared';
import { analyze, getProvider, listProviders } from './ai.js';
import { detectBrowser } from './browser.js';
import { candidatesFromStructure } from './candidates.js';
import { CaptureRunner } from './capture.js';
import { openDb } from './db.js';
import { writeExport } from './export.js';
import { NotFoundError, Repo } from './repo.js';
import { assertUrlAllowed, normalizeDomains, ScopeError } from './scope.js';
import { Storage } from './storage.js';

export const VERSION = '0.1.0';

export interface AppOptions {
  dataDir: string;
  /** 前端构建产物目录;不传则只提供 API */
  webDist?: string;
  env?: NodeJS.ProcessEnv;
  /** 本地服务监听的端口,用于校验 Host 头 */
  port?: number;
}

export interface AppContext {
  app: FastifyInstance;
  repo: Repo;
  storage: Storage;
  runner: CaptureRunner;
}

const domainEntry = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(https?:\/\/)?(\*\.)?[a-zA-Z0-9._-]+(:\d+)?(\/.*)?$|^\[[0-9a-fA-F:]+\](:\d+)?$/, '域名格式不正确');

const projectCreate = z.object({
  name: z.string().trim().min(1).max(100),
  targetUrl: z.string().trim().max(500).optional(),
  purpose: z.string().max(2000).optional(),
  authorization: z.string().trim().min(2, '请填写授权说明').max(2000),
  allowedDomains: z.array(domainEntry).min(1, '至少设置一个允许分析的域名'),
});

const projectPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  targetUrl: z.string().trim().max(500).optional(),
  purpose: z.string().max(2000).optional(),
  authorization: z.string().trim().min(2).max(2000).optional(),
  allowedDomains: z.array(domainEntry).min(1).optional(),
  allowAi: z.boolean().optional(),
  archived: z.boolean().optional(),
  planText: z.string().max(100_000).optional(),
});

const captureBody = z.object({
  viewport: z
    .object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(4000) })
    .default({ width: 1280, height: 800 }),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  waitSelector: z.string().trim().max(200).nullable().optional(),
  interaction: z
    .object({ type: z.enum(['tab', 'pagination', 'modal']), selector: z.string().min(1).max(2000) })
    .nullable()
    .optional(),
});

const featureKind = z.enum(['observed', 'inferred', 'requirement', 'question']);
const category = z.enum(['admin', 'permission', 'data', 'notify', 'integration', 'other']);

const featureCreate = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).optional(),
  kind: featureKind,
  category: category.nullable().optional(),
  acceptance: z.string().max(2000).optional(),
  pageIds: z.array(z.number().int()).optional(),
  evidenceIds: z.array(z.number().int()).optional(),
});

const featurePatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(5000).optional(),
  kind: featureKind.optional(),
  status: z.enum(['accepted', 'pending', 'rejected']).optional(),
  category: category.nullable().optional(),
  acceptance: z.string().max(2000).optional(),
});

const id = (value: unknown) => z.coerce.number().int().positive().parse(value);

/** 发送给模型的截图大小上限,超过则只发送结构数据 */
const MAX_AI_IMAGE_BYTES = 3_500_000;

export async function createApp(options: AppOptions): Promise<AppContext> {
  const env = options.env ?? process.env;
  const storage = new Storage(options.dataDir);
  const db = openDb(path.join(storage.root, 'uievidence.db'));
  const repo = new Repo(db);
  const runner = new CaptureRunner(repo, storage);
  repo.failInterruptedCaptures();

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  // 服务关闭时等采集队列清空再关数据库;否则 Windows 上数据文件会一直被占用
  app.addHook('onClose', async () => {
    await runner.idle();
    db.close();
  });

  // ---- 本地服务的安全防护 ----
  // 只接受访问本机的 Host,防止 DNS 重绑定;写请求如果带 Origin,必须和 Host 同源,防止其他网站跨站调用。
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
      return reply.code(403).send({ error: '只允许从本机访问' });
    }
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        /* 无效 Origin 视为不同源 */
      }
      // 开发时前端跑在 Vite 的端口上,经代理访问,Host 会被改写成后端地址
      if (originHost !== host && !(env.UIEV_DEV === '1' && /^(localhost|127\.0\.0\.1):\d+$/.test(originHost))) {
        return reply.code(403).send({ error: '拒绝跨站请求' });
      }
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: first ? `${first.path.join('.') || '参数'}:${first.message}` : '参数不正确' });
    }
    if (err instanceof ScopeError) return reply.code(400).send({ error: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    const message = (err as Error).message ?? '';
    if (/UNIQUE constraint failed: pages/.test(message)) return reply.code(409).send({ error: '该网址已在页面清单中' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: message });
    app.log.error(err);
    return reply.code(500).send({ error: `服务内部错误:${message}` });
  });

  // ---- 健康检查 ----
  app.get('/api/health', async (): Promise<HealthInfo> => ({
    ok: true,
    version: VERSION,
    browser: await detectBrowser(),
    providers: listProviders(env),
  }));

  // ---- 项目 ----
  app.get('/api/projects', async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    return repo.listProjects(all);
  });

  app.post('/api/projects', async (req, reply) => {
    const body = projectCreate.parse(req.body);
    const project = repo.createProject({ ...body, allowedDomains: normalizeDomains(body.allowedDomains) });
    return reply.code(201).send(project);
  });

  app.get('/api/projects/:id', async (req) => repo.getProject(id((req.params as any).id)));

  app.patch('/api/projects/:id', async (req) => {
    const body = projectPatch.parse(req.body);
    return repo.updateProject(id((req.params as any).id), {
      ...body,
      allowedDomains: body.allowedDomains ? normalizeDomains(body.allowedDomains) : undefined,
    });
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const projectId = id((req.params as any).id);
    repo.deleteProject(projectId);
    storage.removeProjectDir(projectId);
    return reply.code(204).send();
  });

  // ---- 页面 ----
  app.get('/api/projects/:id/pages', async (req) => repo.listPages(id((req.params as any).id)));

  app.post('/api/projects/:id/pages', async (req, reply) => {
    const projectId = id((req.params as any).id);
    const project = repo.getProject(projectId);
    const body = z.object({ url: z.string().trim().min(1).max(2000), note: z.string().max(1000).optional() }).parse(req.body);
    assertUrlAllowed(body.url, project.allowedDomains);
    const page = repo.addPage(projectId, new URL(body.url).href, body.note ?? '');
    return reply.code(201).send(page);
  });

  app.patch('/api/pages/:id', async (req) => {
    const body = z.object({ note: z.string().max(1000).optional(), title: z.string().max(300).optional() }).parse(req.body);
    return repo.updatePage(id((req.params as any).id), body);
  });

  app.delete('/api/pages/:id', async (req, reply) => {
    repo.deletePage(id((req.params as any).id));
    return reply.code(204).send();
  });

  // ---- 采集 ----
  app.post('/api/pages/:id/captures', async (req, reply) => {
    const page = repo.getPage(id((req.params as any).id));
    const project = repo.getProject(page.projectId);
    if (project.archived) return reply.code(409).send({ error: '项目已归档,不能再采集' });
    const body = captureBody.parse(req.body ?? {});
    // 创建前就检查白名单:范围外的网址不会产生采集记录,更不会启动浏览器
    assertUrlAllowed(page.url, project.allowedDomains);
    const capture = repo.createCapture({
      projectId: project.id,
      pageId: page.id,
      url: page.url,
      viewport: body.viewport,
      wait: { timeoutMs: body.timeoutMs, waitSelector: body.waitSelector ?? null, networkIdleMs: 8000 },
      interaction: body.interaction ?? null,
    });
    runner.enqueue(capture.id);
    return reply.code(202).send(capture);
  });

  app.get('/api/projects/:id/captures', async (req) => {
    const q = req.query as { pageId?: string };
    return repo.listCaptures(id((req.params as any).id), q.pageId ? id(q.pageId) : undefined);
  });

  app.get('/api/captures/:id', async (req) => repo.getCapture(id((req.params as any).id)));

  const loadStructure = (captureId: number): PageStructure | null => {
    const capture = repo.getCapture(captureId);
    if (!capture.evidenceId) return null;
    const rel = repo.evidenceFilePath(capture.evidenceId, 'structure');
    if (!rel || !storage.exists(rel)) return null;
    return JSON.parse(storage.read(rel).toString('utf8')) as PageStructure;
  };

  app.get('/api/captures/:id/structure', async (req, reply) => {
    const s = loadStructure(id((req.params as any).id));
    if (!s) return reply.code(404).send({ error: '这次采集没有页面结构' });
    return s;
  });

  app.get('/api/captures/:id/candidates', async (req) => {
    const s = loadStructure(id((req.params as any).id));
    return s ? candidatesFromStructure(s) : [];
  });

  // ---- 证据文件 ----
  app.get('/api/evidence/:id/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    if (kind !== 'screenshot' && kind !== 'dom' && kind !== 'structure') return reply.code(404).send({ error: '未知的证据类型' });
    const rel = repo.evidenceFilePath(id((req.params as any).id), kind);
    if (!rel || !storage.exists(rel)) return reply.code(404).send({ error: '文件不存在' });
    const data = storage.read(rel);
    // 页面快照是别人网站的 HTML,绝不能以 text/html 提供,否则它的脚本会在本地服务的域下执行
    const type = kind === 'screenshot' ? 'image/png' : kind === 'structure' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    return reply
      .header('content-type', type)
      .header('content-security-policy', "default-src 'none'; img-src 'self'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });

  // ---- 功能条目 ----
  app.get('/api/projects/:id/features', async (req) => repo.listFeatures(id((req.params as any).id)));

  app.post('/api/projects/:id/features', async (req, reply) => {
    const body = featureCreate.parse(req.body);
    const feature = repo.createFeature(id((req.params as any).id), { ...body, source: 'manual', status: 'accepted' });
    return reply.code(201).send(feature);
  });

  app.patch('/api/features/:id', async (req) => repo.updateFeature(id((req.params as any).id), featurePatch.parse(req.body)));

  app.put('/api/features/:id/links', async (req) => {
    const featureId = id((req.params as any).id);
    const body = z.object({ pageIds: z.array(z.number().int()), evidenceIds: z.array(z.number().int()) }).parse(req.body);
    const feature = repo.getFeature(featureId);
    return repo.setFeatureLinks(feature.projectId, featureId, body.pageIds, body.evidenceIds);
  });

  app.delete('/api/features/:id', async (req, reply) => {
    repo.deleteFeature(id((req.params as any).id));
    return reply.code(204).send();
  });

  // ---- 证据列表 ----
  app.get('/api/projects/:id/evidence', async (req) => repo.listEvidence(id((req.params as any).id)));

  // ---- 分析缺口 ----
  app.get('/api/projects/:id/gaps', async (req) => repo.listGaps(id((req.params as any).id)));

  app.post('/api/projects/:id/gaps', async (req, reply) => {
    const projectId = id((req.params as any).id);
    repo.getProject(projectId);
    const body = z.object({ description: z.string().trim().min(1).max(1000), pageId: z.number().int().nullable().optional() }).parse(req.body);
    return reply.code(201).send(repo.addGap({ projectId, pageId: body.pageId ?? null, type: 'manual', description: body.description }));
  });

  app.patch('/api/gaps/:id', async (req) => {
    const body = z.object({ resolved: z.boolean() }).parse(req.body);
    return repo.setGapResolved(id((req.params as any).id), body.resolved);
  });

  app.delete('/api/gaps/:id', async (req, reply) => {
    repo.deleteGap(id((req.params as any).id));
    return reply.code(204).send();
  });

  // ---- 导出 ----
  app.post('/api/projects/:id/export', async (req) => {
    const project = repo.getProject(id((req.params as any).id));
    return writeExport(repo, storage, project);
  });

  // ---- AI 分析(可选) ----
  app.post('/api/projects/:id/ai/analyze', async (req, reply) => {
    const project = repo.getProject(id((req.params as any).id));
    if (!project.allowAi) {
      return reply.code(403).send({ error: '该项目没有开启“允许发送内容给模型”,AI 分析不可用' });
    }
    const body = z
      .object({ captureId: z.number().int(), provider: z.string(), model: z.string().trim().max(100).optional() })
      .parse(req.body);

    const capture = repo.getCapture(body.captureId);
    if (capture.projectId !== project.id) throw new NotFoundError('采集记录');
    const structure = loadStructure(capture.id);
    if (!structure) return reply.code(400).send({ error: '这次采集没有页面结构,无法分析' });

    let provider;
    try {
      provider = getProvider(body.provider);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    let screenshot: Buffer | undefined;
    const shotRel = capture.evidenceId ? repo.evidenceFilePath(capture.evidenceId, 'screenshot') : null;
    if (shotRel && storage.exists(shotRel)) {
      const data = storage.read(shotRel);
      if (data.length <= MAX_AI_IMAGE_BYTES) screenshot = data;
    }

    try {
      const suggestions = await analyze(
        provider,
        body.model || provider.defaultModel,
        { project, pageUrl: capture.url, structure, screenshot },
        env,
      );
      // AI 的结果只作为待采纳条目入库,人工采纳前不会进入报告
      const created = suggestions.map((s) =>
        repo.createFeature(project.id, {
          name: s.name,
          description: s.description,
          kind: s.kind,
          source: 'ai',
          status: 'pending',
          pageIds: [capture.pageId],
          evidenceIds: capture.evidenceId ? [capture.evidenceId] : [],
        }),
      );
      return { count: created.length, features: created, sentScreenshot: !!screenshot };
    } catch (err) {
      return reply.code(502).send({ error: `AI 分析失败:${(err as Error).message}` });
    }
  });

  // ---- 静态文件 ----
  const exportsRoot = path.join(storage.root, 'exports');
  fs.mkdirSync(exportsRoot, { recursive: true });
  await app.register(fastifyStatic, { root: exportsRoot, prefix: '/exports/', decorateReply: false });

  if (options.webDist && fs.existsSync(options.webDist)) {
    await app.register(fastifyStatic, { root: options.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/exports/')) return reply.code(404).send({ error: '不存在' });
      return reply.sendFile('index.html');
    });
  }

  return { app, repo, storage, runner };
}
