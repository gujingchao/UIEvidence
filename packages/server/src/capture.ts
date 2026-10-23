import type { Page as PwPage, Request as PwRequest } from 'playwright-core';
import type {
  CaptureStatus,
  InteractionRequest,
  InteractionType,
  PageStructure,
  Project,
  StructureInteraction,
} from '@uievidence/shared';
import { launchBrowser } from './browser.js';
import { EXTRACT_SCRIPT, SCROLL_SCRIPT } from './extract-script.js';
import { type Repo } from './repo.js';
import { assertUrlAllowed, isInternalUrl, isUrlAllowed, ScopeError } from './scope.js';
import { type Storage } from './storage.js';

const INTERACTION_LABELS: Record<InteractionType, string> = {
  tab: 'Tab 切换',
  pagination: '分页',
  modal: '弹窗展开',
};

/** 采集期间唯一允许放行的请求方法;其余一律拦截,保证不会改变目标系统数据 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CaptureOutcome {
  status: CaptureStatus;
  error: string | null;
}

/**
 * 串行执行采集任务。每个任务启动一个全新的浏览器进程(临时配置),
 * 任务之间互不影响,也不会带上使用者日常浏览器的登录状态。
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
  ): void {
    const exists = this.repo
      .listGaps(projectId)
      .some((g) => g.pageId === pageId && g.type === type && g.description === description && !g.resolved);
    if (!exists) this.repo.addGap({ projectId, pageId, captureId, type, description });
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

    let launched;
    try {
      launched = await launchBrowser();
    } catch (err) {
      return fail((err as Error).message);
    }
    const { browser, label } = launched;

    const blockedWrites: string[] = [];
    const blockedScope = new Set<string>();
    const failedResources: string[] = [];
    let httpStatus: number | null = null;

    try {
      const context = await browser.newContext({
        viewport: capture.viewport,
        serviceWorkers: 'block',
        acceptDownloads: false,
      });

      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        if (isInternalUrl(url)) return route.continue();
        if (!isUrlAllowed(url, project.allowedDomains)) {
          blockedScope.add(safeHost(url));
          return route.abort('blockedbyclient');
        }
        if (!READ_ONLY_METHODS.has(request.method())) {
          blockedWrites.push(`${request.method()} ${url}`);
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

      if (httpStatus !== null && httpStatus >= 400) {
        const error = `HTTP ${httpStatus}`;
        notes.push(...scopeNotes(blockedScope, blockedWrites, failedResources));
        this.repo.finishCapture(captureId, {
          status: 'failed',
          finalUrl: safeUrl(pw),
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

      if (failedResources.length || blockedScope.size) partial = true;
      notes.push(...scopeNotes(blockedScope, blockedWrites, failedResources));
      const status: CaptureStatus = partial ? 'partial' : 'success';

      this.repo.finishCapture(captureId, {
        status,
        finalUrl: safeUrl(pw),
        pageTitle: saved.title,
        stateLabel,
        httpStatus,
        error: null,
        notes,
        browser: label,
      });
      if (saved.hasEvidence) this.repo.createEvidence(project.id, captureId, saved.files);
      if (saved.titleToSet && !page.title) this.repo.updatePage(page.id, { title: saved.titleToSet });

      this.recordGaps(project, page.id, captureId, status, '', blockedScope, blockedWrites, structure);
      if (status === 'partial') {
        this.addGapOnce(project.id, page.id, captureId, 'capture_partial', `${capture.url}:${notes.join(';')}`);
      }
      return { status, error: null };
    } finally {
      await browser.close().catch(() => {});
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
    status: CaptureStatus,
    failure: string,
    blockedScope: Set<string>,
    blockedWrites: string[],
    structure: PageStructure | null,
  ): void {
    const url = this.repo.getCapture(captureId).url;
    if (status === 'failed' && failure) {
      this.addGapOnce(project.id, pageId, captureId, 'capture_failed', failure.startsWith(url) ? failure : `${url}:${failure}`);
    }
    for (const host of blockedScope) {
      this.addGapOnce(project.id, pageId, captureId, 'out_of_scope', `${url} 引用了白名单外的地址 ${host},未请求`);
    }
    if (blockedWrites.length) {
      this.addGapOnce(
        project.id,
        pageId,
        captureId,
        'request_blocked',
        `${url} 触发了 ${blockedWrites.length} 个写入类请求(${blockedWrites.slice(0, 3).join(', ')}),已拦截`,
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

function safeUrl(pw: PwPage): string | null {
  try {
    return pw.url() || null;
  } catch {
    return null;
  }
}

function scopeNotes(blockedScope: Set<string>, blockedWrites: string[], failedResources: string[]): string[] {
  const out: string[] = [];
  if (blockedScope.size) out.push(`已拦截对白名单外地址的请求:${[...blockedScope].join(', ')}`);
  if (blockedWrites.length) out.push(`已拦截 ${blockedWrites.length} 个写入类请求(只读采集)`);
  if (failedResources.length) out.push(`${failedResources.length} 个资源加载失败:${failedResources.slice(0, 3).join(', ')}`);
  return out;
}

function classifyNavError(err: Error, timeout: number, blockedScope: Set<string>): string {
  const msg = err.message;
  if (blockedScope.size) return `页面请求了白名单外的地址(${[...blockedScope].join(', ')}),已拦截`;
  if (/Timeout/i.test(msg)) return `页面加载超时(${Math.round(timeout / 1000)} 秒)`;
  if (msg.includes('ERR_NAME_NOT_RESOLVED')) return '域名无法解析';
  if (msg.includes('ERR_CONNECTION_REFUSED')) return '连接被拒绝,目标服务没有响应';
  if (msg.includes('ERR_CERT')) return '证书不受信任';
  if (msg.includes('ERR_UNSAFE_PORT')) return '浏览器禁止访问该端口(被视为不安全端口)';
  if (msg.includes('ERR_CONNECTION_TIMED_OUT')) return '连接超时,目标主机没有响应';
  return `页面无法打开:${msg.split('\n')[0]}`;
}
