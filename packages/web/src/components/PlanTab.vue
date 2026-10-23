<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api';
import { useProjectStore } from '../store';
import { notify } from '../toast';

const store = useProjectStore();
const text = ref('');
const dirty = ref(false);

watch(
  () => store.project.value?.planText,
  (v) => {
    if (!dirty.value) text.value = v ?? '';
  },
  { immediate: true },
);

const TEMPLATE = `## 建设目标
(一两句话说明要做什么)

## 阶段划分
### 第一期:
-

### 第二期:
-

## 技术方案建议
- 前端:
- 后端:
- 数据库:
- 部署:

## 风险与待确认
-

## 工作量与报价
(由你根据功能范围判断和确认)
`;

async function save() {
  try {
    await api.updateProject(store.projectId, { planText: text.value });
    dirty.value = false;
    await store.loadProject();
    notify('已保存', 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}
</script>

<template>
  <div class="panel">
    <div class="row between">
      <div>
        <h2>初步方案</h2>
        <div class="muted small">技术方案、分阶段建议、工作量和报价都是你的判断,这里只是一个可编辑的文本,导出时放在报告最后。</div>
      </div>
      <div class="row">
        <button v-if="!text.trim()" @click="(text = TEMPLATE), (dirty = true)">插入模板</button>
        <button class="primary" :disabled="!dirty" @click="save">保存</button>
      </div>
    </div>
    <textarea v-model="text" style="min-height: 420px; margin-top: 10px" @input="dirty = true"></textarea>
  </div>
</template>
