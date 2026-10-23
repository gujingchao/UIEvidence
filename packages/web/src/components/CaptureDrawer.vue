<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { FEATURE_KIND_LABELS, type AiProviderInfo, type Capture, type Page, type PageStructure, type StructureInteraction } from '@uievidence/shared';
import { api, evidenceUrl, type CaptureOptions, type Candidate } from '../api';
import { CAPTURE_STATUS_LABELS, fmtTime, INTERACTION_LABELS } from '../labels';
import { useProjectStore } from '../store';
import { notify } from '../toast';

const props = defineProps<{ page: Page; captureOptions: () => CaptureOptions }>();
const emit = defineEmits<{ close: [] }>();

const store = useProjectStore();

const captures = computed(() => store.captures.value.filter((c) => c.pageId === props.page.id));
const selectedId = ref<number | null>(null);
const selected = computed<Capture | null>(() => captures.value.find((c) => c.id === selectedId.value) ?? null);

const structure = ref<PageStructure | null>(null);
const candidates = ref<Candidate[]>([]);
const checked = ref<Set<number>>(new Set());
const zoom = ref(false);

const providers = ref<AiProviderInfo[]>([]);
const aiProvider = ref('');
const aiModel = ref('');
const aiBusy = ref(false);

const archived = computed(() => store.project.value?.archived ?? false);
const allowAi = computed(() => store.project.value?.allowAi ?? false);

onMounted(async () => {
  const first = captures.value.find((c) => c.evidenceId) ?? captures.value[0];
  selectedId.value = first?.id ?? null;
  const health = await api.health().catch(() => null);
  providers.value = health?.providers ?? [];
  const configured = providers.value.find((p) => p.configured);
  aiProvider.value = configured?.id ?? providers.value[0]?.id ?? '';
});

watch(
  () => [selected.value?.id, selected.value?.status],
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

const currentProvider = computed(() => providers.value.find((p) => p.id === aiProvider.value));

async function captureState(i: StructureInteraction) {
  try {
    await api.capture(props.page.id, { ...props.captureOptions(), interaction: { type: i.type, selector: i.selector } });
    await store.loadCaptures();
    notify(`已开始采集:${INTERACTION_LABELS[i.type]}「${i.text}」`, 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
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
    notify(`已创建 ${picked.length} 条功能条目,可在“功能整理”里继续编辑`, 'ok');
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
    notify(`AI 给出 ${r.count} 条建议,已放入“功能整理”等待你采纳${r.sentScreenshot ? '' : '(截图过大,只发送了页面结构)'}`, 'ok');
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
  <div class="overlay" @click="emit('close')"></div>
  <aside class="drawer" role="dialog" aria-label="页面证据">
    <div class="row between" style="margin-bottom: 10px">
      <div>
        <h2>{{ page.title || page.url }}</h2>
        <div class="mono muted">{{ page.url }}</div>
      </div>
      <button @click="emit('close')">关闭</button>
    </div>

    <div class="panel">
      <h3>采集记录(每次采集单独保存,不覆盖旧证据)</h3>
      <ul class="timeline">
        <li v-for="c in captures" :key="c.id" :class="{ sel: c.id === selectedId }" @click="selectedId = c.id">
          <div class="row between">
            <span>
              <span class="badge" :class="c.status">{{ CAPTURE_STATUS_LABELS[c.status] }}</span>
              <strong v-if="c.evidenceCode"> {{ c.evidenceCode }}</strong>
              {{ c.stateLabel || '页面初始状态' }}
            </span>
            <span class="muted small">{{ fmtTime(c.startedAt) }}</span>
          </div>
          <div v-if="c.error" class="small" style="color: var(--bad)">{{ c.error }}</div>
        </li>
      </ul>
    </div>

    <template v-if="selected">
      <div class="panel">
        <h3>采集上下文</h3>
        <div class="small stack">
          <div>状态:{{ CAPTURE_STATUS_LABELS[selected.status] }}<span v-if="selected.httpStatus"> · HTTP {{ selected.httpStatus }}</span></div>
          <div>时间:{{ fmtTime(selected.startedAt) }} → {{ fmtTime(selected.finishedAt) }}</div>
          <div>视口:{{ selected.viewport.width }}×{{ selected.viewport.height }} · 浏览器:{{ selected.browser || '—' }}</div>
          <div v-if="selected.finalUrl && selected.finalUrl !== selected.url" class="mono">最终网址:{{ selected.finalUrl }}</div>
          <div v-if="selected.error" style="color: var(--bad)">失败原因:{{ selected.error }}</div>
          <ul v-if="selected.notes.length" style="margin: 0; padding-left: 18px">
            <li v-for="n in selected.notes" :key="n">{{ n }}</li>
          </ul>
        </div>
      </div>

      <div v-if="selected.evidenceId" class="panel">
        <h3>截图(点击放大)</h3>
        <div class="shot-box">
          <img class="shot" :src="evidenceUrl(selected.evidenceId, 'screenshot')" :alt="`${selected.evidenceCode} 截图`" @click="zoom = true" />
        </div>
        <div class="small muted" style="margin-top: 6px">
          <a :href="evidenceUrl(selected.evidenceId, 'dom')" target="_blank" rel="noopener">查看页面快照(纯文本)</a>
        </div>
      </div>

      <div v-if="structure" class="panel">
        <h3>页面结构</h3>
        <div class="small stack">
          <div v-if="structure.headings.length"><strong>标题:</strong>{{ structure.headings.slice(0, 6).map((h) => h.text).join(' / ') }}</div>
          <div v-if="structure.nav.length"><strong>导航:</strong>{{ structure.nav.map((n) => n.text).join('、') }}</div>
          <div v-for="(f, i) in structure.forms" :key="i">
            <strong>表单({{ f.method.toUpperCase() }}):</strong>
            {{ f.fields.map((x) => (x.label || x.name) + (x.required ? '*' : '')).join('、') || '无字段' }}
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
        <div v-for="(b, i) in structure.blocked" :key="i" class="small">
          <strong>「{{ b.text }}」</strong><span class="muted"> {{ b.reason }}</span>
        </div>
      </div>

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

      <div v-if="selected.evidenceId" class="panel">
        <h3>AI 分析(可选)</h3>
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
    </template>
  </aside>

  <div v-if="zoom && selected?.evidenceId" class="lightbox" @click="zoom = false">
    <img :src="evidenceUrl(selected.evidenceId, 'screenshot')" :alt="`${selected.evidenceCode} 截图`" />
  </div>
</template>
