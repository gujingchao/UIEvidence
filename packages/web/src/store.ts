import { computed, inject, onBeforeUnmount, provide, ref, type InjectionKey } from 'vue';
import type { Capture, Evidence, Feature, Gap, Page, Project } from '@uievidence/shared';
import { api } from './api';
import { notify } from './toast';

/** 一个项目页面里所有标签页共享的数据 */
export function createProjectStore(projectId: number) {
  const project = ref<Project | null>(null);
  const pages = ref<Page[]>([]);
  const captures = ref<Capture[]>([]);
  const evidence = ref<Evidence[]>([]);
  const features = ref<Feature[]>([]);
  const gaps = ref<Gap[]>([]);
  const loading = ref(true);

  const run = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      notify((err as Error).message, 'error');
      return undefined;
    }
  };

  const loadProject = async () => void (project.value = (await run(() => api.getProject(projectId))) ?? project.value);
  const loadPages = async () => void (pages.value = (await run(() => api.listPages(projectId))) ?? pages.value);
  const loadCaptures = async () => void (captures.value = (await run(() => api.listCaptures(projectId))) ?? captures.value);
  const loadEvidence = async () => void (evidence.value = (await run(() => api.listEvidence(projectId))) ?? evidence.value);
  const loadFeatures = async () => void (features.value = (await run(() => api.listFeatures(projectId))) ?? features.value);
  const loadGaps = async () => void (gaps.value = (await run(() => api.listGaps(projectId))) ?? gaps.value);

  const loadAll = async () => {
    loading.value = true;
    await Promise.all([loadProject(), loadPages(), loadCaptures(), loadEvidence(), loadFeatures(), loadGaps()]);
    loading.value = false;
  };

  const busy = computed(() => captures.value.some((c) => c.status === 'queued' || c.status === 'running'));

  // 有采集在跑时,定期刷新结果
  const timer = setInterval(async () => {
    if (!busy.value) return;
    await Promise.all([loadCaptures(), loadPages(), loadEvidence(), loadGaps()]);
  }, 1500);
  onBeforeUnmount(() => clearInterval(timer));

  const pageById = (id: number) => pages.value.find((p) => p.id === id);
  const evidenceById = (id: number) => evidence.value.find((e) => e.id === id);
  const captureOfEvidence = (evidenceId: number) => captures.value.find((c) => c.evidenceId === evidenceId);

  return {
    projectId,
    project,
    pages,
    captures,
    evidence,
    features,
    gaps,
    loading,
    busy,
    run,
    loadAll,
    loadProject,
    loadPages,
    loadCaptures,
    loadEvidence,
    loadFeatures,
    loadGaps,
    pageById,
    evidenceById,
    captureOfEvidence,
  };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;
const KEY: InjectionKey<ProjectStore> = Symbol('project-store');

export function provideProjectStore(store: ProjectStore): void {
  provide(KEY, store);
}

export function useProjectStore(): ProjectStore {
  const store = inject(KEY);
  if (!store) throw new Error('缺少项目上下文');
  return store;
}
