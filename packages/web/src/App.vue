<script setup lang="ts">
import { dismiss, toasts } from './toast';
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <router-link class="brand" to="/">UIEvidence · 网站功能分析</router-link>
      <span class="muted small">本地运行 · 数据只保存在你的电脑上</span>
    </header>
    <!-- 换到另一个项目时重新创建页面,避免带着上一个项目的数据 -->
    <router-view v-slot="{ Component, route }">
      <component :is="Component" :key="String(route.params.id ?? 'home')" />
    </router-view>
  </div>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">
      <span>{{ t.text }}</span>
      <router-link v-if="t.action" class="toast-action" :to="t.action.to" @click="dismiss(t.id)">{{ t.action.label }} →</router-link>
      <button class="link" aria-label="关闭提示" @click="dismiss(t.id)">×</button>
    </div>
  </div>
</template>
