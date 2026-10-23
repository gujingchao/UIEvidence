/** 功能条目类型:已观察事实 / 推测功能 / 人工补充需求 / 待确认问题 */
export type FeatureKind = 'observed' | 'inferred' | 'requirement' | 'question';
export const FEATURE_KINDS: FeatureKind[] = ['observed', 'inferred', 'requirement', 'question'];
export const FEATURE_KIND_LABELS: Record<FeatureKind, string> = {
  observed: '已观察事实',
  inferred: '推测功能',
  requirement: '人工补充需求',
  question: '待确认问题',
};

export type FeatureSource = 'manual' | 'ai';
/** AI 生成的条目先是 pending,人工采纳后才是 accepted */
export type FeatureStatus = 'accepted' | 'pending' | 'rejected';

export type RequirementCategory = 'admin' | 'permission' | 'data' | 'notify' | 'integration' | 'other';
export const REQUIREMENT_CATEGORY_LABELS: Record<RequirementCategory, string> = {
  admin: '后台管理',
  permission: '角色权限',
  data: '数据要求',
  notify: '通知方式',
  integration: '外部对接',
  other: '其他',
};

export type CaptureStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed';

export type InteractionType = 'tab' | 'pagination' | 'modal';

export interface Project {
  id: number;
  name: string;
  targetUrl: string;
  purpose: string;
  /** 授权声明:说明为何有权分析该网站 */
  authorization: string;
  /** 域名白名单,条目形如 example.com、*.example.com、127.0.0.1:4000 */
  allowedDomains: string[];
  /** 是否允许把采集内容发送给第三方模型服务 */
  allowAi: boolean;
  archived: boolean;
  planText: string;
  createdAt: string;
  updatedAt: string;
}

export interface Page {
  id: number;
  projectId: number;
  url: string;
  title: string;
  note: string;
  createdAt: string;
  captureCount: number;
  lastCaptureStatus: CaptureStatus | null;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface InteractionRequest {
  type: InteractionType;
  selector: string;
}

export interface WaitStrategy {
  timeoutMs: number;
  waitSelector: string | null;
  networkIdleMs: number;
}

export interface Capture {
  id: number;
  projectId: number;
  pageId: number;
  url: string;
  finalUrl: string | null;
  pageTitle: string;
  /** 空表示页面初始状态;否则描述被执行的交互 */
  stateLabel: string;
  interaction: InteractionRequest | null;
  viewport: Viewport;
  status: CaptureStatus;
  httpStatus: number | null;
  error: string | null;
  notes: string[];
  browser: string;
  wait: WaitStrategy;
  startedAt: string;
  finishedAt: string | null;
  evidenceId: number | null;
  evidenceCode: string | null;
}

export interface Evidence {
  id: number;
  projectId: number;
  captureId: number;
  code: string;
  createdAt: string;
}

export interface Feature {
  id: number;
  projectId: number;
  name: string;
  description: string;
  kind: FeatureKind;
  source: FeatureSource;
  status: FeatureStatus;
  category: RequirementCategory | null;
  acceptance: string;
  pageIds: number[];
  evidenceIds: number[];
  createdAt: string;
  updatedAt: string;
}

export type GapType = 'interaction_skipped' | 'capture_failed' | 'capture_partial' | 'request_blocked' | 'out_of_scope' | 'manual';

export interface Gap {
  id: number;
  projectId: number;
  pageId: number | null;
  captureId: number | null;
  type: GapType;
  description: string;
  resolved: boolean;
  createdAt: string;
}

// ---- 页面结构(采集提取结果) ----

export interface StructureLink {
  text: string;
  href: string;
  internal: boolean;
}

export interface StructureField {
  name: string;
  type: string;
  label: string;
  required: boolean;
  placeholder: string;
}

export interface StructureForm {
  action: string;
  method: string;
  fields: StructureField[];
  submitText: string;
}

export interface StructureList {
  kind: 'list' | 'table' | 'cards';
  itemCount: number;
  sample: string[];
}

export interface StructureInteraction {
  type: InteractionType;
  selector: string;
  text: string;
}

export interface StructureBlocked {
  text: string;
  reason: string;
}

export interface PageStructure {
  title: string;
  lang: string;
  headings: { level: number; text: string }[];
  nav: StructureLink[];
  links: StructureLink[];
  forms: StructureForm[];
  lists: StructureList[];
  dialogs: string[];
  /** 可安全执行的交互(导航链接、Tab、分页、弹窗展开) */
  interactions: StructureInteraction[];
  /** 看到但不会执行的可点击元素(提交、删除、支付等),会记为分析缺口 */
  blocked: StructureBlocked[];
}

// ---- AI ----

export interface AiProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  defaultModel: string;
  hint: string;
}

export interface AiSuggestion {
  name: string;
  description: string;
  kind: FeatureKind;
}

// ---- 其他 ----

export interface ExportResult {
  stamp: string;
  baseUrl: string;
  reportMd: string;
  reportHtml: string;
  bundle: string;
}

export interface HealthInfo {
  ok: true;
  version: string;
  browser: { found: boolean; channel: string | null; version: string | null };
  providers: AiProviderInfo[];
}
