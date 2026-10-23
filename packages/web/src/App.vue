<script setup lang="ts">
import { toasts } from './toast';
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <router-link class="brand" to="/">UIEvidence · 网站功能分析</router-link>
      <span class="muted small">本地运行 · 数据只保存在你的电脑上</span>
    </header>
    <router-view />
  </div>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
  </div>
</template>
