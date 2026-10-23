<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';
import { fmtTime, GAP_TYPE_LABELS } from '../labels';
import { useProjectStore } from '../store';
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
</script>

<template>
  <div class="panel">
    <h2>分析缺口</h2>
    <div class="muted small">
      没能确认的内容在这里汇总:未执行的交互、采集失败的页面、被拦截的请求。处理完(或已向客户确认)的可以标记为已解决。未解决的缺口会写进导出报告。
    </div>
    <form class="row" style="margin-top: 10px" @submit.prevent="add">
      <input v-model="text" type="text" class="grow" placeholder="手工记录一个缺口,例如:后台管理界面无法从前台确认" />
      <button class="primary" type="submit" :disabled="!text.trim()">添加</button>
    </form>
  </div>

  <div v-if="!store.gaps.value.length" class="empty panel">暂无缺口。</div>
  <div v-else class="panel">
    <table>
      <thead><tr><th style="width: 36px"></th><th>类型</th><th>说明</th><th>时间</th><th></th></tr></thead>
      <tbody>
        <tr v-for="g in store.gaps.value" :key="g.id" :style="g.resolved ? 'opacity: .55' : ''">
          <td><input type="checkbox" :checked="g.resolved" :aria-label="'标记已解决'" @change="toggle(g.id, ($event.target as HTMLInputElement).checked)" /></td>
          <td><span class="badge">{{ GAP_TYPE_LABELS[g.type] }}</span></td>
          <td>{{ g.description }}</td>
          <td class="small muted">{{ fmtTime(g.createdAt) }}</td>
          <td><button class="link danger" @click="remove(g.id)">删除</button></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
