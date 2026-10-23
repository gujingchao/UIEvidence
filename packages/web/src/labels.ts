import type { CaptureStatus, GapType } from '@uievidence/shared';

export const CAPTURE_STATUS_LABELS: Record<CaptureStatus, string> = {
  queued: '排队中',
  running: '采集中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
};

export const GAP_TYPE_LABELS: Record<GapType, string> = {
  interaction_skipped: '未执行的交互',
  capture_failed: '采集失败',
  capture_partial: '部分采集',
  request_blocked: '拦截的写入请求',
  out_of_scope: '白名单外的地址',
  manual: '人工记录',
};

export const INTERACTION_LABELS = { tab: 'Tab 切换', pagination: '分页', modal: '弹窗展开' } as const;

export const fmtTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '');
