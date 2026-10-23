<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Page } from '@uievidence/shared';
import { api } from '../api';
import { CAPTURE_STATUS_LABELS } from '../labels';
import { useProjectStore } from '../store';
import { notify } from '../toast';
import CaptureDrawer from './CaptureDrawer.vue';

const store = useProjectStore();

const newUrl = ref('');
const adding = ref(false);
const advanced = ref(false);
const timeoutSec = ref(30);
const waitSelector = ref('');
const width = ref(1280);
const height = ref(800);
const openPageId = ref<number | null>(null);

const archived = computed(() => store.project.value?.archived ?? false);
const openPage = computed(() => store.pages.value.find((p) => p.id === openPageId.value) ?? null);

const options = () => ({
  timeoutMs: Math.round(timeoutSec.value * 1000),
  waitSelector: waitSelector.value.trim() || null,
  viewport: { width: width.value, height: height.value },
});

async function add() {
  const lines = newUrl.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return;
  adding.value = true;
  let ok = 0;
  for (const url of lines) {
    try {
      await api.addPage(store.projectId, url);
      ok++;
    } catch (err) {
      notify(`${url}:${(err as Error).message}`, 'error');
    }
  }
  adding.value = false;
  if (ok) newUrl.value = '';
  await store.loadPages();
}

async function capture(page: Page) {
  try {
    await api.capture(page.id, options());
    await Promise.all([store.loadCaptures(), store.loadPages()]);
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function captureAll() {
  for (const p of store.pages.value) await capture(p);
}

async function remove(page: Page) {
  if (!confirm(`删除页面 ${page.url}?它的采集记录和证据会一起删除。`)) return;
  try {
    await api.deletePage(page.id);
    await Promise.all([store.loadPages(), store.loadCaptures(), store.loadEvidence(), store.loadFeatures()]);
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}
</script>

<template>
  <div class="panel">
    <h2>添加要分析的页面</h2>
    <form class="stack" @submit.prevent="add">
      <label class="field">
        <span>网址(每行一个)</span>
        <textarea v-model="newUrl" placeholder="https://example.com/courses" style="min-height: 56px"></textarea>
        <div class="hint">网址必须在项目的域名白名单内,否则无法添加。</div>
      </label>
      <div class="row">
        <button class="primary" type="submit" :disabled="adding || !newUrl.trim()">添加</button>
        <button type="button" class="link" @click="advanced = !advanced">{{ advanced ? '收起采集选项' : '采集选项' }}</button>
      </div>
      <div v-if="advanced" class="row">
        <label class="field grow"><span>超时(秒)</span><input v-model.number="timeoutSec" type="number" min="1" max="120" /></label>
        <label class="field grow"><span>视口宽</span><input v-model.number="width" type="number" min="320" max="3840" /></label>
        <label class="field grow"><span>视口高</span><input v-model.number="height" type="number" min="320" max="4000" /></label>
        <label class="field grow" style="flex-basis: 100%">
          <span>等待元素(可选)</span>
          <input v-model="waitSelector" type="text" placeholder="例如 .course-list,页面出现该元素后再采集" />
          <div class="hint">默认等页面加载完成且网络静止。内容靠接口异步加载时,可指定一个出现后即表示加载完成的元素。</div>
        </label>
      </div>
    </form>
  </div>

  <div class="panel">
    <div class="row between">
      <h2>页面清单</h2>
      <button :disabled="!store.pages.value.length || archived || store.busy.value" @click="captureAll">采集全部</button>
    </div>
    <div v-if="!store.pages.value.length" class="empty">还没有页面。先在上面添加网址。</div>
    <table v-else>
      <thead>
        <tr><th>页面</th><th>最近状态</th><th>采集次数</th><th style="width: 220px">操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="p in store.pages.value" :key="p.id">
          <td>
            <div>{{ p.title || '(尚未采集)' }}</div>
            <div class="mono muted">{{ p.url }}</div>
          </td>
          <td>
            <span v-if="p.lastCaptureStatus" class="badge" :class="p.lastCaptureStatus">{{ CAPTURE_STATUS_LABELS[p.lastCaptureStatus] }}</span>
            <span v-else class="muted">未采集</span>
          </td>
          <td>{{ p.captureCount }}</td>
          <td>
            <button :disabled="archived" @click="capture(p)">{{ p.captureCount ? '重新采集' : '采集' }}</button>
            <button class="link" :disabled="!p.captureCount" @click="openPageId = p.id">查看</button>
            <button class="link danger" @click="remove(p)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <CaptureDrawer v-if="openPage" :page="openPage" :capture-options="options" @close="openPageId = null" />
</template>
