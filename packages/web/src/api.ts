import type {
  AiProviderInfo,
  BulkAddResult,
  Capture,
  DiscoveryResult,
  Evidence,
  ExportResult,
  Feature,
  FeatureKind,
  Gap,
  HealthInfo,
  InteractionRequest,
  LoginState,
  Page,
  PageStructure,
  Project,
  RequirementCategory,
} from '@uievidence/shared';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `请求失败(${res.status})`);
  return data as T;
}

export interface Candidate {
  name: string;
  description: string;
  kind: FeatureKind;
}

export interface CaptureOptions {
  timeoutMs?: number;
  waitSelector?: string | null;
  viewport?: { width: number; height: number };
  interaction?: InteractionRequest | null;
}

export interface FeatureDraft {
  name: string;
  description?: string;
  kind: FeatureKind;
  category?: RequirementCategory | null;
  acceptance?: string;
  pageIds?: number[];
  evidenceIds?: number[];
}

export const api = {
  health: () => request<HealthInfo>('GET', '/api/health'),

  listProjects: (all = false) => request<Project[]>('GET', `/api/projects${all ? '?all=1' : ''}`),
  getProject: (id: number) => request<Project>('GET', `/api/projects/${id}`),
  createProject: (body: { name: string; targetUrl?: string; purpose?: string; authorization: string; allowedDomains: string[] }) =>
    request<Project>('POST', '/api/projects', body),
  updateProject: (id: number, patch: Partial<Project>) => request<Project>('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id: number) => request<void>('DELETE', `/api/projects/${id}`),
  createDemo: () => request<Project>('POST', '/api/demo'),

  loginState: (projectId: number) => request<LoginState>('GET', `/api/projects/${projectId}/login`),
  startLogin: (projectId: number, url?: string) => request<LoginState>('POST', `/api/projects/${projectId}/login`, url ? { url } : {}),
  finishLogin: (projectId: number) => request<LoginState>('POST', `/api/projects/${projectId}/login/finish`),
  clearLogin: (projectId: number) => request<LoginState>('DELETE', `/api/projects/${projectId}/login`),

  discovered: (projectId: number) => request<DiscoveryResult>('GET', `/api/projects/${projectId}/discovered`),
  bulkAddPages: (projectId: number, urls: string[]) => request<BulkAddResult>('POST', `/api/projects/${projectId}/pages/bulk`, { urls }),

  listPages: (projectId: number) => request<Page[]>('GET', `/api/projects/${projectId}/pages`),
  addPage: (projectId: number, url: string, note = '') => request<Page>('POST', `/api/projects/${projectId}/pages`, { url, note }),
  deletePage: (id: number) => request<void>('DELETE', `/api/pages/${id}`),

  capture: (pageId: number, options: CaptureOptions = {}) => request<Capture>('POST', `/api/pages/${pageId}/captures`, options),
  listCaptures: (projectId: number) => request<Capture[]>('GET', `/api/projects/${projectId}/captures`),
  structure: (captureId: number) => request<PageStructure>('GET', `/api/captures/${captureId}/structure`),
  candidates: (captureId: number) => request<Candidate[]>('GET', `/api/captures/${captureId}/candidates`),
  listEvidence: (projectId: number) => request<Evidence[]>('GET', `/api/projects/${projectId}/evidence`),

  listFeatures: (projectId: number) => request<Feature[]>('GET', `/api/projects/${projectId}/features`),
  createFeature: (projectId: number, body: FeatureDraft) => request<Feature>('POST', `/api/projects/${projectId}/features`, body),
  updateFeature: (id: number, patch: Partial<Pick<Feature, 'name' | 'description' | 'kind' | 'status' | 'category' | 'acceptance'>>) =>
    request<Feature>('PATCH', `/api/features/${id}`, patch),
  setLinks: (id: number, pageIds: number[], evidenceIds: number[]) => request<Feature>('PUT', `/api/features/${id}/links`, { pageIds, evidenceIds }),
  deleteFeature: (id: number) => request<void>('DELETE', `/api/features/${id}`),

  listGaps: (projectId: number) => request<Gap[]>('GET', `/api/projects/${projectId}/gaps`),
  addGap: (projectId: number, description: string) => request<Gap>('POST', `/api/projects/${projectId}/gaps`, { description }),
  resolveGap: (id: number, resolved: boolean) => request<Gap>('PATCH', `/api/gaps/${id}`, { resolved }),
  deleteGap: (id: number) => request<void>('DELETE', `/api/gaps/${id}`),

  exportProject: (projectId: number) => request<ExportResult>('POST', `/api/projects/${projectId}/export`),
  aiAnalyze: (projectId: number, body: { captureId: number; provider: string; model?: string }) =>
    request<{ count: number; features: Feature[]; sentScreenshot: boolean }>('POST', `/api/projects/${projectId}/ai/analyze`, body),
};

export type { AiProviderInfo };
export const evidenceUrl = (evidenceId: number, kind: 'screenshot' | 'dom' | 'structure') => `/api/evidence/${evidenceId}/${kind}`;
