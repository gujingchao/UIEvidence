<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useProjectStore } from '../store';
import { notify } from '../toast';
import LoginCard from './LoginCard.vue';

const store = useProjectStore();
const router = useRouter();

const form = ref({ name: '', targetUrl: '', purpose: '', authorization: '', domains: '' });
const postText = ref('');

watch(
  () => store.project.value,
  (p) => {
    if (!p) return;
    form.value = { name: p.name, targetUrl: p.targetUrl, purpose: p.purpose, authorization: p.authorization, domains: p.allowedDomains.join('\n') };
    postText.value = p.allowedPost.join('\n');
  },
  { immediate: true },
);

async function save() {
  try {
    await api.updateProject(store.projectId, {
      name: form.value.name,
      targetUrl: form.value.targetUrl,
      purpose: form.value.purpose,
      authorization: form.value.authorization,
      allowedDomains: form.value.domains.split(/[\s,;,;]+/).filter(Boolean),
    });
    await store.loadProject();
    notify('已保存', 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function savePost() {
  try {
    await api.updateProject(store.projectId, { allowedPost: postText.value.split(/[\s,;,;]+/).filter(Boolean) });
    await store.loadProject();
    notify('已保存放行清单', 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function setAllowAi(value: boolean) {
  if (value && !confirm('开启后,你选择“AI 分析”时,页面结构和截图会发送给你选择的第三方模型服务。确定开启吗?')) {
    return;
  }
  try {
    await api.updateProject(store.projectId, { allowAi: value });
    await store.loadProject();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function setArchived(value: boolean) {
  try {
    await api.updateProject(store.projectId, { archived: value });
    await store.loadProject();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function remove() {
  const name = store.project.value?.name ?? '';
  if (prompt(`这会删除项目的全部记录和证据文件,且无法恢复。\n请输入项目名称“${name}”确认:`) !== name) return;
  try {
    await api.deleteProject(store.projectId);
    router.push('/');
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}
</script>

<template>
  <div v-if="store.project.value" class="stack">
    <form class="panel stack" @submit.prevent="save">
      <h2>项目信息</h2>
      <label class="field"><span>项目名称</span><input v-model="form.name" type="text" /></label>
      <label class="field"><span>目标网站</span><input v-model="form.targetUrl" type="text" /></label>
      <label class="field"><span>分析目的</span><textarea v-model="form.purpose"></textarea></label>
      <label class="field">
        <span>允许分析的域名(每行一个)</span>
        <textarea v-model="form.domains"></textarea>
        <div class="hint">已添加的页面不受影响,但之后的采集只会访问这些域名。</div>
      </label>
      <label class="field"><span>授权说明</span><textarea v-model="form.authorization"></textarea></label>
      <div class="row"><button class="primary" type="submit">保存</button></div>
    </form>

    <LoginCard />

    <form class="panel stack" @submit.prevent="savePost">
      <h2>放行只读的 POST 接口</h2>
      <div class="muted small">
        采集时默认拦截所有会改变数据的请求(POST、PUT、DELETE 等)。但不少系统用 POST 来<strong>读取</strong>数据(GraphQL、搜索、列表查询),被拦截后页面会是空的。
        被拦截的请求会出现在“分析缺口”里,确认它只是读数据后可以在那里一键放行;也可以在这里手动维护。
      </div>
      <label class="field">
        <span>放行的接口路径(每行一个)</span>
        <textarea v-model="postText" placeholder="/api/orders&#10;/graphql&#10;/api/search/*"></textarea>
        <div class="hint">只放行 POST,路径精确匹配;结尾加 <code>*</code> 表示前缀匹配。<strong>不要放行会新增、修改或删除数据的接口</strong>(包括 GraphQL 的 mutation)。</div>
      </label>
      <div class="row"><button class="primary" type="submit">保存</button></div>
    </form>

    <div class="panel stack">
      <h2>AI 辅助</h2>
      <label class="row">
        <input type="checkbox" :checked="store.project.value.allowAi" @change="setAllowAi(($event.target as HTMLInputElement).checked)" />
        <span>允许把采集内容发送给第三方模型服务</span>
      </label>
      <div class="muted small">
        默认关闭。关闭时,采集、整理和导出都完全可用。开启后,只有你主动点击“让 AI 分析”才会发送内容,密钥从环境变量读取,不会保存在项目数据里。
      </div>
    </div>

    <div class="panel stack">
      <h2>归档与删除</h2>
      <div class="row">
        <button @click="setArchived(!store.project.value.archived)">{{ store.project.value.archived ? '取消归档' : '归档项目' }}</button>
        <button class="danger" @click="remove">删除项目…</button>
      </div>
      <div class="muted small">归档后项目只读,不再采集;数据仍然保留。</div>
    </div>
  </div>
</template>
