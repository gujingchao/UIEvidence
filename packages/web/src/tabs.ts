export const TAB_KEYS = ['overview', 'pages', 'features', 'requirements', 'gaps', 'plan', 'export', 'settings'];

export type TabKey = 'overview' | 'pages' | 'features' | 'requirements' | 'gaps' | 'plan' | 'export' | 'settings';

export const tabPath = (projectId: number, tab: TabKey): string => `/projects/${projectId}/${tab}`;
