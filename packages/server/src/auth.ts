import type { PageStructure } from '@uievidence/shared';

export interface LoginWall {
  reason: string;
}

function location(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/**
 * 判断页面是不是把采集挡在了登录页外。
 *
 *  - HTTP 401:明确要求认证。
 *  - 出现密码框,并且最终地址和请求的地址不是同一个位置(被跳转了),或者状态码是 403。
 *
 * 使用者故意把登录页本身加进页面清单时,请求地址和最终地址一致,不会被当成"被挡住"。
 * 这是启发式判断,不保证所有站点都准确;判断不出来时,页面仍按普通页面保存,由使用者自己看截图。
 */
export function detectLoginWall(input: {
  requested: string;
  finalUrl: string | null;
  httpStatus: number | null;
  structure: PageStructure | null;
}): LoginWall | null {
  const { requested, finalUrl, httpStatus, structure } = input;
  if (httpStatus === 401) return { reason: '页面返回 401,需要登录' };

  const hasPassword = structure?.forms.some((f) => f.fields.some((x) => x.type === 'password')) ?? false;
  if (!hasPassword) return null;

  if (finalUrl && location(finalUrl) !== location(requested)) {
    let where = finalUrl;
    try {
      where = new URL(finalUrl).pathname || finalUrl;
    } catch {
      /* 保持原样 */
    }
    return { reason: `页面跳转到了登录页(${where})` };
  }
  if (httpStatus === 403) return { reason: '页面返回 403,并要求登录' };
  return null;
}
