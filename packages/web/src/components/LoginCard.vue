<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api';
import { fmtTime } from '../labels';
import { useProjectStore } from '../store';
import { notify } from '../toast';

defineProps<{ highlight?: boolean }>();

const store = useProjectStore();
const startUrl = ref('');
const busy = ref(false);
const showHelp = ref(false);

const open = computed(() => store.login.value?.open ?? false);
const setAt = computed(() => store.project.value?.loginSetAt ?? store.login.value?.setAt ?? null);

async function start() {
  busy.value = true;
  try {
    store.login.value = await api.startLogin(store.projectId, startUrl.value.trim() || undefined);
  } catch (err) {
    notify((err as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}

async function finish() {
  busy.value = true;
  try {
    store.login.value = await api.finishLogin(store.projectId);
    await store.loadProject();
    notify('登录状态已保存。之前被挡在登录页外的页面,可以重新采集了', 'ok');
  } catch (err) {
    notify((err as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}

async function clear() {
  if (!confirm('清除后,采集将不再带登录状态。确定清除吗?')) return;
  try {
    store.login.value = await api.clearLogin(store.projectId);
    await store.loadProject();
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}
</script>

<template>
  <div class="panel login-card" :class="{ highlight }">
    <div class="row between">
      <h2>登录状态</h2>
      <span v-if="open" class="badge running">登录窗口已打开</span>
      <span v-else-if="setAt" class="badge success">已保存登录状态</span>
      <span v-else class="badge">未登录</span>
    </div>

    <!-- 窗口开着:告诉用户现在该做什么 -->
    <template v-if="open">
      <ol class="steps-text">
        <li>在刚刚弹出的浏览器窗口里<strong>自己完成登录</strong>(验证码、扫码、短信都可以)。</li>
        <li>登录成功、能看到登录后的页面后,回到这里点“我已登录”。</li>
      </ol>
      <div class="row">
        <button class="primary" :disabled="busy" @click="finish">{{ busy ? '正在保存…' : '我已登录' }}</button>
        <span class="muted small">没看到窗口?它可能被压在其他窗口后面,看一下任务栏。</span>
      </div>
    </template>

    <!-- 已有登录状态 -->
    <template v-else-if="setAt">
      <div class="small">最近一次保存:{{ fmtTime(setAt) }}。之后的采集会带着这份登录状态。</div>
      <div class="row" style="margin-top: 10px">
        <button :disabled="busy" @click="start">重新登录</button>
        <button class="danger" @click="clear">清除登录状态</button>
      </div>
      <div class="muted small" style="margin-top: 6px">如果页面又被挡在登录页外,说明登录已经过期,点“重新登录”即可。</div>
    </template>

    <!-- 还没登录 -->
    <template v-else>
      <div class="small">
        要分析的网站需要登录才能看到内容时,先在这里登录一次。<strong>本工具不接收、不保存你的账号密码</strong>,登录由你在真实的浏览器窗口里完成,所以验证码、扫码、二次验证都不受影响。
      </div>
      <div class="row" style="margin-top: 10px">
        <input v-model="startUrl" type="text" class="grow" placeholder="登录页网址(可选,默认打开目标网站)" />
        <button class="primary" :disabled="busy" @click="start">{{ busy ? '正在打开…' : '打开登录窗口' }}</button>
      </div>
    </template>

    <button class="link small" style="margin-top: 8px" @click="showHelp = !showHelp">{{ showHelp ? '收起说明' : '登录是怎么工作的?需要注意什么?' }}</button>
    <ul v-if="showHelp" class="small help-list">
      <li>登录窗口是一个普通的 Chrome 窗口,和你日常用的浏览器互不相干,看不到你平时的任何账号。</li>
      <li>登录状态(Cookie 等)只保存在本项目的数据目录里,<strong>等同于密码</strong>:不会写进导出报告,删除项目时一并删除。保存时只保留允许分析的域名下的内容。</li>
      <li>请使用<strong>只读账号或测试账号</strong>。采集虽然只读,但登录后的页面里有真实数据,截图也会带上。</li>
      <li>登录窗口开着期间会短暂开放一个只监听本机的调试端口,登录结束后随窗口一起消失。</li>
      <li>有些网站会识别并拒绝自动化访问,登录后采集仍可能被挡住。遇到这种情况只会记为“分析缺口”,不会做任何规避。</li>
      <li>用 POST 请求读取数据的系统(如 GraphQL),需要在“设置”里放行对应的接口,否则页面会是空的。</li>
    </ul>
  </div>
</template>
