<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { createProjectStore, provideProjectStore } from '../store';
import { tabPath, type TabKey } from '../tabs';
import CaptureDrawer from '../components/CaptureDrawer.vue';
import ExportTab from '../components/ExportTab.vue';
import FeatureList from '../components/FeatureList.vue';
import GapsTab from '../components/GapsTab.vue';
import OverviewTab from '../components/OverviewTab.vue';
import PagesTab from '../components/PagesTab.vue';
import PlanTab from '../components/PlanTab.vue';
import SettingsTab from '../components/SettingsTab.vue';

const props = defineProps<{ id: number; tab: TabKey }>();

const store = createProjectStore(props.id);
provideProjectStore(store);
onMounted(store.loadAll);

const pendingCount = computed(() => store.features.value.filter((f) => f.status === 'pending').length);
const openGaps = computed(() => store.gaps.value.filter((g) => !g.resolved).length);
const needLogin = computed(() => store.pages.value.filter((p) => p.lastCaptureStatus === 'login_required').length);
const newPages = computed(() => store.discovered.value.length);

const tabs = computed<{ key: TabKey; label: string; dot?: boolean }[]>(() => [
  { key: 'overview', label: '概览', dot: needLogin.value > 0 },
  { key: 'pages', label: newPages.value ? `页面与证据(${newPages.value} 个新发现)` : '页面与证据' },
  { key: 'features', label: pendingCount.value ? `功能整理(${pendingCount.value} 待采纳)` : '功能整理' },
  { key: 'requirements', label: '需求与待确认' },
  { key: 'gaps', label: openGaps.value ? `分析缺口(${openGaps.value})` : '分析缺口' },
  { key: 'plan', label: '初步方案' },
  { key: 'export', label: '导出' },
  { key: 'settings', label: '设置' },
]);

const drawerPage = computed(() => (store.drawerPageId.value ? store.pageById(store.drawerPageId.value) : undefined));
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
      <router-link
        v-for="t in tabs"
        :key="t.key"
        role="tab"
        :to="{ path: tabPath(id, t.key), query: {} }"
        :aria-selected="tab === t.key"
        :class="{ active: tab === t.key }"
      >
        {{ t.label }}<span v-if="t.dot" class="dot" aria-label="有待处理的事"></span>
      </router-link>
    </nav>

    <OverviewTab v-if="tab === 'overview'" />
    <PagesTab v-else-if="tab === 'pages'" />
    <FeatureList
      v-else-if="tab === 'features'"
      :kinds="['observed', 'inferred']"
      title="页面功能"
      hint="这里记录从页面上看到的功能(已观察事实),以及根据界面推断但还没验证的功能(推测功能)。"
      empty-hint="功能条目通常从采集结果里创建:打开一个页面的证据,下面有根据页面结构列出的功能候选,勾选后一键创建。"
    />
    <FeatureList
      v-else-if="tab === 'requirements'"
      :kinds="['requirement', 'question']"
      title="补充需求与待确认问题"
      hint="前台页面看不到的内容(后台管理、角色权限、数据要求、通知方式、外部对接),以及需要向客户确认的问题。"
      empty-hint="比如:管理员需要按角色分配权限;是否存在不同的价格等级?点右上角“新建条目”开始记录。"
    />
    <GapsTab v-else-if="tab === 'gaps'" />
    <PlanTab v-else-if="tab === 'plan'" />
    <ExportTab v-else-if="tab === 'export'" />
    <SettingsTab v-else />

    <!-- 证据抽屉在任何标签页上都能打开,状态在地址里 -->
    <CaptureDrawer v-if="drawerPage" :page="drawerPage" />
  </div>
  <div v-else-if="store.loading.value" class="empty">加载中…</div>
  <div v-else class="empty">项目不存在。<router-link to="/">返回</router-link></div>
</template>
