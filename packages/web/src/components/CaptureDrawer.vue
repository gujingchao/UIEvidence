<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FEATURE_KIND_LABELS, groupDuplicates, type AiProviderInfo, type Capture, type Page, type PageStructure, type StructureInteraction } from '@uievidence/shared';
import { api, evidenceUrl, type Candidate } from '../api';
import { CAPTURE_STATUS_LABELS, fmtTime, INTERACTION_LABELS, shortUrl } from '../labels';
import { useProjectStore } from '../store';
import { tabPath } from '../tabs';
import { notify } from '../toast';
import LoginCard from './LoginCard.vue';

const props = defineProps<{ page: Page }>();

const store = useProjectStore();

const captures = computed(() => store.captures.value.filter((c) => c.pageId === props.page.id));
const selected = computed<Capture | null>(() => {
  const wanted = store.drawerCaptureId.value;
  return (
    captures.value.find((c) => c.id === wanted) ??
    captures.value.find((c) => c.evidenceId) ?? // 默认看最新的有证据的采集
    captures.value[0] ??
    null
  );
});

/** 这次采集之后,使用者又登录过了:提示直接重新采集,而不是再让人去登录 */
const loggedInSince = computed(() => {
  const setAt = store.project.value?.loginSetAt;
  const done = selected.value?.finishedAt;
  return !!setAt && !!done && setAt > done;
});

// 在页面清单里的前一个、后一个页面,方便连续查看
const siblings = computed(() => {
  const list = store.pages.value;
  const i = list.findIndex((p) => p.id === props.page.id);
  return { prev: i > 0 ? list[i - 1] : undefined, next: i >= 0 ? list[i + 1] : undefined, index: i + 1, total: list.length };
});

const structure = ref<PageStructure | null>(null);
const formFieldText = (f: PageStructure['forms'][number]) =>
  f.fields.map((x) => (x.label || x.name) + (x.required ? '*' : '')).join('、') || '无字段';
const formGroups = computed(() =>
  groupDuplicates(structure.value?.forms ?? [], (f) => `${f.submitText}|${f.method}|${formFieldText(f)}|${f.action}`),
);
const blockedGroups = computed(() => groupDuplicates(structure.value?.blocked ?? [], (b) => `${b.text}|${b.reason}`));
const candidates = ref<Candidate[]>([]);
const checked = ref<Set<number>>(new Set());
const zoom = ref(false);

const providers = ref<AiProviderInfo[]>([]);
const aiProvider = ref('');
const aiModel = ref('');
const aiBusy = ref(false);

const archived = computed(() => store.project.value?.archived ?? false);
const allowAi = computed(() => store.project.value?.allowAi ?? false);
const currentProvider = computed(() => providers.value.find((p) => p.id === aiProvider.value));

const onKey = (e: KeyboardEvent) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !zoom.value) store.closeDrawer();
  if (e.key === 'Escape' && zoom.value) zoom.value = false;
};
onMounted(async () => {
  window.addEventListener('keydown', onKey);
  const health = await api.health().catch(() => null);
  providers.value = health?.providers ?? [];
  const configured = providers.value.find((p) => p.configured);
  aiProvider.value = configured?.id ?? providers.value[0]?.id ?? '';
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

watch(
  () => [selected.value?.id, selected.value?.status] as const,
  async () => {
    structure.value = null;
    candidates.value = [];
    checked.value = new Set();
    const c = selected.value;
    if (!c?.evidenceId) return;
    structure.value = await api.structure(c.id).catch(() => null);
    candidates.value = await api.candidates(c.id).catch(() => []);
    checked.value = new Set(candidates.value.map((_, i) => i));
  },
  { immediate: true },
);

async function captureState(i: StructureInteraction) {
  try {
    const created = await api.capture(props.page.id, { ...store.captureOptions(), interaction: { type: i.type, selector: i.selector } });
    await store.loadCaptures();
    store.selectCapture(created.id);
    notify(`已开始采集:${INTERACTION_LABELS[i.type]}「${i.text}」`, 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function recapture() {
  if (await store.capturePage(props.page)) {
    const latest = store.captures.value.find((c) => c.pageId === props.page.id);
    if (latest) store.selectCapture(latest.id);
  }
}

async function createFeatures() {
  const c = selected.value;
  if (!c) return;
  const picked = candidates.value.filter((_, i) => checked.value.has(i));
  if (!picked.length) return;
  try {
    for (const cand of picked) {
      await api.createFeature(store.projectId, {
        name: cand.name,
        description: cand.description,
        kind: cand.kind,
        pageIds: [props.page.id],
        evidenceIds: c.evidenceId ? [c.evidenceId] : [],
      });
    }
    await store.loadFeatures();
    checked.value = new Set();
    notify(`已创建 ${picked.length} 条功能条目`, 'ok', { label: '去功能整理查看', to: { path: tabPath(store.projectId, 'features'), query: {} } });
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function runAi() {
  const c = selected.value;
  if (!c) return;
  aiBusy.value = true;
  try {
    const r = await api.aiAnalyze(store.projectId, { captureId: c.id, provider: aiProvider.value, model: aiModel.value.trim() || undefined });
    await store.loadFeatures();
    notify(`AI 给出 ${r.count} 条建议,等你采纳${r.sentScreenshot ? '' : '(截图过大,只发送了页面结构)'}`, 'ok', {
      label: '去处理',
      to: { path: tabPath(store.projectId, 'features'), query: {} },
    });
  } catch (err) {
    notify((err as Error).message, 'error');
  } finally {
    aiBusy.value = false;
  }
}

const toggle = (i: number) => {
  const next = new Set(checked.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  checked.value = next;
};
</script>

<template>
  <div class="overlay" @click="store.closeDrawer()"></div>
  <aside class="drawer" role="dialog" aria-label="页面证据">
    <div class="row between drawer-head">
      <div class="row">
        <button :disabled="!siblings.prev" title="上一个页面" aria-label="上一个页面" @click="siblings.prev && store.openPage(siblings.prev.id)">‹</button>
        <span class="muted small">{{ siblings.index }} / {{ siblings.total }}</span>
        <button :disabled="!siblings.next" title="下一个页面" aria-label="下一个页面" @click="siblings.next && store.openPage(siblings.next.id)">›</button>
      </div>
      <button @click="store.closeDrawer()">关闭(Esc)</button>
    </div>

    <h2 style="margin-top: 10px">{{ page.title || shortUrl(page.url) }}</h2>
    <div class="mono muted" style="margin-bottom: 12px">{{ page.url }}</div>

    <!-- 被挡在登录页外:直接在这里登录 -->
    <template v-if="selected?.status === 'login_required'">
      <div v-if="loggedInSince" class="notice info">
        <strong>这次采集时还没有登录,现在已经登录过了。</strong>点下面的“重新采集这个页面”就能采到登录后的内容。
      </div>
      <div v-else class="notice">
        <strong>这个页面需要登录。</strong>{{ selected.error }}
        <div class="small" style="margin-top: 4px">下面的截图是被跳转到的登录页。登录后,点“重新采集”。</div>
      </div>
      <LoginCard :highlight="!loggedInSince" />
      <div class="row" style="margin-bottom: 12px"><button class="primary" :disabled="archived || store.busy.value" @click="recapture">重新采集这个页面</button></div>
    </template>

    <div class="panel">
      <div class="row between">
        <h3>采集记录(每次采集单独保存,不覆盖旧证据)</h3>
        <button :disabled="archived || store.busy.value" @click="recapture">再采集一次</button>
      </div>
      <ul class="timeline">
        <li v-for="c in captures" :key="c.id" :class="{ sel: c.id === selected?.id }" @click="store.selectCapture(c.id)">
          <div class="row between">
            <span>
              <span class="badge" :class="c.status">{{ CAPTURE_STATUS_LABELS[c.status] }}</span>
              <strong v-if="c.evidenceCode"> {{ c.evidenceCode }}</strong>
              {{ c.stateLabel || '页面初始状态' }}
            </span>
            <span class="muted small">{{ fmtTime(c.startedAt) }}</span>
          </div>
          <div v-if="c.error && c.status !== 'login_required'" class="small" style="color: var(--bad)">{{ c.error }}</div>
        </li>
      </ul>
    </div>

    <template v-if="selected">
      <details class="panel">
        <summary>采集上下文</summary>
        <div class="small stack" style="margin-top: 8px">
          <div>状态:{{ CAPTURE_STATUS_LABELS[selected.status] }}<span v-if="selected.httpStatus"> · HTTP {{ selected.httpStatus }}</span></div>
          <div>时间:{{ fmtTime(selected.startedAt) }} → {{ fmtTime(selected.finishedAt) }}</div>
          <div>视口:{{ selected.viewport.width }}×{{ selected.viewport.height }} · 浏览器:{{ selected.browser || '—' }}</div>
          <div v-if="selected.finalUrl && selected.finalUrl !== selected.url" class="mono">最终网址:{{ selected.finalUrl }}</div>
          <div v-if="selected.error && selected.status !== 'login_required'" style="color: var(--bad)">失败原因:{{ selected.error }}</div>
          <ul v-if="selected.notes.length" style="margin: 0; padding-left: 18px">
            <li v-for="n in selected.notes" :key="n">{{ n }}</li>
          </ul>
        </div>
      </details>

      <details v-if="selected.evidenceId" class="panel" open>
        <summary>截图(点击放大)</summary>
        <div class="shot-box" style="margin-top: 8px">
          <img class="shot" :src="evidenceUrl(selected.evidenceId, 'screenshot')" :alt="`${selected.evidenceCode} 截图`" @click="zoom = true" />
        </div>
        <div class="small muted" style="margin-top: 6px">
          <a :href="evidenceUrl(selected.evidenceId, 'dom')" target="_blank" rel="noopener">查看页面快照(纯文本)</a>
        </div>
      </details>

      <details v-if="structure" class="panel" open>
        <summary>页面结构与可采集的其他状态</summary>
        <div class="small stack" style="margin-top: 8px">
          <div v-if="structure.headings.length"><strong>标题:</strong>{{ structure.headings.slice(0, 6).map((h) => h.text).join(' / ') }}</div>
          <div v-if="structure.nav.length"><strong>导航:</strong>{{ structure.nav.map((n) => n.text).join('、') }}</div>
          <div v-for="(g, i) in formGroups" :key="i">
            <strong>表单({{ g.item.method.toUpperCase() }}):</strong>
            <template v-if="g.item.submitText">「{{ g.item.submitText }}」</template>{{ formFieldText(g.item) }}<span v-if="g.count > 1" class="muted"> ×{{ g.count }}</span>
          </div>
          <div v-for="(l, i) in structure.lists" :key="'l' + i"><strong>{{ { list: '列表', table: '表格', cards: '卡片' }[l.kind] }}:</strong>{{ l.itemCount }} 项</div>
        </div>

        <h3 style="margin-top: 14px">可采集的其他状态</h3>
        <div v-if="!structure.interactions.length" class="muted small">没有识别到可安全执行的交互(Tab、分页、弹窗展开)。</div>
        <div v-for="i in structure.interactions" :key="i.selector" class="row small" style="margin-bottom: 4px">
          <span class="badge">{{ INTERACTION_LABELS[i.type] }}</span>
          <span class="grow">{{ i.text || '(无文字)' }}</span>
          <button :disabled="archived" @click="captureState(i)">采集此状态</button>
        </div>

        <h3 style="margin-top: 14px">看到但没有执行的入口</h3>
        <div v-if="!structure.blocked.length" class="muted small">无。</div>
        <div v-for="(g, i) in blockedGroups" :key="i" class="small">
          <strong>「{{ g.item.text }}」</strong><span v-if="g.count > 1" class="muted"> ×{{ g.count }}</span
          ><span class="muted">{{ ' ' + g.item.reason }}</span>
        </div>
      </details>

      <div v-if="candidates.length" class="panel">
        <div class="row between">
          <h3>功能候选(根据页面结构自动列出)</h3>
          <button class="primary" :disabled="!checked.size" @click="createFeatures">创建 {{ checked.size }} 条功能条目</button>
        </div>
        <div v-for="(c, i) in candidates" :key="i" class="row small" style="align-items: flex-start; margin-bottom: 6px">
          <input type="checkbox" :checked="checked.has(i)" @change="toggle(i)" />
          <div class="grow">
            <strong>{{ c.name }}</strong> <span class="badge" :class="c.kind">{{ FEATURE_KIND_LABELS[c.kind] }}</span>
            <div class="muted">{{ c.description }}</div>
          </div>
        </div>
      </div>

      <details v-if="selected.evidenceId" class="panel">
        <summary>AI 分析(可选)</summary>
        <div style="margin-top: 8px">
          <div v-if="!allowAi" class="muted small">
            这个项目没有开启“允许发送内容给模型”。AI 分析会把页面结构和截图发送给第三方模型服务,需要在“设置”里手动开启。
          </div>
          <div v-else class="stack">
            <div class="row">
              <select v-model="aiProvider" style="width: auto">
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.configured ? '' : '(未配置密钥)' }}</option>
              </select>
              <input v-model="aiModel" type="text" :placeholder="`模型,默认 ${currentProvider?.defaultModel ?? ''}`" class="grow" />
              <button class="primary" :disabled="aiBusy || !currentProvider?.configured" @click="runAi">{{ aiBusy ? '分析中…' : '让 AI 分析' }}</button>
            </div>
            <div v-if="currentProvider && !currentProvider.configured" class="small muted">{{ currentProvider.hint }}</div>
            <div class="small muted">AI 的结果只会作为“待采纳”的条目放进功能整理,由你确认后才会进入报告。</div>
          </div>
        </div>
      </details>
    </template>
  </aside>

  <div v-if="zoom && selected?.evidenceId" class="lightbox" @click="zoom = false">
    <img :src="evidenceUrl(selected.evidenceId, 'screenshot')" :alt="`${selected.evidenceCode} 截图`" />
  </div>
</template>
