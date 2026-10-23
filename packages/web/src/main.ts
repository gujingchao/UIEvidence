import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import ProjectsView from './views/ProjectsView.vue';
import ProjectView from './views/ProjectView.vue';
import './style.css';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: ProjectsView },
    { path: '/projects/:id', component: ProjectView, props: (r) => ({ id: Number(r.params.id) }) },
  ],
});

createApp(App).use(router).mount('#app');
