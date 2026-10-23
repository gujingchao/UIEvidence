import { reactive } from 'vue';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'ok';
}

export const toasts = reactive<Toast[]>([]);
let seq = 0;

export function notify(text: string, kind: Toast['kind'] = 'info', ms = 4500): void {
  const id = ++seq;
  toasts.push({ id, text, kind });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, ms);
}
