import { computed, inject, onBeforeUnmount, provide, reactive, ref, type InjectionKey } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Capture, DiscoveredLink, DiscoveryResult, Evidence, Feature, Gap, LoginState, Page, Project } from '@uievidence/shared';
import { api, type CaptureOptions } from './api';
import { notify } from './toast';

/** 一个项目页面里所有标签页共享的数据和操作 */
export function createProjectStore(projectId: number) {
  const route = useRoute();
  const router = useRouter();

  const project = ref<Project | null>(null);
  const pages = ref<Page[]>([]);
  const captures = ref<Capture[]>([]);
  const evidence = ref<Evidence[]>([]);
  const features = ref<Feature[]>([]);
  const gaps = ref<Gap[]>([]);
  const discovered = ref<DiscoveredLink[]>([]);
  const excluded = ref<DiscoveryResult['excluded']>([]);
  const login = ref<LoginState | null>(null);
  const loading = ref(true);

  /** 采集选项,页面清单和证据抽屉共用 */
  const options = reactive({ timeoutSec: 30, waitSelector: '', width: 1280, height: 800 });
  const captureOptions = (): CaptureOptions => ({
    timeoutMs: Math.round(options.timeoutSec * 1000),
    waitSelector: options.waitSelector.trim() || null,
    viewport: { width: options.width, height: options.height },
  });

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
  const loadDiscovered = async () => {
    const r = await run(() => api.discovered(projectId));
    if (r) {
      discovered.value = r.links;
      excluded.value = r.excluded;
    }
  };
  const loadLogin = async () => void (login.value = (await run(() => api.loginState(projectId))) ?? login.value);

  const loadAll = async () => {
    loading.value = true;
    await Promise.all([loadProject(), loadPages(), loadCaptures(), loadEvidence(), loadFeatures(), loadGaps(), loadDiscovered(), loadLogin()]);
    loading.value = false;
  };

  const busy = computed(() => captures.value.some((c) => c.status === 'queued' || c.status === 'running'));

  // 有采集在跑时定期刷新结果;采集刚结束时再刷新一次"发现的页面";登录窗口开着时跟踪它的状态
  let wasBusy = false;
  const timer = setInterval(async () => {
    if (busy.value) {
      wasBusy = true;
      await Promise.all([loadCaptures(), loadPages(), loadEvidence(), loadGaps()]);
    } else if (wasBusy) {
      wasBusy = false;
      await Promise.all([loadCaptures(), loadPages(), loadEvidence(), loadGaps(), loadDiscovered()]);
    }
    if (login.value?.open) {
      await loadLogin();
      if (!login.value?.open) await loadProject();
    }
  }, 1500);
  onBeforeUnmount(() => clearInterval(timer));

  const pageById = (id: number) => pages.value.find((p) => p.id === id);
  const evidenceById = (id: number) => evidence.value.find((e) => e.id === id);
  const captureOfEvidence = (evidenceId: number) => captures.value.find((c) => c.evidenceId === evidenceId);

  // ---- 采集 ----
  async function capturePage(page: Page): Promise<boolean> {
    try {
      await api.capture(page.id, captureOptions());
      await Promise.all([loadCaptures(), loadPages()]);
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    }
  }

  /** 采集全部页面;onlyMissing 时只采集还没有成功结果的 */
  async function captureAll(onlyMissing = false): Promise<void> {
    const targets = pages.value.filter((p) => !onlyMissing || (p.lastCaptureStatus !== 'success' && p.lastCaptureStatus !== 'partial'));
    for (const p of targets) await capturePage(p);
  }

  // ---- 证据抽屉:状态在地址里(?page=&capture=),刷新和后退都有效 ----
  const drawerPageId = computed(() => Number(route.query.page) || null);
  const drawerCaptureId = computed(() => Number(route.query.capture) || null);

  function openPage(pageId: number, captureId?: number | null): void {
    const query: Record<string, string> = { ...(route.query as Record<string, string>), page: String(pageId) };
    if (captureId) query.capture = String(captureId);
    else delete query.capture;
    void router.push({ query });
  }

  /** 抽屉里切换采集记录,用 replace,免得后退要一条条退 */
  function selectCapture(captureId: number): void {
    void router.replace({ query: { ...route.query, capture: String(captureId) } });
  }

  function closeDrawer(): void {
    const query = { ...route.query };
    delete query.page;
    delete query.capture;
    void router.push({ query });
  }

  return {
    projectId,
    project,
    pages,
    captures,
    evidence,
    features,
    gaps,
    discovered,
    excluded,
    login,
    loading,
    busy,
    options,
    captureOptions,
    run,
    loadAll,
    loadProject,
    loadPages,
    loadCaptures,
    loadEvidence,
    loadFeatures,
    loadGaps,
    loadDiscovered,
    loadLogin,
    pageById,
    evidenceById,
    captureOfEvidence,
    capturePage,
    captureAll,
    drawerPageId,
    drawerCaptureId,
    openPage,
    selectCapture,
    closeDrawer,
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
