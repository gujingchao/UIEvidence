<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  FEATURE_KIND_LABELS,
  REQUIREMENT_CATEGORY_LABELS,
  type Feature,
  type FeatureKind,
  type RequirementCategory,
} from '@uievidence/shared';
import { api } from '../api';
import { useProjectStore } from '../store';
import { tabPath } from '../tabs';
import { notify } from '../toast';

const props = defineProps<{ kinds: FeatureKind[]; title: string; hint: string; emptyHint: string }>();
const store = useProjectStore();

const filter = ref<'all' | 'pending' | 'rejected'>('all');
const editing = ref<Feature | 'new' | null>(null);

const draft = ref({
  name: '',
  description: '',
  kind: props.kinds[0] as FeatureKind,
  category: '' as RequirementCategory | '',
  acceptance: '',
  pageIds: [] as number[],
  evidenceIds: [] as number[],
});

const items = computed(() =>
  store.features.value
    .filter((f) => props.kinds.includes(f.kind))
    .filter((f) => (filter.value === 'all' ? f.status !== 'rejected' : f.status === filter.value)),
);
const pendingCount = computed(() => store.features.value.filter((f) => props.kinds.includes(f.kind) && f.status === 'pending').length);

function openEditor(target: Feature | 'new') {
  editing.value = target;
  if (target === 'new') {
    draft.value = { name: '', description: '', kind: props.kinds[0] as FeatureKind, category: '', acceptance: '', pageIds: [], evidenceIds: [] };
  } else {
    draft.value = {
      name: target.name,
      description: target.description,
      kind: target.kind,
      category: target.category ?? '',
      acceptance: target.acceptance,
      pageIds: [...target.pageIds],
      evidenceIds: [...target.evidenceIds],
    };
  }
}

const toggleIn = (list: number[], id: number) => {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
};

async function save() {
  const d = draft.value;
  if (!d.name.trim()) return notify('请填写名称', 'error');
  const category = d.kind === 'requirement' && d.category ? d.category : null;
  try {
    if (editing.value === 'new') {
      await api.createFeature(store.projectId, {
        name: d.name.trim(),
        description: d.description,
        kind: d.kind,
        category,
        acceptance: d.acceptance,
        pageIds: d.pageIds,
        evidenceIds: d.evidenceIds,
      });
    } else if (editing.value) {
      const id = editing.value.id;
      await api.updateFeature(id, { name: d.name.trim(), description: d.description, kind: d.kind, category, acceptance: d.acceptance });
      await api.setLinks(id, d.pageIds, d.evidenceIds);
    }
    editing.value = null;
    await store.loadFeatures();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function setStatus(f: Feature, status: 'accepted' | 'rejected') {
  try {
    await api.updateFeature(f.id, { status });
    await store.loadFeatures();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function remove(f: Feature) {
  if (!confirm(`删除“${f.name}”?`)) return;
  try {
    await api.deleteFeature(f.id);
    await store.loadFeatures();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

/** 点证据编号:打开它所属的页面,并定位到那一次采集 */
function openEvidence(evidenceId: number) {
  const c = store.captureOfEvidence(evidenceId);
  if (c) store.openPage(c.pageId, c.id);
}

const evidenceLabel = (id: number) => {
  const e = store.evidenceById(id);
  const c = store.captureOfEvidence(id);
  const page = c ? store.pageById(c.pageId) : undefined;
  return `${e?.code ?? '?'} ${c?.stateLabel ? `[${c.stateLabel}] ` : ''}${page?.title || page?.url || ''}`;
};
</script>

<template>
  <div class="panel">
    <div class="row between">
      <div>
        <h2>{{ title }}</h2>
        <div class="muted small">{{ hint }}</div>
      </div>
      <button class="primary" @click="openEditor('new')">新建条目</button>
    </div>
    <div class="row small" style="margin-top: 10px">
      <label><input v-model="filter" type="radio" value="all" /> 全部</label>
      <label><input v-model="filter" type="radio" value="pending" /> 待采纳 ({{ pendingCount }})</label>
      <label><input v-model="filter" type="radio" value="rejected" /> 已拒绝</label>
    </div>
  </div>

  <div v-if="!items.length" class="empty panel">
    <div>{{ filter === 'all' ? '这里还没有条目。' : '没有符合筛选条件的条目。' }}</div>
    <div class="small" style="margin: 6px auto 12px; max-width: 520px">{{ emptyHint }}</div>
    <div class="row" style="justify-content: center">
      <router-link v-if="kinds.includes('observed')" class="btn primary" :to="{ path: tabPath(store.projectId, 'pages'), query: {} }">去页面与证据,从采集结果创建</router-link>
      <button :class="{ primary: !kinds.includes('observed') }" @click="openEditor('new')">手动新建条目</button>
    </div>
  </div>

  <div v-for="f in items" :key="f.id" class="feature" :class="[`k-${f.kind}`, { 'is-pending': f.status === 'pending' }]">
    <div class="row between">
      <div>
        <strong>{{ f.name }}</strong>
        <span class="badge" :class="f.kind" style="margin-left: 6px">{{ FEATURE_KIND_LABELS[f.kind] }}</span>
        <span v-if="f.category" class="badge" style="margin-left: 4px">{{ REQUIREMENT_CATEGORY_LABELS[f.category] }}</span>
        <span v-if="f.source === 'ai'" class="badge pending" style="margin-left: 4px">AI 建议</span>
        <span v-if="f.status === 'pending'" class="badge pending" style="margin-left: 4px">待采纳</span>
      </div>
      <div class="row">
        <template v-if="f.status === 'pending'">
          <button class="primary" @click="setStatus(f, 'accepted')">采纳</button>
          <button @click="setStatus(f, 'rejected')">拒绝</button>
        </template>
        <button v-else-if="f.status === 'rejected'" @click="setStatus(f, 'accepted')">恢复</button>
        <button class="link" @click="openEditor(f)">编辑</button>
        <button class="link danger" @click="remove(f)">删除</button>
      </div>
    </div>
    <div v-if="f.description" style="margin: 4px 0; white-space: pre-wrap">{{ f.description }}</div>
    <div v-if="f.acceptance" class="small"><span class="muted">候选验收条件:</span>{{ f.acceptance }}</div>
    <div v-if="f.pageIds.length || f.evidenceIds.length" class="small" style="margin-top: 4px">
      <button v-for="id in f.pageIds" :key="'p' + id" class="chip" :title="'查看这个页面的证据:' + store.pageById(id)?.url" @click="store.openPage(id)">
        {{ store.pageById(id)?.title || store.pageById(id)?.url }}
      </button>
      <button v-for="id in f.evidenceIds" :key="'e' + id" class="chip evidence" :title="evidenceLabel(id)" @click="openEvidence(id)">
        {{ store.evidenceById(id)?.code }}
      </button>
    </div>
  </div>

  <template v-if="editing">
    <div class="overlay" @click="editing = null"></div>
    <form class="modal stack" @submit.prevent="save">
      <h2>{{ editing === 'new' ? '新建条目' : '编辑条目' }}</h2>
      <label class="field"><span>名称</span><input v-model="draft.name" type="text" /></label>
      <div class="row">
        <label class="field grow">
          <span>类型</span>
          <select v-model="draft.kind">
            <option v-for="k in kinds" :key="k" :value="k">{{ FEATURE_KIND_LABELS[k] }}</option>
          </select>
        </label>
        <label v-if="draft.kind === 'requirement'" class="field grow">
          <span>分类</span>
          <select v-model="draft.category">
            <option value="">未分类</option>
            <option v-for="(label, key) in REQUIREMENT_CATEGORY_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
      </div>
      <label class="field"><span>说明</span><textarea v-model="draft.description"></textarea></label>
      <label class="field"><span>候选验收条件(可选)</span><textarea v-model="draft.acceptance" style="min-height: 56px"></textarea></label>

      <div>
        <strong>关联页面</strong>
        <div v-if="!store.pages.value.length" class="muted small">还没有页面</div>
        <label v-for="p in store.pages.value" :key="p.id" class="row small">
          <input type="checkbox" :checked="draft.pageIds.includes(p.id)" @change="toggleIn(draft.pageIds, p.id)" />
          <span>{{ p.title || p.url }}</span>
        </label>
      </div>
      <div>
        <strong>关联证据</strong>
        <div v-if="!store.evidence.value.length" class="muted small">还没有证据,先去采集页面</div>
        <label v-for="e in store.evidence.value" :key="e.id" class="row small">
          <input type="checkbox" :checked="draft.evidenceIds.includes(e.id)" @change="toggleIn(draft.evidenceIds, e.id)" />
          <span>{{ evidenceLabel(e.id) }}</span>
        </label>
      </div>

      <div class="row">
        <button class="primary" type="submit">保存</button>
        <button type="button" @click="editing = null">取消</button>
      </div>
    </form>
  </template>

</template>
