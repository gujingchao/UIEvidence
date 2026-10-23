import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import {
  FEATURE_KIND_LABELS,
  REQUIREMENT_CATEGORY_LABELS,
  type Capture,
  type ExportResult,
  type Feature,
  type FeatureKind,
  type Gap,
  type Page,
  type PageStructure,
  type Project,
} from '@uievidence/shared';
import { type Repo } from './repo.js';
import { type Storage } from './storage.js';

/**
 * 导出分两步:先把项目数据整理成统一的 ExportModel,再分别渲染成 Markdown 和 HTML。
 * 两种格式读同一份模型,所以页面清单、功能条目、证据编号必然一致。
 */

export interface ExportEvidence {
  code: string;
  pageUrl: string;
  pageTitle: string;
  stateLabel: string;
  capturedAt: string;
  viewport: string;
  browser: string;
  status: string;
  /** 相对报告文件的路径,例如 evidence/E-001/screenshot.png */
  screenshot: string | null;
  summary: string[];
}

export interface ExportFeature {
  id: number;
  name: string;
  description: string;
  kind: FeatureKind;
  kindLabel: string;
  category: string | null;
  acceptance: string;
  pageUrls: string[];
  evidenceCodes: string[];
}

export interface ExportPageRow {
  url: string;
  title: string;
  captureCount: number;
  lastStatus: string;
  evidenceCodes: string[];
}

export interface ExportModel {
  generatedAt: string;
  project: { name: string; targetUrl: string; purpose: string; authorization: string; allowedDomains: string[] };
  pages: ExportPageRow[];
  features: ExportFeature[];
  pendingCount: number;
  evidence: ExportEvidence[];
  gaps: { type: string; description: string }[];
  plan: string;
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '采集中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  login_required: '需要登录',
};

const GAP_LABELS: Record<string, string> = {
  auth_required: '需要登录',
  interaction_skipped: '未执行的交互',
  capture_failed: '采集失败',
  capture_partial: '部分采集',
  request_blocked: '拦截的写入请求',
  out_of_scope: '白名单外的地址',
  manual: '人工记录',
};

function summarize(s: PageStructure | null): string[] {
  if (!s) return [];
  const lines: string[] = [];
  if (s.headings.length) lines.push(`标题:${s.headings.slice(0, 5).map((h) => h.text).join(' / ')}`);
  if (s.nav.length) lines.push(`导航:${s.nav.slice(0, 10).map((n) => n.text).join('、')}`);
  for (const f of s.forms) {
    lines.push(
      `表单(${f.method.toUpperCase()}):${f.fields.map((x) => `${x.label || x.name}${x.required ? '*' : ''}`).join('、') || '无字段'}`,
    );
  }
  for (const l of s.lists) lines.push(`${{ list: '列表', table: '表格', cards: '卡片' }[l.kind]}:${l.itemCount} 项`);
  if (s.interactions.length) lines.push(`可执行交互:${s.interactions.map((i) => i.text || i.type).join('、')}`);
  if (s.blocked.length) lines.push(`未执行:${s.blocked.map((b) => b.text).join('、')}`);
  return lines;
}

export function buildModel(repo: Repo, storage: Storage, project: Project): ExportModel {
  const pages = repo.listPages(project.id);
  const captures = repo.listCaptures(project.id).reverse();
  const evidenceRows = repo.listEvidence(project.id);
  const features = repo.listFeatures(project.id);
  const gaps = repo.listGaps(project.id).filter((g) => !g.resolved);

  const pageById = new Map<number, Page>(pages.map((p) => [p.id, p]));
  const captureById = new Map<number, Capture>(captures.map((c) => [c.id, c]));
  const evidenceCode = new Map(evidenceRows.map((e) => [e.id, e.code]));
  const pageEvidence = new Map<number, string[]>();

  const evidence: ExportEvidence[] = evidenceRows.map((e) => {
    const c = captureById.get(e.captureId);
    const page = c ? pageById.get(c.pageId) : undefined;
    if (c) pageEvidence.set(c.pageId, [...(pageEvidence.get(c.pageId) ?? []), e.code]);

    let structure: PageStructure | null = null;
    const structureRel = repo.evidenceFilePath(e.id, 'structure');
    if (structureRel && storage.exists(structureRel)) {
      structure = JSON.parse(storage.read(structureRel).toString('utf8')) as PageStructure;
    }
    const shot = repo.evidenceFilePath(e.id, 'screenshot');
    return {
      code: e.code,
      pageUrl: page?.url ?? c?.url ?? '',
      pageTitle: c?.pageTitle ?? '',
      stateLabel: c?.stateLabel ?? '',
      capturedAt: c?.startedAt ?? e.createdAt,
      viewport: c ? `${c.viewport.width}×${c.viewport.height}` : '',
      browser: c?.browser ?? '',
      status: STATUS_LABELS[c?.status ?? ''] ?? '',
      screenshot: shot && storage.exists(shot) ? `evidence/${e.code}/screenshot.png` : null,
      summary: summarize(structure),
    };
  });

  const accepted = features.filter((f) => f.status === 'accepted');
  const exportFeatures: ExportFeature[] = accepted.map((f: Feature) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    kind: f.kind,
    kindLabel: FEATURE_KIND_LABELS[f.kind],
    category: f.category ? REQUIREMENT_CATEGORY_LABELS[f.category] : null,
    acceptance: f.acceptance,
    pageUrls: f.pageIds.map((id) => pageById.get(id)?.url ?? '').filter(Boolean),
    evidenceCodes: f.evidenceIds.map((id) => evidenceCode.get(id) ?? '').filter(Boolean),
  }));

  return {
    generatedAt: new Date().toISOString(),
    project: {
      name: project.name,
      targetUrl: project.targetUrl,
      purpose: project.purpose,
      authorization: project.authorization,
      allowedDomains: project.allowedDomains,
    },
    pages: pages.map((p) => ({
      url: p.url,
      title: p.title,
      captureCount: p.captureCount,
      lastStatus: p.lastCaptureStatus ? (STATUS_LABELS[p.lastCaptureStatus] ?? '') : '未采集',
      evidenceCodes: pageEvidence.get(p.id) ?? [],
    })),
    features: exportFeatures,
    pendingCount: features.filter((f) => f.status === 'pending').length,
    evidence,
    gaps: gaps.map((g: Gap) => ({ type: GAP_LABELS[g.type] ?? g.type, description: g.description })),
    plan: project.planText,
  };
}

// ---- Markdown ----

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(m: ExportModel): string {
  const L: string[] = [];
  const kinds: FeatureKind[] = ['observed', 'inferred', 'requirement', 'question'];

  L.push(`# ${m.project.name} 网站功能分析报告`, '', `生成时间:${m.generatedAt}`, '');

  L.push('## 1. 项目背景与分析范围', '');
  if (m.project.targetUrl) L.push(`- 目标网站:${m.project.targetUrl}`);
  if (m.project.purpose) L.push(`- 分析目的:${m.project.purpose}`);
  L.push(`- 授权说明:${m.project.authorization}`);
  L.push(`- 允许分析的域名:${m.project.allowedDomains.join('、') || '(未设置)'}`);
  L.push('- 采集方式:只读,不提交表单,不执行删除、支付等会改变目标系统数据的操作。', '');

  L.push('## 2. 页面清单', '');
  L.push('| 页面 | 标题 | 采集次数 | 最近状态 | 证据 |', '|---|---|---|---|---|');
  for (const p of m.pages) {
    L.push(`| ${cell(p.url)} | ${cell(p.title)} | ${p.captureCount} | ${p.lastStatus} | ${p.evidenceCodes.join(', ')} |`);
  }
  L.push('');

  L.push('## 3. 功能模块', '');
  for (const kind of ['observed'] as FeatureKind[]) {
    const items = m.features.filter((f) => f.kind === kind);
    L.push(`### ${FEATURE_KIND_LABELS[kind]}`, '');
    if (!items.length) L.push('(暂无)', '');
    for (const f of items) pushFeature(L, f);
  }

  L.push('## 4. 证据与观察', '');
  for (const e of m.evidence) {
    L.push(`### ${e.code} ${e.pageTitle || e.pageUrl}`, '');
    L.push(`- 页面:${e.pageUrl}`);
    if (e.stateLabel) L.push(`- 页面状态:${e.stateLabel}`);
    L.push(`- 采集时间:${e.capturedAt}`, `- 视口:${e.viewport}`, `- 浏览器:${e.browser}`, `- 采集结果:${e.status}`);
    for (const line of e.summary) L.push(`- ${line}`);
    if (e.screenshot) L.push('', `![${e.code} 截图](${e.screenshot})`);
    L.push('');
  }
  if (!m.evidence.length) L.push('(暂无证据)', '');

  L.push('## 5. 推测功能、补充需求与待确认问题', '');
  for (const kind of kinds.slice(1)) {
    const items = m.features.filter((f) => f.kind === kind);
    L.push(`### ${FEATURE_KIND_LABELS[kind]}`, '');
    if (!items.length) L.push('(暂无)', '');
    for (const f of items) pushFeature(L, f);
  }
  if (m.pendingCount) L.push(`> 另有 ${m.pendingCount} 条 AI 建议尚未采纳,未列入报告。`, '');

  L.push('## 6. 分析缺口', '');
  if (!m.gaps.length) L.push('(暂无)', '');
  for (const g of m.gaps) L.push(`- **${g.type}**:${g.description}`);
  L.push('');

  L.push('## 7. 初步方案', '');
  L.push(m.plan.trim() || '(尚未填写)', '');

  return L.join('\n');
}

function pushFeature(L: string[], f: ExportFeature): void {
  L.push(`#### ${f.name}${f.category ? `(${f.category})` : ''}`, '');
  if (f.description) L.push(f.description, '');
  if (f.acceptance) L.push(`- 候选验收条件:${f.acceptance}`);
  L.push(`- 类型:${f.kindLabel}`);
  if (f.pageUrls.length) L.push(`- 来源页面:${f.pageUrls.join('、')}`);
  if (f.evidenceCodes.length) L.push(`- 证据:${f.evidenceCodes.join('、')}`);
  L.push('');
}

// ---- HTML ----

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderHtml(m: ExportModel): string {
  const kinds: FeatureKind[] = ['observed', 'inferred', 'requirement', 'question'];
  const h: string[] = [];
  const feature = (f: ExportFeature) =>
    `<article class="feature kind-${f.kind}"><h4>${esc(f.name)}${f.category ? `<small>(${esc(f.category)})</small>` : ''}</h4>
${f.description ? `<p>${esc(f.description)}</p>` : ''}
<ul>${f.acceptance ? `<li>候选验收条件:${esc(f.acceptance)}</li>` : ''}<li>类型:${esc(f.kindLabel)}</li>
${f.pageUrls.length ? `<li>来源页面:${f.pageUrls.map(esc).join('、')}</li>` : ''}
${f.evidenceCodes.length ? `<li>证据:${f.evidenceCodes.map((c) => `<a href="#${c}">${c}</a>`).join('、')}</li>` : ''}</ul></article>`;

  h.push(`<h1>${esc(m.project.name)} 网站功能分析报告</h1><p class="meta">生成时间:${esc(m.generatedAt)}</p>`);

  h.push('<h2>1. 项目背景与分析范围</h2><ul>');
  if (m.project.targetUrl) h.push(`<li>目标网站:${esc(m.project.targetUrl)}</li>`);
  if (m.project.purpose) h.push(`<li>分析目的:${esc(m.project.purpose)}</li>`);
  h.push(`<li>授权说明:${esc(m.project.authorization)}</li>`);
  h.push(`<li>允许分析的域名:${esc(m.project.allowedDomains.join('、') || '(未设置)')}</li>`);
  h.push('<li>采集方式:只读,不提交表单,不执行删除、支付等会改变目标系统数据的操作。</li></ul>');

  h.push('<h2>2. 页面清单</h2><table><thead><tr><th>页面</th><th>标题</th><th>采集次数</th><th>最近状态</th><th>证据</th></tr></thead><tbody>');
  for (const p of m.pages) {
    h.push(
      `<tr><td>${esc(p.url)}</td><td>${esc(p.title)}</td><td>${p.captureCount}</td><td>${esc(p.lastStatus)}</td><td>${p.evidenceCodes
        .map((c) => `<a href="#${c}">${c}</a>`)
        .join(', ')}</td></tr>`,
    );
  }
  h.push('</tbody></table>');

  h.push(`<h2>3. 功能模块</h2><h3>${FEATURE_KIND_LABELS.observed}</h3>`);
  const observed = m.features.filter((f) => f.kind === 'observed');
  h.push(observed.length ? observed.map(feature).join('\n') : '<p>(暂无)</p>');

  h.push('<h2>4. 证据与观察</h2>');
  for (const e of m.evidence) {
    h.push(`<section id="${e.code}"><h3>${e.code} ${esc(e.pageTitle || e.pageUrl)}</h3><ul>
<li>页面:${esc(e.pageUrl)}</li>${e.stateLabel ? `<li>页面状态:${esc(e.stateLabel)}</li>` : ''}
<li>采集时间:${esc(e.capturedAt)}</li><li>视口:${esc(e.viewport)}</li><li>浏览器:${esc(e.browser)}</li><li>采集结果:${esc(e.status)}</li>
${e.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
${e.screenshot ? `<img src="${esc(e.screenshot)}" alt="${e.code} 截图">` : ''}</section>`);
  }
  if (!m.evidence.length) h.push('<p>(暂无证据)</p>');

  h.push('<h2>5. 推测功能、补充需求与待确认问题</h2>');
  for (const kind of kinds.slice(1)) {
    const items = m.features.filter((f) => f.kind === kind);
    h.push(`<h3>${FEATURE_KIND_LABELS[kind]}</h3>`);
    h.push(items.length ? items.map(feature).join('\n') : '<p>(暂无)</p>');
  }
  if (m.pendingCount) h.push(`<p class="meta">另有 ${m.pendingCount} 条 AI 建议尚未采纳,未列入报告。</p>`);

  h.push('<h2>6. 分析缺口</h2>');
  h.push(m.gaps.length ? `<ul>${m.gaps.map((g) => `<li><strong>${esc(g.type)}</strong>:${esc(g.description)}</li>`).join('')}</ul>` : '<p>(暂无)</p>');

  h.push(`<h2>7. 初步方案</h2><pre class="plan">${esc(m.plan.trim() || '(尚未填写)')}</pre>`);

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(m.project.name)} 网站功能分析报告</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:960px;margin:0 auto;padding:24px;line-height:1.65;color:#1f2933}
h1{border-bottom:2px solid #1f4e79;padding-bottom:8px}h2{margin-top:2em;border-bottom:1px solid #d0d7de;padding-bottom:4px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;font-size:14px}th{background:#f3f6f9}
img{max-width:100%;border:1px solid #d0d7de;border-radius:4px}.meta{color:#667}
.feature{border-left:4px solid #1f4e79;padding:2px 14px;margin:12px 0;background:#f8fafc}
.kind-inferred{border-color:#b7791f}.kind-requirement{border-color:#2f855a}.kind-question{border-color:#c53030}
small{color:#667;font-weight:normal;margin-left:6px}.plan{white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:4px}
</style></head><body>
${h.join('\n')}
</body></html>`;
}

// ---- 写出 ----

/** 把报告、截图写进 exports/<projectId>/<stamp>/,并打包成 zip。目录里的相对路径与报告中的引用一致。 */
export function writeExport(repo: Repo, storage: Storage, project: Project): ExportResult {
  const model = buildModel(repo, storage, project);
  const stamp = model.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const dir = storage.exportDir(project.id, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const md = renderMarkdown(model);
  const html = renderHtml(model);
  const files: Record<string, Uint8Array> = {
    'report.md': Buffer.from(md, 'utf8'),
    'report.html': Buffer.from(html, 'utf8'),
  };
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  fs.writeFileSync(path.join(dir, 'report.html'), html);

  for (const e of repo.listEvidence(project.id)) {
    const rel = repo.evidenceFilePath(e.id, 'screenshot');
    if (!rel || !storage.exists(rel)) continue;
    const data = storage.read(rel);
    const target = path.join(dir, 'evidence', e.code, 'screenshot.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files[`evidence/${e.code}/screenshot.png`] = data;
  }

  fs.writeFileSync(path.join(dir, 'bundle.zip'), zipSync(files, { level: 6 }));

  const baseUrl = `/exports/${project.id}/${stamp}`;
  return {
    stamp,
    baseUrl,
    reportMd: `${baseUrl}/report.md`,
    reportHtml: `${baseUrl}/report.html`,
    bundle: `${baseUrl}/bundle.zip`,
  };
}
