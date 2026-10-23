import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import { TAB_KEYS } from './tabs';
import ProjectsView from './views/ProjectsView.vue';
import ProjectView from './views/ProjectView.vue';
import './style.css';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: ProjectsView },
    {
      // 标签页和证据抽屉都在地址里:刷新不丢位置,浏览器的后退也能用
      path: '/projects/:id/:tab?',
      component: ProjectView,
      props: (r) => {
        const tab = String(r.params.tab ?? 'overview');
        return { id: Number(r.params.id), tab: TAB_KEYS.includes(tab) ? tab : 'overview' };
      },
    },
  ],
});

createApp(App).use(router).mount('#app');
