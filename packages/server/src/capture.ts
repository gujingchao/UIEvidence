import fs from 'node:fs';
import type { Page as PwPage, Request as PwRequest } from 'playwright-core';
import type {
  CaptureStatus,
  InteractionRequest,
  InteractionType,
  PageStructure,
  Project,
  StructureInteraction,
} from '@uievidence/shared';
import { detectLoginWall } from './auth.js';
import { openSession } from './browser.js';
import { EXTRACT_SCRIPT, SCROLL_SCRIPT } from './extract-script.js';
import { type Repo } from './repo.js';
import { assertUrlAllowed, isInternalUrl, isPostAllowed, isUrlAllowed, ScopeError } from './scope.js';
import { type Storage } from './storage.js';

const INTERACTION_LABELS: Record<InteractionType, string> = {
  tab: 'Tab 切换',
  pagination: '分页',
  modal: '弹窗展开',
};

/** 采集期间默认放行的请求方法;其余一律拦截,保证不会改变目标系统数据。POST 只在项目放行清单里的路径才放行 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CaptureOutcome {
  status: CaptureStatus;
  error: string | null;
}

interface BlockedWrite {
  method: string;
  url: string;
  path: string;
}

/**
 * 串行执行采集任务。
 *  - 每个任务启动一个全新的浏览器(临时配置),任务之间互不影响。
 *  - 项目有使用者事先登录好的状态时带上它;没有则完全没有登录状态。
 *    永远不会读取使用者日常浏览器的数据。
 */
export class CaptureRunner {
  private queue: number[] = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private repo: Repo,
    private storage: Storage,
  ) {}

  enqueue(captureId: number): void {
    this.queue.push(captureId);
    void this.drain();
  }

  /** 等队列清空,测试和导出前使用 */
  async idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift() as number;
        try {
          await this.execute(id);
        } catch (err) {
          // execute 自己会处理已知失败,走到这里是未预期的错误
          this.safeFail(id, `内部错误:${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private safeFail(captureId: number, message: string): void {
    try {
      const capture = this.repo.getCapture(captureId);
      this.repo.finishCapture(captureId, {
        status: 'failed',
        finalUrl: capture.finalUrl,
        pageTitle: capture.pageTitle,
        stateLabel: capture.stateLabel,
        httpStatus: capture.httpStatus,
        error: message,
        notes: capture.notes,
        browser: capture.browser,
      });
    } catch {
      /* 记录已不存在(例如项目被删除) */
    }
  }

  private addGapOnce(
    projectId: number,
    pageId: number,
    captureId: number,
    type: Parameters<Repo['addGap']>[0]['type'],
    description: string,
    meta?: Parameters<Repo['addGap']>[0]['meta'],
  ): void {
    const exists = this.repo
      .listGaps(projectId)
      .some((g) => g.pageId === pageId && g.type === type && g.description === description && !g.resolved);
    if (!exists) this.repo.addGap({ projectId, pageId, captureId, type, description, meta });
  }

  async execute(captureId: number): Promise<CaptureOutcome> {
    const capture = this.repo.getCapture(captureId);
    const project = this.repo.getProject(capture.projectId);
    const page = this.repo.getPage(capture.pageId);
    this.repo.markCaptureRunning(captureId);

    const notes: string[] = [];
    const fail = (error: string, extra: Partial<Parameters<Repo['finishCapture']>[1]> = {}): CaptureOutcome => {
      this.repo.finishCapture(captureId, {
        status: 'failed',
        finalUrl: null,
        pageTitle: '',
        stateLabel: '',
        httpStatus: null,
        error,
        notes,
        browser: '',
        ...extra,
      });
      this.addGapOnce(project.id, page.id, captureId, 'capture_failed', `${capture.url}:${error}`);
      return { status: 'failed', error };
    };

    // 入口检查:不在白名单内的网址不会启动浏览器,也不会发出任何请求
    try {
      assertUrlAllowed(capture.url, project.allowedDomains);
    } catch (err) {
      const message = err instanceof ScopeError ? err.message : (err as Error).message;
      this.addGapOnce(project.id, page.id, captureId, 'out_of_scope', `${capture.url}:${message}`);
      return fail(message);
    }

    // 使用者事先登录好的状态;没有就是完全没有登录状态的全新浏览器
    const authState = this.storage.authStatePath(project.id);
    const hasLogin = !!project.loginSetAt && fs.existsSync(authState);

    let session;
    try {
      session = await openSession({ storageState: hasLogin ? authState : null, viewport: capture.viewport });
    } catch (err) {
      return fail((err as Error).message);
    }
    const { context, label } = session;

    const blockedWrites: BlockedWrite[] = [];
    const blockedScope = new Set<string>();
    const failedResources: string[] = [];
    let httpStatus: number | null = null;

    try {
      // HTTP route 不拦截 WebSocket。只读采集不能判断消息是否有副作用,
      // 因此在创建页面前拦截全部通道,不调用 connectToServer 建立外部连接。
      await context.routeWebSocket(/.*/, async (socket) => {
        const url = socket.url();
        const httpUrl = new URL(url);
        httpUrl.protocol = httpUrl.protocol === 'wss:' ? 'https:' : 'http:';
        if (!isUrlAllowed(httpUrl.href, project.allowedDomains)) blockedScope.add(safeHost(url));
        blockedWrites.push({ method: 'WEBSOCKET', url, path: safePath(url) });
        await socket.close({ code: 1008, reason: '只读采集不允许 WebSocket' });
      });

      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        if (isInternalUrl(url)) return route.continue();
        if (!isUrlAllowed(url, project.allowedDomains)) {
          blockedScope.add(safeHost(url));
          return route.abort('blockedbyclient');
        }
        const method = request.method();
        if (!READ_ONLY_METHODS.has(method) && !isPostAllowed(method, url, project.allowedPost)) {
          blockedWrites.push({ method, url, path: safePath(url) });
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });

      const pw = await context.newPage();
      // 弹出窗口、对话框一律关闭,避免页面脚本把采集带到范围外
      context.on('page', (popup) => {
        if (popup !== pw) void popup.close().catch(() => {});
      });
      pw.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
      pw.on('requestfailed', (request: PwRequest) => {
        const text = request.failure()?.errorText ?? '';
        if (text.includes('BLOCKED_BY_CLIENT') || text.includes('ABORTED')) return;
        failedResources.push(`${request.url()}(${text})`);
      });

      const timeout = capture.wait.timeoutMs;
      let navError: string | null = null;
      try {
        const response = await pw.goto(capture.url, { waitUntil: 'load', timeout });
        httpStatus = response?.status() ?? null;
      } catch (err) {
        navError = classifyNavError(err as Error, timeout, blockedScope);
      }

      const failWith = (error: string): CaptureOutcome => {
        notes.push(...scopeNotes(blockedScope, blockedWrites, failedResources));
        this.repo.finishCapture(captureId, {
          status: 'failed',
          finalUrl: safeUrl(pw),
          pageTitle: '',
          stateLabel: '',
          httpStatus,
          error,
          notes,
          browser: label,
        });
        this.recordGaps(project, page.id, captureId, 'failed', error, blockedScope, blockedWrites, null);
        return { status: 'failed', error };
      };

      // 页面没能打开:没有可信的内容,不保存证据
      if (navError) return failWith(navError);

      let partial = false;
      await pw.waitForLoadState('networkidle', { timeout: Math.min(timeout, capture.wait.networkIdleMs) }).catch(() => {
        notes.push(`网络请求在 ${Math.round(capture.wait.networkIdleMs / 1000)} 秒内没有静止,已按当前状态采集`);
        partial = true;
      });
      if (capture.wait.waitSelector) {
        await pw.waitForSelector(capture.wait.waitSelector, { timeout }).catch(() => {
          notes.push(`没有等到指定元素 ${capture.wait.waitSelector}`);
          partial = true;
        });
      }
      await pw.evaluate(SCROLL_SCRIPT).catch(() => {
        notes.push('滚动加载失败,懒加载内容可能不完整');
        partial = true;
      });

      // 交互状态:只允许页面里被识别为安全的交互
      let stateLabel = '';
      if (capture.interaction) {
        const outcome = await this.runInteraction(pw, capture.interaction, notes);
        if (outcome.error) return failWith(outcome.error);
        stateLabel = outcome.label;
        await pw.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await sleep(400);
      }

      const structure = (await pw.evaluate(EXTRACT_SCRIPT).catch(() => null)) as PageStructure | null;
      const saved = await this.saveEvidence(project, capture.id, pw, structure, notes);
      const finalUrl = safeUrl(pw);

      // 被挡在登录页外:单独标成"需要登录",而不是笼统的失败
      const wall = detectLoginWall({ requested: capture.url, finalUrl, httpStatus, structure });
      if (wall) {
        const hint = hasLogin
          ? '登录可能已过期,或这个账号没有权限。请重新登录后再采集'
          : '请先在项目里点“登录”,在打开的窗口里登录后再采集';
        const error = `${wall.reason}。${hint}`;
        notes.push(...scopeNotes(blockedScope, blockedWrites, failedResources));
        this.repo.finishCapture(captureId, {
          status: 'login_required',
          finalUrl,
          pageTitle: saved.title,
          stateLabel,
          httpStatus,
          error,
          notes,
          browser: label,
        });
        // 登录页本身也是证据,留下截图方便使用者看到被挡在了哪里
        if (saved.hasEvidence) this.repo.createEvidence(project.id, captureId, saved.files);
        this.addGapOnce(project.id, page.id, captureId, 'auth_required', `${capture.url} 需要登录:${wall.reason}`);
        this.recordGaps(project, page.id, captureId, 'login_required', '', blockedScope, blockedWrites, null);
        return { status: 'login_required', error };
      }

      if (httpStatus !== null && httpStatus >= 400) {
        const error = `HTTP ${httpStatus}`;
        notes.push(...scopeNotes(blockedScope, blockedWrites, failedResources));
        this.repo.finishCapture(captureId, {
          status: 'failed',
          finalUrl,
          pageTitle: saved.title,
          stateLabel,
          httpStatus,
          error,
          notes,
          browser: label,
        });
        // 错误页本身也是证据(例如 404 页面的截图)
        if (saved.hasEvidence) this.repo.createEvidence(project.id, captureId, saved.files);
        this.recordGaps(project, page.id, captureId, 'failed', error, blockedScope, blockedWrites, null);
        return { status: 'failed', error };
      }

      if (failedResources.length || blockedScope.size || blockedWrites.some(w => w.method === 'WEBSOCKET')) partial = true;
      notes.push(...scopeNotes(blockedScope, blockedWrites, failedResources));
      const status: CaptureStatus = partial ? 'partial' : 'success';

      this.repo.finishCapture(captureId, {
        status,
        finalUrl,
        pageTitle: saved.title,
        stateLabel,
        httpStatus,
        error: null,
        notes,
        browser: label,
      });
      if (saved.hasEvidence) this.repo.createEvidence(project.id, captureId, saved.files);
      if (saved.titleToSet && !page.title) this.repo.updatePage(page.id, { title: saved.titleToSet });

      // 这次采集成功了,这个页面之前因为"需要登录"、"采集失败"留下的缺口已经不成立,自动标为已解决
      for (const gap of this.repo.listGaps(project.id)) {
        if (gap.pageId === page.id && !gap.resolved && (gap.type === 'auth_required' || gap.type === 'capture_failed' || gap.type === 'capture_partial')) {
          this.repo.setGapResolved(gap.id, true);
        }
      }

      this.recordGaps(project, page.id, captureId, status, '', blockedScope, blockedWrites, structure);
      if (status === 'partial') {
        this.addGapOnce(project.id, page.id, captureId, 'capture_partial', `${capture.url}:${notes.join(';')}`);
      }
      return { status, error: null };
    } finally {
      await session.close();
    }
  }

  private async runInteraction(
    pw: PwPage,
    request: InteractionRequest,
    notes: string[],
  ): Promise<{ error: string | null; label: string }> {
    const found = ((await pw.evaluate(EXTRACT_SCRIPT).catch(() => null)) as PageStructure | null)?.interactions.find(
      (i: StructureInteraction) => i.selector === request.selector && i.type === request.type,
    );
    if (!found) {
      return { error: '该交互不在允许的范围内(只能执行 Tab、分页、弹窗展开),或页面上已不存在', label: '' };
    }
    try {
      await pw.locator(found.selector).first().click({ timeout: 5000 });
    } catch (err) {
      return { error: `交互执行失败:${(err as Error).message.split('\n')[0]}`, label: '' };
    }
    await pw.waitForLoadState('load', { timeout: 10000 }).catch(() => notes.push('交互后页面加载未完成'));
    const label = `${INTERACTION_LABELS[found.type]}:${found.text || found.selector}`;
    return { error: null, label };
  }

  private async saveEvidence(
    project: Project,
    captureId: number,
    pw: PwPage,
    structure: PageStructure | null,
    notes: string[],
  ) {
    const dir = this.storage.captureDirRel(project.id, captureId);
    const files = { screenshot: null as string | null, dom: null as string | null, structure: null as string | null };
    let title = '';
    try {
      title = await pw.title();
    } catch {
      /* 页面未能加载时没有标题 */
    }

    try {
      let png: Buffer;
      try {
        png = await pw.screenshot({ fullPage: true, type: 'png' });
      } catch {
        png = await pw.screenshot({ type: 'png' });
        notes.push('整页截图失败,已改为首屏截图');
      }
      this.storage.write(`${dir}/screenshot.png`, png);
      files.screenshot = `${dir}/screenshot.png`;
    } catch {
      notes.push('截图失败');
    }

    try {
      this.storage.write(`${dir}/snapshot.html`, await pw.content());
      files.dom = `${dir}/snapshot.html`;
    } catch {
      notes.push('保存页面结构快照失败');
    }

    if (structure) {
      this.storage.write(`${dir}/structure.json`, JSON.stringify(structure, null, 2));
      files.structure = `${dir}/structure.json`;
    }
    return {
      files,
      title,
      titleToSet: title,
      hasEvidence: !!(files.screenshot || files.dom),
    };
  }

  private recordGaps(
    project: Project,
    pageId: number,
    captureId: number,
    status: CaptureStatus | 'failed',
    failure: string,
    blockedScope: Set<string>,
    blockedWrites: BlockedWrite[],
    structure: PageStructure | null,
  ): void {
    const url = this.repo.getCapture(captureId).url;
    if (status === 'failed' && failure) {
      this.addGapOnce(project.id, pageId, captureId, 'capture_failed', failure.startsWith(url) ? failure : `${url}:${failure}`);
    }
    for (const host of blockedScope) {
      this.addGapOnce(project.id, pageId, captureId, 'out_of_scope', `${url} 引用了白名单外的地址 ${host},未请求`);
    }
    // HTTP 写入请求按方法和路径记录,仅只读 POST 可由使用者按路径放行。
    // WebSocket 额外按主机区分,始终阻断并记缺口,不适用 POST 放行清单。
    const seen = new Set<string>();
    for (const w of blockedWrites) {
      const key = `${w.method} ${w.method === 'WEBSOCKET' ? safeHost(w.url) : ''}${w.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (w.method === 'WEBSOCKET') {
        this.addGapOnce(
          project.id,
          pageId,
          captureId,
          'request_blocked',
          `${url} 的 WebSocket 通道 ${safeHost(w.url)}${w.path} 已拦截,未建立连接;依赖该通道的内容可能不完整`,
          { method: w.method, path: w.path },
        );
        continue;
      }
      this.addGapOnce(
        project.id,
        pageId,
        captureId,
        'request_blocked',
        `${url} 发出了写入类请求 ${key},已拦截。如果它只是用来读取数据,可以在“设置”里放行`,
        { method: w.method, path: w.path },
      );
    }
    for (const item of structure?.blocked ?? []) {
      this.addGapOnce(project.id, pageId, captureId, 'interaction_skipped', `${url} 上的「${item.text}」未执行:${item.reason}`);
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function safeUrl(pw: PwPage): string | null {
  try {
    return pw.url() || null;
  } catch {
    return null;
  }
}

function scopeNotes(blockedScope: Set<string>, blockedWrites: BlockedWrite[], failedResources: string[]): string[] {
  const out: string[] = [];
  if (blockedScope.size) out.push(`已拦截对白名单外地址的请求:${[...blockedScope].join(', ')}`);
  const websocketCount = blockedWrites.filter(w => w.method === 'WEBSOCKET').length;
  if (websocketCount) out.push(`已拦截 ${websocketCount} 个 WebSocket 通道(只读采集),依赖通道的内容可能不完整`);
  const httpWriteCount = blockedWrites.length - websocketCount;
  if (httpWriteCount) out.push(`已拦截 ${httpWriteCount} 个写入类请求(只读采集)`);
  if (failedResources.length) out.push(`${failedResources.length} 个资源加载失败:${failedResources.slice(0, 3).join(', ')}`);
  return out;
}

function classifyNavError(err: Error, timeout: number, blockedScope: Set<string>): string {
  const msg = err.message;
  if (blockedScope.size) {
    return `页面请求了白名单外的地址(${[...blockedScope].join(', ')}),已拦截。如果这是登录或单点登录地址,把它加入白名单后再试`;
  }
  if (/Timeout/i.test(msg)) return `页面加载超时(${Math.round(timeout / 1000)} 秒)`;
  if (msg.includes('ERR_NAME_NOT_RESOLVED')) return '域名无法解析';
  if (msg.includes('ERR_CONNECTION_REFUSED')) return '连接被拒绝,目标服务没有响应';
  if (msg.includes('ERR_CERT')) return '证书不受信任';
  if (msg.includes('ERR_UNSAFE_PORT')) return '浏览器禁止访问该端口(被视为不安全端口)';
  if (msg.includes('ERR_CONNECTION_TIMED_OUT')) return '连接超时,目标主机没有响应';
  return `页面无法打开:${msg.split('\n')[0]}`;
}
