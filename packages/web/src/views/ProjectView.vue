<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { createProjectStore, provideProjectStore } from '../store';
import PagesTab from '../components/PagesTab.vue';
import FeatureList from '../components/FeatureList.vue';
import GapsTab from '../components/GapsTab.vue';
import PlanTab from '../components/PlanTab.vue';
import ExportTab from '../components/ExportTab.vue';
import SettingsTab from '../components/SettingsTab.vue';

const props = defineProps<{ id: number }>();

const store = createProjectStore(props.id);
provideProjectStore(store);
onMounted(store.loadAll);

const tab = ref<'pages' | 'features' | 'requirements' | 'gaps' | 'plan' | 'export' | 'settings'>('pages');

const pendingCount = computed(() => store.features.value.filter((f) => f.status === 'pending').length);
const openGaps = computed(() => store.gaps.value.filter((g) => !g.resolved).length);

const tabs = computed(() => [
  { key: 'pages', label: '页面与证据' },
  { key: 'features', label: pendingCount.value ? `功能整理(${pendingCount.value} 待采纳)` : '功能整理' },
  { key: 'requirements', label: '需求与待确认' },
  { key: 'gaps', label: openGaps.value ? `分析缺口(${openGaps.value})` : '分析缺口' },
  { key: 'plan', label: '初步方案' },
  { key: 'export', label: '导出' },
  { key: 'settings', label: '设置' },
] as const);
</script>

<template>
  <div v-if="store.project.value">
    <div class="row between" style="margin-bottom: 8px">
      <div>
        <h1>
          {{ store.project.value.name }}
          <span v-if="store.project.value.archived" class="badge">已归档</span>
        </h1>
        <div class="small muted">
          允许分析:
          <span v-for="d in store.project.value.allowedDomains" :key="d" class="chip">{{ d }}</span>
        </div>
      </div>
      <router-link to="/">← 全部项目</router-link>
    </div>

    <div v-if="store.project.value.archived" class="notice info">项目已归档,不能再采集新页面。可在“设置”里取消归档。</div>

    <nav class="tabs" role="tablist">
      <button v-for="t in tabs" :key="t.key" role="tab" :aria-selected="tab === t.key" :class="{ active: tab === t.key }" @click="tab = t.key">
        {{ t.label }}
      </button>
    </nav>

    <PagesTab v-if="tab === 'pages'" />
    <FeatureList
      v-else-if="tab === 'features'"
      :kinds="['observed', 'inferred']"
      title="页面功能"
      hint="这里记录从页面上看到的功能(已观察事实),以及根据界面推断但还没验证的功能(推测功能)。"
    />
    <FeatureList
      v-else-if="tab === 'requirements'"
      :kinds="['requirement', 'question']"
      title="补充需求与待确认问题"
      hint="前台页面看不到的内容(后台管理、角色权限、数据要求、通知方式、外部对接),以及需要向客户确认的问题。"
    />
    <GapsTab v-else-if="tab === 'gaps'" />
    <PlanTab v-else-if="tab === 'plan'" />
    <ExportTab v-else-if="tab === 'export'" />
    <SettingsTab v-else />
  </div>
  <div v-else-if="store.loading.value" class="empty">加载中…</div>
  <div v-else class="empty">项目不存在。<router-link to="/">返回</router-link></div>
</template>
