import type { DiscoveredLink, DiscoveryResult, PageStructure, Project } from '@uievidence/shared';
import { type Repo } from './repo.js';
import { isUrlAllowed } from './scope.js';
import { type Storage } from './storage.js';

/** 明显不是"页面"的链接:文件下载、静态资源 */
const FILE_EXT = /\.(jpe?g|png|gif|svg|webp|ico|bmp|pdf|zip|rar|7z|gz|tar|exe|dmg|msi|apk|mp3|mp4|avi|mov|wav|css|js|json|xml|rss|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv)$/i;

const MAX_RESULTS = 300;

/**
 * 看起来会改变状态的链接:退出登录、删除、支付等。
 * 有些网站的这类操作就是一个普通的 GET 链接,登录状态下一旦被当成页面去采集,
 * 轻则退出登录、让保存的登录状态作废,重则真的删掉数据。所以发现时直接排除,并告诉使用者排除了什么。
 * 这是尽力而为的判断,不能代替"使用只读账号"。
 */
// 只看文字开头:命令式的链接文字是以动作开头的("退出登录"、"立即支付"),
// 而"陷阱页(带删除按钮)"这种只是在描述页面内容,不能因此排除
const RISKY_TEXT =
  /^\s*(立即|马上|确认|一键)?(退出|注销|登出|删除|移除|取消订单|支付|付款|购买|下单|log\s?out|sign\s?out|delete|remove|unsubscribe|checkout|purchase|pay\s?now)/i;
const RISKY_PATH = /(^|[/_-])(log-?out|sign-?out|log-?off|delete|destroy|remove|unsubscribe|checkout|purchase|cancel|danger)([/_.-]|$)/i;

export function riskyReason(url: string, text = ''): string | null {
  if (RISKY_TEXT.test(text)) return `链接文字「${text.trim().slice(0, 20)}」看起来会改变状态`;
  try {
    if (RISKY_PATH.test(new URL(url).pathname)) return '网址看起来会改变状态(退出登录、删除、支付等)';
  } catch {
    /* 无效网址由调用方处理 */
  }
  return null;
}

/** 去掉锚点,并把末尾斜杠统一,用来判断两个网址是不是同一个页面 */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** 存进页面清单的网址:去掉锚点,其余保持原样 */
export function normalizePageUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

export function isFileLink(url: string): boolean {
  try {
    return FILE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * 从已采集成功的页面里,汇总出"还不在页面清单里、但在白名单内"的链接,按出现次数排序。
 * 这样分析一个网站只需要给一个入口页,其余页面可以一键加入。
 */
export function discoverLinks(repo: Repo, storage: Storage, project: Project): DiscoveryResult {
  const pages = repo.listPages(project.id);
  const existing = new Set(pages.map((p) => pageKey(p.url)).filter((k): k is string => !!k));
  const captures = repo.listCaptures(project.id); // 新的在前
  const found = new Map<string, DiscoveredLink>();
  const excluded = new Map<string, DiscoveryResult['excluded'][number]>();

  for (const page of pages) {
    const capture = captures.find(
      (c) => c.pageId === page.id && c.evidenceId && (c.status === 'success' || c.status === 'partial') && !c.interaction,
    );
    if (!capture?.evidenceId) continue;
    const rel = repo.evidenceFilePath(capture.evidenceId, 'structure');
    if (!rel || !storage.exists(rel)) continue;

    let structure: PageStructure;
    try {
      structure = JSON.parse(storage.read(rel).toString('utf8')) as PageStructure;
    } catch {
      continue;
    }

    const seenInPage = new Set<string>();
    for (const link of [...structure.nav, ...structure.links]) {
      const url = normalizePageUrl(link.href);
      const key = url ? pageKey(url) : null;
      if (!url || !key || existing.has(key) || seenInPage.has(key)) continue;
      if (!isUrlAllowed(url, project.allowedDomains) || isFileLink(url)) continue;
      seenInPage.add(key);

      const risk = riskyReason(url, link.text);
      if (risk) {
        if (!excluded.has(key)) excluded.set(key, { url, text: link.text, reason: risk });
        continue;
      }

      const cur = found.get(key);
      if (cur) {
        cur.count += 1;
        cur.pageIds.push(page.id);
        if (!cur.text && link.text) cur.text = link.text;
      } else {
        found.set(key, { url, text: link.text, count: 1, pageIds: [page.id] });
      }
    }
  }

  return {
    links: [...found.values()].sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)).slice(0, MAX_RESULTS),
    excluded: [...excluded.values()],
  };
}
