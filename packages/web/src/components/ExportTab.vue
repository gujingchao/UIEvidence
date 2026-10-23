<script setup lang="ts">
import { ref } from 'vue';
import type { ExportResult } from '@uievidence/shared';
import { api } from '../api';
import { useProjectStore } from '../store';
import { notify } from '../toast';

const store = useProjectStore();
const result = ref<ExportResult | null>(null);
const busy = ref(false);

async function generate() {
  busy.value = true;
  try {
    result.value = await api.exportProject(store.projectId);
    notify('报告已生成', 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="panel">
    <h2>导出分析报告</h2>
    <div class="muted small">
      每次导出都会生成一个新目录,里面有 Markdown、HTML 和截图,并打包成材料包。三种格式内容一致,报告里的截图用相对路径引用,所以请保持目录结构,或直接使用材料包。
    </div>
    <div class="row" style="margin-top: 12px">
      <button class="primary" :disabled="busy || store.busy.value" @click="generate">
        {{ busy ? '生成中…' : store.busy.value ? '有采集进行中,稍候…' : '生成报告' }}
      </button>
    </div>
    <div v-if="store.features.value.some((f) => f.status === 'pending')" class="notice info" style="margin-top: 12px">
      有 AI 建议尚未采纳,它们不会出现在报告里。
    </div>
  </div>

  <div v-if="result" class="panel">
    <h3>已生成({{ result.stamp }})</h3>
    <ul>
      <li><a :href="result.reportHtml" target="_blank" rel="noopener">打开 HTML 报告</a></li>
      <li><a :href="result.reportMd" target="_blank" rel="noopener">查看 Markdown</a></li>
      <li><a :href="result.bundle" download>下载材料包(.zip,含截图)</a></li>
    </ul>
  </div>
</template>
