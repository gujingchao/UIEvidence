<script setup lang="ts">
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { tabPath, type TabKey } from '../tabs';
import { useProjectStore } from '../store';
import LoginCard from './LoginCard.vue';

const store = useProjectStore();

const to = (tab: TabKey): RouteLocationRaw => ({ path: tabPath(store.projectId, tab), query: {} });

const pagesCount = computed(() => store.pages.value.length);
const capturedCount = computed(() => store.pages.value.filter((p) => p.lastCaptureStatus === 'success' || p.lastCaptureStatus === 'partial').length);
const loginBlocked = computed(() => store.pages.value.filter((p) => p.lastCaptureStatus === 'login_required').length);
const failedCount = computed(() => store.pages.value.filter((p) => p.lastCaptureStatus === 'failed').length);
const waiting = computed(() => store.pages.value.filter((p) => !p.lastCaptureStatus).length);

const accepted = computed(() => store.features.value.filter((f) => f.status === 'accepted'));
const pageFeatures = computed(() => accepted.value.filter((f) => f.kind === 'observed' || f.kind === 'inferred').length);
const needFeatures = computed(() => accepted.value.filter((f) => f.kind === 'requirement' || f.kind === 'question').length);
const pending = computed(() => store.features.value.filter((f) => f.status === 'pending').length);
const openGaps = computed(() => store.gaps.value.filter((g) => !g.resolved).length);

interface Step {
  n: number;
  title: string;
  hint: string;
  done: boolean;
  summary: string;
  button: string;
  to?: RouteLocationRaw;
  click?: () => void;
}

const steps = computed<Step[]>(() => [
  {
    n: 1,
    title: '添加要分析的页面',
    hint: '只需要一个入口页,其余页面采集后可以一键加入。',
    done: pagesCount.value > 0,
    summary: `已有 ${pagesCount.value} 个页面`,
    button: pagesCount.value ? '继续添加' : '去添加页面',
    to: to('pages'),
  },
  {
    n: 2,
    title: '采集页面,保存证据',
    hint: '浏览器会逐个打开页面,保存截图和页面结构。只读,不会提交或删除任何东西。',
    done: pagesCount.value > 0 && capturedCount.value === pagesCount.value,
    summary: pagesCount.value ? `${capturedCount.value} / ${pagesCount.value} 个页面已采集` : '还没有页面可采集',
    button: waiting.value ? `采集 ${waiting.value} 个新页面` : '重新采集全部',
    click: () => void store.captureAll(waiting.value > 0),
  },
  {
    n: 3,
    title: '整理页面功能',
    hint: '把看到的功能整理成条目,每条都关联到来源页面和截图。',
    done: pageFeatures.value > 0,
    summary: `${pageFeatures.value} 条功能`,
    button: '去整理功能',
    to: to('features'),
  },
  {
    n: 4,
    title: '补充需求和待确认问题',
    hint: '前台看不到的(后台管理、角色权限、数据要求)和要问客户的问题。',
    done: needFeatures.value > 0,
    summary: `${needFeatures.value} 条`,
    button: '去补充',
    to: to('requirements'),
  },
  {
    n: 5,
    title: '导出分析报告',
    hint: '生成 HTML、Markdown 和带截图的材料包,可以交给没参与分析的人看。',
    done: false,
    summary: '',
    button: '去导出',
    to: to('export'),
  },
]);

const nextStep = computed(() => steps.value.find((s) => !s.done && (s.n !== 2 || pagesCount.value > 0)) ?? steps.value[4]!);
</script>

<template>
  <div class="panel">
    <h2>下一步</h2>
    <div class="muted small" style="margin-bottom: 12px">按下面的顺序做就行。高亮的是现在该做的一步。</div>

    <ol class="flow">
      <li v-for="s in steps" :key="s.n" :class="{ done: s.done, next: s.n === nextStep.n }">
        <span class="flow-n">{{ s.done ? '✓' : s.n }}</span>
        <div class="flow-body">
          <div class="flow-title">{{ s.title }} <span v-if="s.summary" class="muted small">· {{ s.summary }}</span></div>
          <div class="muted small">{{ s.hint }}</div>
        </div>
        <router-link v-if="s.to" :to="s.to" class="btn" :class="{ primary: s.n === nextStep.n }">{{ s.button }}</router-link>
        <button v-else :class="{ primary: s.n === nextStep.n }" :disabled="!pagesCount || store.busy.value" @click="s.click?.()">
          {{ store.busy.value && s.n === 2 ? '采集中…' : s.button }}
        </button>
      </li>
    </ol>
  </div>

  <!-- 需要你处理的事 -->
  <div v-if="loginBlocked || store.discovered.value.length || failedCount || pending || openGaps" class="panel">
    <h2>需要你处理</h2>
    <ul class="todo">
      <li v-if="loginBlocked" class="urgent">
        <span><strong>{{ loginBlocked }} 个页面被挡在登录页外</strong>,需要先登录才能采集。在下面的“登录状态”里登录,再重新采集。</span>
        <router-link :to="to('pages')" class="btn">查看这些页面</router-link>
      </li>
      <li v-if="store.discovered.value.length">
        <span>已采集的页面里发现了 <strong>{{ store.discovered.value.length }} 个</strong>还没加入的页面。</span>
        <router-link :to="to('pages')" class="btn">去加入</router-link>
      </li>
      <li v-if="failedCount">
        <span>{{ failedCount }} 个页面采集失败,可以看原因后重试。</span>
        <router-link :to="to('pages')" class="btn">查看</router-link>
      </li>
      <li v-if="pending">
        <span>有 <strong>{{ pending }} 条 AI 建议</strong>等你采纳或拒绝,采纳前不会进入报告。</span>
        <router-link :to="to('features')" class="btn">去处理</router-link>
      </li>
      <li v-if="openGaps">
        <span>{{ openGaps }} 个分析缺口还没处理(没执行的交互、被拦截的请求等),会写进报告。</span>
        <router-link :to="to('gaps')" class="btn">查看</router-link>
      </li>
    </ul>
  </div>

  <LoginCard :highlight="loginBlocked > 0" />
</template>
