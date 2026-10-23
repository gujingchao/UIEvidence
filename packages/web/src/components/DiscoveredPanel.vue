<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { shortUrl } from '../labels';
import { useProjectStore } from '../store';
import { notify } from '../toast';

const store = useProjectStore();
const checked = ref<Set<string>>(new Set());
const showAll = ref(false);
const busy = ref(false);

const PREVIEW = 30;
const items = computed(() => store.discovered.value);
const visible = computed(() => (showAll.value ? items.value : items.value.slice(0, PREVIEW)));
const archived = computed(() => store.project.value?.archived ?? false);

// 第一次出现的链接默认勾选(数量不多时),省得一个个勾;很多时默认不选,避免一不小心加进来几百个。
// 已经出现过的链接保留使用者的选择:采集过程中不断有新链接冒出来,不能因为已经勾了几个,新来的就漏掉。
const seen = new Set<string>();
watch(
  items,
  (list) => {
    const next = new Set<string>();
    for (const l of list) {
      if (!seen.has(l.url)) {
        seen.add(l.url);
        if (list.length <= 40) next.add(l.url);
      } else if (checked.value.has(l.url)) {
        next.add(l.url);
      }
    }
    checked.value = next;
  },
  { immediate: true },
);

const toggle = (url: string) => {
  const next = new Set(checked.value);
  if (next.has(url)) next.delete(url);
  else next.add(url);
  checked.value = next;
};

const allChecked = computed(() => visible.value.length > 0 && visible.value.every((l) => checked.value.has(l.url)));
function toggleAll() {
  const next = new Set(checked.value);
  if (allChecked.value) for (const l of visible.value) next.delete(l.url);
  else for (const l of visible.value) next.add(l.url);
  checked.value = next;
}

async function add(thenCapture: boolean) {
  const urls = items.value.filter((l) => checked.value.has(l.url)).map((l) => l.url);
  if (!urls.length) return;
  busy.value = true;
  try {
    const r = await api.bulkAddPages(store.projectId, urls);
    await Promise.all([store.loadPages(), store.loadDiscovered()]);
    if (r.skipped.length) notify(`${r.skipped.length} 个网址被跳过:${r.skipped[0]?.reason}`, 'info');
    if (thenCapture) for (const p of r.added) await store.capturePage(p);
    notify(`已加入 ${r.added.length} 个页面${thenCapture ? ',正在采集' : ''}`, 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="!items.length && store.excluded.value.length" class="muted small excluded-note">
    已排除 {{ store.excluded.value.length }} 个看起来会改变状态的链接({{ store.excluded.value.slice(0, 3).map((e) => e.text || e.url).join(', ') }}…),它们不会被当成页面采集。
  </div>
  <div v-if="items.length" class="panel discovered">
    <div class="row between">
      <div>
        <h2>发现了 {{ items.length }} 个新页面</h2>
        <div class="muted small">这些链接出现在你已经采集的页面里,在允许分析的域名内,但还不在页面清单中。勾选后一键加入,不用再手输网址。</div>
      </div>
    </div>

    <div class="row small" style="margin: 10px 0 4px">
      <label><input type="checkbox" :checked="allChecked" @change="toggleAll" /> 全选</label>
      <span class="muted">已选 {{ checked.size }} 个</span>
    </div>

    <div class="disc-list">
      <label v-for="l in visible" :key="l.url" class="disc-item">
        <input type="checkbox" :checked="checked.has(l.url)" @change="toggle(l.url)" />
        <span class="grow">
          <span>{{ l.text || '(无文字)' }}</span>
          <span class="mono muted"> {{ shortUrl(l.url) }}</span>
        </span>
        <span v-if="l.count > 1" class="muted small">出现在 {{ l.count }} 个页面</span>
      </label>
    </div>
    <button v-if="items.length > PREVIEW && !showAll" class="link small" @click="showAll = true">显示全部 {{ items.length }} 个</button>

    <div v-if="store.excluded.value.length" class="muted small" style="margin-top: 8px" :title="store.excluded.value.map((e) => `${e.text || e.url}:${e.reason}`).join('\n')">
      已排除 {{ store.excluded.value.length }} 个看起来会改变状态的链接(如“{{ store.excluded.value[0]?.text || store.excluded.value[0]?.url }}”):登录状态下采集它们可能让登录失效或改动数据。
    </div>

    <div class="row" style="margin-top: 10px">
      <button class="primary" :disabled="busy || !checked.size || archived" @click="add(true)">加入并采集</button>
      <button :disabled="busy || !checked.size || archived" @click="add(false)">只加入</button>
    </div>
  </div>
</template>
