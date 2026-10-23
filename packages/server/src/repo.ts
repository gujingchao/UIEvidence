import type {
  Capture,
  CaptureStatus,
  Evidence,
  Feature,
  FeatureKind,
  FeatureSource,
  FeatureStatus,
  Gap,
  GapType,
  InteractionRequest,
  Page,
  Project,
  RequirementCategory,
  Viewport,
  WaitStrategy,
} from '@uievidence/shared';
import { type Db, now, transaction } from './db.js';

type Row = Record<string, any>;

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what}不存在`);
    this.name = 'NotFoundError';
  }
}

/** 当前状态下不能做这件事(例如登录窗口还开着),对应 HTTP 409 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function toProject(r: Row): Project {
  return {
    id: r.id,
    name: r.name,
    targetUrl: r.target_url,
    purpose: r.purpose,
    authorization: r.authorization,
    allowedDomains: parseJson<string[]>(r.allowed_domains, []),
    allowAi: !!r.allow_ai,
    archived: !!r.archived,
    planText: r.plan_text,
    allowedPost: parseJson<string[]>(r.allowed_post, []),
    loginSetAt: r.login_set_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toPage(r: Row): Page {
  return {
    id: r.id,
    projectId: r.project_id,
    url: r.url,
    title: r.title,
    note: r.note,
    createdAt: r.created_at,
    captureCount: r.capture_count ?? 0,
    lastCaptureStatus: (r.last_status as CaptureStatus | null) ?? null,
  };
}

function toCapture(r: Row): Capture {
  return {
    id: r.id,
    projectId: r.project_id,
    pageId: r.page_id,
    url: r.url,
    finalUrl: r.final_url,
    pageTitle: r.page_title,
    stateLabel: r.state_label,
    interaction: parseJson<InteractionRequest | null>(r.interaction, null),
    viewport: { width: r.viewport_w, height: r.viewport_h },
    status: r.status,
    httpStatus: r.http_status,
    error: r.error,
    notes: parseJson<string[]>(r.notes, []),
    browser: r.browser,
    wait: parseJson<WaitStrategy>(r.wait, { timeoutMs: 30000, waitSelector: null, networkIdleMs: 8000 }),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    evidenceId: r.evidence_id ?? null,
    evidenceCode: r.evidence_code ?? null,
  };
}

function toGap(r: Row): Gap {
  return {
    id: r.id,
    projectId: r.project_id,
    pageId: r.page_id,
    captureId: r.capture_id,
    type: r.type,
    description: r.description,
    resolved: !!r.resolved,
    meta: parseJson<Gap['meta']>(r.meta, null),
    createdAt: r.created_at,
  };
}

export interface ProjectInput {
  name: string;
  targetUrl?: string;
  purpose?: string;
  authorization: string;
  allowedDomains: string[];
}

export interface FeatureInput {
  name: string;
  description?: string;
  kind: FeatureKind;
  source?: FeatureSource;
  status?: FeatureStatus;
  category?: RequirementCategory | null;
  acceptance?: string;
  pageIds?: number[];
  evidenceIds?: number[];
}

export interface EvidenceFiles {
  screenshot: string | null;
  dom: string | null;
  structure: string | null;
}

const CAPTURE_SELECT = `
  SELECT c.*, e.id AS evidence_id, e.code AS evidence_code
  FROM captures c LEFT JOIN evidence e ON e.capture_id = c.id`;

export class Repo {
  constructor(readonly db: Db) {}

  // ---- 项目 ----

  listProjects(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY id DESC'
      : 'SELECT * FROM projects WHERE archived = 0 ORDER BY id DESC';
    return (this.db.prepare(sql).all() as Row[]).map(toProject);
  }

  getProject(id: number): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError('项目');
    return toProject(row);
  }

  createProject(input: ProjectInput): Project {
    const t = now();
    const res = this.db
      .prepare(
        `INSERT INTO projects (name, target_url, purpose, authorization, allowed_domains, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.targetUrl ?? '',
        input.purpose ?? '',
        input.authorization,
        JSON.stringify(input.allowedDomains),
        t,
        t,
      );
    return this.getProject(Number(res.lastInsertRowid));
  }

  updateProject(
    id: number,
    patch: Partial<ProjectInput> & {
      allowAi?: boolean;
      archived?: boolean;
      planText?: string;
      allowedPost?: string[];
      /** null 表示清除登录会话 */
      loginSetAt?: string | null;
    },
  ): Project {
    const cur = this.getProject(id);
    const next = {
      name: patch.name ?? cur.name,
      targetUrl: patch.targetUrl ?? cur.targetUrl,
      purpose: patch.purpose ?? cur.purpose,
      authorization: patch.authorization ?? cur.authorization,
      allowedDomains: patch.allowedDomains ?? cur.allowedDomains,
      allowAi: patch.allowAi ?? cur.allowAi,
      archived: patch.archived ?? cur.archived,
      planText: patch.planText ?? cur.planText,
      allowedPost: patch.allowedPost ?? cur.allowedPost,
      loginSetAt: patch.loginSetAt === undefined ? cur.loginSetAt : patch.loginSetAt,
    };
    this.db
      .prepare(
        `UPDATE projects SET name=?, target_url=?, purpose=?, authorization=?, allowed_domains=?,
         allow_ai=?, archived=?, plan_text=?, allowed_post=?, login_set_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.targetUrl,
        next.purpose,
        next.authorization,
        JSON.stringify(next.allowedDomains),
        next.allowAi ? 1 : 0,
        next.archived ? 1 : 0,
        next.planText,
        JSON.stringify(next.allowedPost),
        next.loginSetAt,
        now(),
        id,
      );
    return this.getProject(id);
  }

  deleteProject(id: number): void {
    this.getProject(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ---- 页面 ----

  listPages(projectId: number): Page[] {
    const rows = this.db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM captures c WHERE c.page_id = p.id) AS capture_count,
           (SELECT c.status FROM captures c WHERE c.page_id = p.id ORDER BY c.id DESC LIMIT 1) AS last_status
         FROM pages p WHERE p.project_id = ? ORDER BY p.id`,
      )
      .all(projectId) as Row[];
    return rows.map(toPage);
  }

  getPage(id: number): Page {
    const row = this.db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM captures c WHERE c.page_id = p.id) AS capture_count,
           (SELECT c.status FROM captures c WHERE c.page_id = p.id ORDER BY c.id DESC LIMIT 1) AS last_status
         FROM pages p WHERE p.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundError('页面');
    return toPage(row);
  }

  addPage(projectId: number, url: string, note = ''): Page {
    this.getProject(projectId);
    const res = this.db
      .prepare('INSERT INTO pages (project_id, url, note, created_at) VALUES (?, ?, ?, ?)')
      .run(projectId, url, note, now());
    return this.getPage(Number(res.lastInsertRowid));
  }

  updatePage(id: number, patch: { note?: string; title?: string }): Page {
    const cur = this.getPage(id);
    this.db
      .prepare('UPDATE pages SET note = ?, title = ? WHERE id = ?')
      .run(patch.note ?? cur.note, patch.title ?? cur.title, id);
    return this.getPage(id);
  }

  deletePage(id: number): void {
    this.getPage(id);
    this.db.prepare('DELETE FROM pages WHERE id = ?').run(id);
  }

  // ---- 采集 ----

  createCapture(input: {
    projectId: number;
    pageId: number;
    url: string;
    viewport: Viewport;
    wait: WaitStrategy;
    interaction: InteractionRequest | null;
  }): Capture {
    const res = this.db
      .prepare(
        `INSERT INTO captures (project_id, page_id, url, interaction, viewport_w, viewport_h, status, wait, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        input.projectId,
        input.pageId,
        input.url,
        input.interaction ? JSON.stringify(input.interaction) : null,
        input.viewport.width,
        input.viewport.height,
        JSON.stringify(input.wait),
        now(),
      );
    return this.getCapture(Number(res.lastInsertRowid));
  }

  getCapture(id: number): Capture {
    const row = this.db.prepare(`${CAPTURE_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
    if (!row) throw new NotFoundError('采集记录');
    return toCapture(row);
  }

  listCaptures(projectId: number, pageId?: number): Capture[] {
    const rows = (
      pageId === undefined
        ? this.db.prepare(`${CAPTURE_SELECT} WHERE c.project_id = ? ORDER BY c.id DESC`).all(projectId)
        : this.db
            .prepare(`${CAPTURE_SELECT} WHERE c.project_id = ? AND c.page_id = ? ORDER BY c.id DESC`)
            .all(projectId, pageId)
    ) as Row[];
    return rows.map(toCapture);
  }

  markCaptureRunning(id: number): void {
    this.db.prepare(`UPDATE captures SET status = 'running', started_at = ? WHERE id = ?`).run(now(), id);
  }

  finishCapture(
    id: number,
    result: {
      status: CaptureStatus;
      finalUrl: string | null;
      pageTitle: string;
      stateLabel: string;
      httpStatus: number | null;
      error: string | null;
      notes: string[];
      browser: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE captures SET status=?, final_url=?, page_title=?, state_label=?, http_status=?,
         error=?, notes=?, browser=?, finished_at=? WHERE id=?`,
      )
      .run(
        result.status,
        result.finalUrl,
        result.pageTitle,
        result.stateLabel,
        result.httpStatus,
        result.error,
        JSON.stringify(result.notes),
        result.browser,
        now(),
        id,
      );
  }

  /** 服务重启时,把上次没跑完的采集标记为失败,避免卡在 running */
  failInterruptedCaptures(): number {
    const res = this.db
      .prepare(
        `UPDATE captures SET status = 'failed', error = '服务重启,采集被中断', finished_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(now());
    return Number(res.changes);
  }

  // ---- 证据 ----

  createEvidence(projectId: number, captureId: number, files: EvidenceFiles): Evidence {
    return transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM evidence WHERE project_id = ?')
        .get(projectId) as Row;
      const code = `E-${String(Number(row.n) + 1).padStart(3, '0')}`;
      const res = this.db
        .prepare(
          `INSERT INTO evidence (project_id, capture_id, code, screenshot_path, dom_path, structure_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, captureId, code, files.screenshot, files.dom, files.structure, now());
      return this.getEvidence(Number(res.lastInsertRowid));
    });
  }

  getEvidence(id: number): Evidence {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError('证据');
    return {
      id: row.id,
      projectId: row.project_id,
      captureId: row.capture_id,
      code: row.code,
      createdAt: row.created_at,
    };
  }

  listEvidence(projectId: number): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY id')
      .all(projectId) as Row[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      captureId: row.capture_id,
      code: row.code,
      createdAt: row.created_at,
    }));
  }

  evidenceFilePath(evidenceId: number, kind: 'screenshot' | 'dom' | 'structure'): string | null {
    const row = this.db
      .prepare('SELECT screenshot_path, dom_path, structure_path FROM evidence WHERE id = ?')
      .get(evidenceId) as Row | undefined;
    if (!row) throw new NotFoundError('证据');
    const col = { screenshot: 'screenshot_path', dom: 'dom_path', structure: 'structure_path' }[kind];
    return (row[col] as string | null) ?? null;
  }

  // ---- 功能条目 ----

  private loadFeatureLinks(featureIds: number[]): Map<number, { pageIds: number[]; evidenceIds: number[] }> {
    const map = new Map<number, { pageIds: number[]; evidenceIds: number[] }>();
    for (const id of featureIds) map.set(id, { pageIds: [], evidenceIds: [] });
    if (!featureIds.length) return map;
    const marks = featureIds.map(() => '?').join(',');
    for (const r of this.db
      .prepare(`SELECT * FROM feature_pages WHERE feature_id IN (${marks}) ORDER BY page_id`)
      .all(...featureIds) as Row[]) {
      map.get(r.feature_id)?.pageIds.push(r.page_id);
    }
    for (const r of this.db
      .prepare(`SELECT * FROM feature_evidence WHERE feature_id IN (${marks}) ORDER BY evidence_id`)
      .all(...featureIds) as Row[]) {
      map.get(r.feature_id)?.evidenceIds.push(r.evidence_id);
    }
    return map;
  }

  private toFeatures(rows: Row[]): Feature[] {
    const links = this.loadFeatureLinks(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      source: r.source,
      status: r.status,
      category: r.category,
      acceptance: r.acceptance,
      pageIds: links.get(r.id)?.pageIds ?? [],
      evidenceIds: links.get(r.id)?.evidenceIds ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  listFeatures(projectId: number): Feature[] {
    return this.toFeatures(
      this.db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY id').all(projectId) as Row[],
    );
  }

  getFeature(id: number): Feature {
    const row = this.db.prepare('SELECT * FROM features WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError('功能条目');
    return this.toFeatures([row])[0] as Feature;
  }

  createFeature(projectId: number, input: FeatureInput): Feature {
    this.getProject(projectId);
    return transaction(this.db, () => {
      const t = now();
      const res = this.db
        .prepare(
          `INSERT INTO features (project_id, name, description, kind, source, status, category, acceptance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          input.name,
          input.description ?? '',
          input.kind,
          input.source ?? 'manual',
          input.status ?? 'accepted',
          input.category ?? null,
          input.acceptance ?? '',
          t,
          t,
        );
      const id = Number(res.lastInsertRowid);
      this.setFeatureLinks(projectId, id, input.pageIds ?? [], input.evidenceIds ?? []);
      return this.getFeature(id);
    });
  }

  updateFeature(
    id: number,
    patch: Partial<Omit<FeatureInput, 'pageIds' | 'evidenceIds' | 'source'>>,
  ): Feature {
    const cur = this.getFeature(id);
    this.db
      .prepare(
        `UPDATE features SET name=?, description=?, kind=?, status=?, category=?, acceptance=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.name ?? cur.name,
        patch.description ?? cur.description,
        patch.kind ?? cur.kind,
        patch.status ?? cur.status,
        patch.category === undefined ? cur.category : patch.category,
        patch.acceptance ?? cur.acceptance,
        now(),
        id,
      );
    return this.getFeature(id);
  }

  deleteFeature(id: number): void {
    this.getFeature(id);
    this.db.prepare('DELETE FROM features WHERE id = ?').run(id);
  }

  /** 关联页面和证据;只允许关联同一项目内的对象 */
  setFeatureLinks(projectId: number, featureId: number, pageIds: number[], evidenceIds: number[]): Feature {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM feature_pages WHERE feature_id = ?').run(featureId);
      this.db.prepare('DELETE FROM feature_evidence WHERE feature_id = ?').run(featureId);
      for (const pageId of new Set(pageIds)) {
        const ok = this.db
          .prepare('SELECT 1 AS ok FROM pages WHERE id = ? AND project_id = ?')
          .get(pageId, projectId);
        if (!ok) throw new NotFoundError(`页面 ${pageId}`);
        this.db.prepare('INSERT INTO feature_pages (feature_id, page_id) VALUES (?, ?)').run(featureId, pageId);
      }
      for (const evidenceId of new Set(evidenceIds)) {
        const ok = this.db
          .prepare('SELECT 1 AS ok FROM evidence WHERE id = ? AND project_id = ?')
          .get(evidenceId, projectId);
        if (!ok) throw new NotFoundError(`证据 ${evidenceId}`);
        this.db
          .prepare('INSERT INTO feature_evidence (feature_id, evidence_id) VALUES (?, ?)')
          .run(featureId, evidenceId);
      }
    });
    return this.getFeature(featureId);
  }

  // ---- 分析缺口 ----

  listGaps(projectId: number): Gap[] {
    return (this.db.prepare('SELECT * FROM gaps WHERE project_id = ? ORDER BY id').all(projectId) as Row[]).map(
      toGap,
    );
  }

  addGap(input: {
    projectId: number;
    pageId?: number | null;
    captureId?: number | null;
    type: GapType;
    description: string;
    meta?: Gap['meta'];
  }): Gap {
    const res = this.db
      .prepare(
        `INSERT INTO gaps (project_id, page_id, capture_id, type, description, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.pageId ?? null,
        input.captureId ?? null,
        input.type,
        input.description,
        input.meta ? JSON.stringify(input.meta) : null,
        now(),
      );
    return toGap(this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(Number(res.lastInsertRowid)) as Row);
  }

  setGapResolved(id: number, resolved: boolean): Gap {
    const res = this.db.prepare('UPDATE gaps SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id);
    if (!res.changes) throw new NotFoundError('分析缺口');
    return toGap(this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(id) as Row);
  }

  deleteGap(id: number): void {
    this.db.prepare('DELETE FROM gaps WHERE id = ?').run(id);
  }
}
