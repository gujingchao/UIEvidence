<script setup lang="ts">
import { ref } from 'vue';
import type { Gap } from '@uievidence/shared';
import { api } from '../api';
import { fmtTime, GAP_TYPE_LABELS } from '../labels';
import { useProjectStore } from '../store';
import { tabPath } from '../tabs';
import { notify } from '../toast';

const store = useProjectStore();
const text = ref('');

async function add() {
  if (!text.value.trim()) return;
  try {
    await api.addGap(store.projectId, text.value.trim());
    text.value = '';
    await store.loadGaps();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function toggle(id: number, resolved: boolean) {
  try {
    await api.resolveGap(id, resolved);
    await store.loadGaps();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function remove(id: number) {
  try {
    await api.deleteGap(id);
    await store.loadGaps();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

/** 被拦截的 POST 其实是读数据:加入放行清单,并重新采集产生它的页面 */
async function allow(g: Gap) {
  const project = store.project.value;
  const path = g.meta?.path;
  if (!project || !path) return;
  if (!confirm(`放行 POST ${path}?\n\n只应该放行“用来读取数据”的接口(查询、列表、搜索)。如果它会新增、修改或删除数据,请不要放行。`)) return;
  try {
    await api.updateProject(store.projectId, { allowedPost: [...project.allowedPost, path] });
    await store.loadProject();
    await api.resolveGap(g.id, true);
    await store.loadGaps();
    const page = g.pageId ? store.pageById(g.pageId) : undefined;
    if (page) await store.capturePage(page);
    notify(`已放行 POST ${path}${page ? ',正在重新采集该页面' : ''}`, 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}
</script>

<template>
  <div class="panel">
    <h2>分析缺口</h2>
    <div class="muted small">
      没能确认的内容在这里汇总:未执行的交互、采集失败的页面、被拦截的请求、需要登录的页面。处理完(或已向客户确认)的可以标记为已解决。未解决的缺口会写进导出报告。
    </div>
    <form class="row" style="margin-top: 10px" @submit.prevent="add">
      <input v-model="text" type="text" class="grow" placeholder="手工记录一个缺口,例如:后台管理界面无法从前台确认" />
      <button class="primary" type="submit" :disabled="!text.trim()">添加</button>
    </form>
  </div>

  <div v-if="!store.gaps.value.length" class="empty panel">暂无缺口。采集页面时遇到的问题会自动记在这里。</div>
  <div v-else class="panel">
    <table>
      <thead><tr><th style="width: 36px"></th><th>类型</th><th>说明</th><th style="width: 190px">操作</th></tr></thead>
      <tbody>
        <tr v-for="g in store.gaps.value" :key="g.id" :style="g.resolved ? 'opacity: .55' : ''">
          <td><input type="checkbox" :checked="g.resolved" aria-label="标记已解决" @change="toggle(g.id, ($event.target as HTMLInputElement).checked)" /></td>
          <td><span class="badge" :class="{ failed: g.type === 'auth_required' }">{{ GAP_TYPE_LABELS[g.type] }}</span></td>
          <td>
            {{ g.description }}
            <div class="small muted">{{ fmtTime(g.createdAt) }}</div>
          </td>
          <td>
            <button v-if="g.type === 'request_blocked' && g.meta?.path && g.meta.method === 'POST' && !g.resolved" @click="allow(g)">放行并重新采集</button>
            <router-link
              v-if="g.type === 'auth_required'"
              class="btn"
              :to="{ path: tabPath(store.projectId, 'overview'), query: {} }"
            >去登录</router-link>
            <button v-if="g.pageId" class="link" @click="store.openPage(g.pageId, g.captureId)">查看页面</button>
            <button class="link danger" @click="remove(g.id)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
