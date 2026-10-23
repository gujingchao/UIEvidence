import { reactive } from 'vue';
import type { RouteLocationRaw } from 'vue-router';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'ok';
  /** 提示后面的"去看看"按钮 */
  action?: { label: string; to: RouteLocationRaw };
}

export const toasts = reactive<Toast[]>([]);
let seq = 0;

export function notify(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  const id = ++seq;
  toasts.push({ id, text, kind, action });
  // 带按钮的提示停留更久,错误提示也一样,免得还没看清就消失了
  const ms = action || kind === 'error' ? 9000 : 4500;
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, ms);
}

export function dismiss(id: number): void {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
