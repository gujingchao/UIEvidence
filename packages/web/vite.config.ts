import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const backend = `http://127.0.0.1:${process.env.PORT ?? 4317}`;

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': backend,
      '/exports': backend,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
