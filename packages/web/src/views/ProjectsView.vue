<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { HealthInfo, Project } from '@uievidence/shared';
import { api } from '../api';
import { notify } from '../toast';

const router = useRouter();
const projects = ref<Project[]>([]);
const health = ref<HealthInfo | null>(null);
const showArchived = ref(false);
const creating = ref(false);
const loaded = ref(false);
const demoBusy = ref(false);

const form = ref({ name: '', targetUrl: '', purpose: '', authorization: '', domains: '', confirmed: false });

const canSubmit = computed(
  () => form.value.name.trim() && form.value.authorization.trim() && form.value.domains.trim() && form.value.confirmed,
);

async function load() {
  try {
    projects.value = await api.listProjects(showArchived.value);
  } catch (err) {
    notify((err as Error).message, 'error');
  } finally {
    loaded.value = true;
  }
}

onMounted(async () => {
  await load();
  health.value = await api.health().catch(() => null);
});

/** 填了目标网址、还没写域名时,按网址主机名预填,由使用者确认 */
function suggestDomain() {
  if (form.value.domains.trim() || !form.value.targetUrl.trim()) return;
  try {
    const u = new URL(form.value.targetUrl.includes('://') ? form.value.targetUrl : `https://${form.value.targetUrl}`);
    form.value.domains = u.host;
  } catch {
    /* 网址还没填完整 */
  }
}

async function create() {
  if (!canSubmit.value) return;
  try {
    const project = await api.createProject({
      name: form.value.name.trim(),
      targetUrl: form.value.targetUrl.trim(),
      purpose: form.value.purpose.trim(),
      authorization: form.value.authorization.trim(),
      allowedDomains: form.value.domains
        .split(/[\s,;,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
    router.push(`/projects/${project.id}`);
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

async function createDemo() {
  demoBusy.value = true;
  try {
    const project = await api.createDemo();
    router.push(`/projects/${project.id}`);
  } catch (err) {
    notify((err as Error).message, 'error');
  } finally {
    demoBusy.value = false;
  }
}
</script>

<template>
  <div v-if="health && !health.browser.found" class="notice">
    没有找到可用的 Chrome 或 Edge,无法采集页面。请安装 Chrome,或用环境变量 <code>UIEV_CHROME_PATH</code> 指定浏览器路径。
  </div>

  <!-- 第一次使用:告诉用户这是什么、怎么开始 -->
  <div v-if="loaded && !projects.length && !creating" class="panel welcome">
    <h1>开始分析一个网站</h1>
    <p>
      给一个参考网站的入口页,UIEvidence 会替你逐页打开、保存截图和页面结构,帮你整理出功能清单和待确认的问题,最后导出一份每条结论都有证据的分析报告。
      全程只读,不会提交表单,也不会删除任何东西。
    </p>
    <div class="row">
      <button class="primary" @click="creating = true">新建项目</button>
      <button :disabled="demoBusy" @click="createDemo">{{ demoBusy ? '正在准备…' : '先用示例项目体验一遍' }}</button>
    </div>
    <div class="muted small" style="margin-top: 8px">示例项目带一个本机的演示网站,包含分页、表单、需要登录的会员页和带危险按钮的页面,不会访问任何外部网站。</div>
  </div>

  <div class="panel">
    <div class="row between">
      <h2>分析项目</h2>
      <div class="row">
        <label class="small"><input v-model="showArchived" type="checkbox" @change="load" /> 显示已归档</label>
        <button v-if="projects.length" :disabled="demoBusy" @click="createDemo">新建示例项目</button>
        <button class="primary" @click="creating = !creating">{{ creating ? '收起' : '新建项目' }}</button>
      </div>
    </div>

    <form v-if="creating" class="stack" @submit.prevent="create">
      <label class="field">
        <span>项目名称</span>
        <input v-model="form.name" type="text" placeholder="例如:某培训机构官网" />
      </label>
      <label class="field">
        <span>目标网站(可选)</span>
        <input v-model="form.targetUrl" type="text" placeholder="https://example.com" @blur="suggestDomain" />
      </label>
      <label class="field">
        <span>分析目的(可选)</span>
        <textarea v-model="form.purpose" placeholder="例如:客户要做一个类似的系统,需要评估功能范围"></textarea>
      </label>
      <label class="field">
        <span>允许分析的域名</span>
        <textarea v-model="form.domains" placeholder="每行一个,例如&#10;example.com&#10;*.example.com"></textarea>
        <div class="hint">采集只会访问这些域名。<code>*.example.com</code> 匹配所有子域名;写成 <code>127.0.0.1:4100</code> 可限定端口。</div>
      </label>
      <label class="field">
        <span>授权说明</span>
        <textarea v-model="form.authorization" placeholder="说明你为什么有权分析这个网站,例如:公开网站 / 客户书面授权 / 自有系统"></textarea>
      </label>
      <label class="row">
        <input v-model="form.confirmed" type="checkbox" />
        <span>我确认只分析公开网站,或已获得明确授权的系统。</span>
      </label>
      <div class="row"><button class="primary" type="submit" :disabled="!canSubmit">创建项目</button></div>
    </form>
  </div>

  <div v-for="p in projects" :key="p.id" class="panel">
    <div class="row between">
      <div>
        <h3>
          <router-link :to="`/projects/${p.id}`">{{ p.name }}</router-link>
          <span v-if="p.archived" class="badge">已归档</span>
        </h3>
        <div class="muted small">{{ p.targetUrl || '未填写目标网站' }}</div>
        <div class="small">
          <span v-for="d in p.allowedDomains" :key="d" class="chip">{{ d }}</span>
        </div>
      </div>
      <div class="row">
        <span class="muted small">创建于 {{ new Date(p.createdAt).toLocaleString() }}</span>
        <router-link class="btn primary" :to="`/projects/${p.id}`">打开</router-link>
      </div>
    </div>
  </div>
</template>
