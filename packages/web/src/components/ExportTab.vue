<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ExportResult } from '@uievidence/shared';
import { api } from '../api';
import { useProjectStore } from '../store';
import { tabPath } from '../tabs';
import { notify } from '../toast';

const store = useProjectStore();
const result = ref<ExportResult | null>(null);
const busy = ref(false);

const pendingAi = computed(() => store.features.value.filter((f) => f.status === 'pending').length);
const openGaps = computed(() => store.gaps.value.filter((g) => !g.resolved).length);
const loginBlocked = computed(() => store.pages.value.filter((p) => p.lastCaptureStatus === 'login_required').length);
const hasLoginData = computed(() => !!store.project.value?.loginSetAt);

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

    <ul v-if="pendingAi || openGaps || loginBlocked || hasLoginData" class="check-list small">
      <li v-if="loginBlocked" class="warn">
        有 {{ loginBlocked }} 个页面被挡在登录页外,报告里只有登录页的截图。
        <router-link :to="{ path: tabPath(store.projectId, 'overview'), query: {} }">去登录</router-link>
      </li>
      <li v-if="pendingAi">有 {{ pendingAi }} 条 AI 建议尚未采纳,它们不会出现在报告里。<router-link :to="{ path: tabPath(store.projectId, 'features'), query: {} }">去处理</router-link></li>
      <li v-if="openGaps">有 {{ openGaps }} 个分析缺口未解决,会写进报告的“分析缺口”一节。<router-link :to="{ path: tabPath(store.projectId, 'gaps'), query: {} }">去查看</router-link></li>
      <li v-if="hasLoginData" class="warn">
        这个项目使用了登录状态,<strong>报告里的截图会包含登录后的真实数据</strong>(姓名、订单等)。交给别人之前请先检查。登录状态本身不会写进报告。
      </li>
    </ul>

    <div class="row" style="margin-top: 12px">
      <button class="primary" :disabled="busy || store.busy.value" @click="generate">
        {{ busy ? '生成中…' : store.busy.value ? '有采集进行中,稍候…' : '生成报告' }}
      </button>
    </div>
  </div>

  <template v-if="result">
    <div class="panel">
      <div class="row between">
        <h3>已生成({{ result.stamp }})</h3>
        <div class="row">
          <a class="btn" :href="result.reportHtml" target="_blank" rel="noopener">在新标签页打开</a>
          <a class="btn" :href="result.reportMd" target="_blank" rel="noopener">Markdown</a>
          <a class="btn primary" :href="result.bundle" download>下载材料包(.zip,含截图)</a>
        </div>
      </div>
    </div>
    <!-- 在工作台里直接预览;报告文件本身保持干净,因为它是要交给客户的 -->
    <iframe class="report-preview" :src="result.reportHtml" title="报告预览" sandbox="allow-same-origin"></iframe>
  </template>
</template>
