/**
 * 域名白名单。条目写法:
 *   example.com        只匹配该主机名(任意端口)
 *   *.example.com      匹配所有子域名,不含 example.com 本身
 *   127.0.0.1:4000     主机名加端口,端口必须一致
 */

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export function normalizeDomainEntry(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '');
  value = value.replace(/\/.*$/, '');
  return value;
}

export function normalizeDomains(list: string[]): string[] {
  const seen = new Set<string>();
  for (const item of list) {
    const value = normalizeDomainEntry(item);
    if (value) seen.add(value);
  }
  return [...seen];
}

/** 浏览器内部协议,不产生外部网络请求 */
const INTERNAL_PROTOCOLS = new Set(['data:', 'blob:', 'about:']);

export function isInternalUrl(url: string): boolean {
  try {
    return INTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function isUrlAllowed(url: string, domains: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port;

  return domains.some((entry) => {
    const [pattern = '', entryPort] = splitHostPort(entry);
    if (entryPort !== undefined && entryPort !== port) return false;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.length > suffix.length && host.endsWith(suffix);
    }
    return host === pattern;
  });
}

function splitHostPort(entry: string): [string, string | undefined] {
  // IPv6 形如 [::1]:4000
  const ipv6 = /^\[(.+)\](?::(\d+))?$/.exec(entry);
  if (ipv6) return [ipv6[1] ?? '', ipv6[2]];
  const idx = entry.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(entry.slice(idx + 1))) return [entry.slice(0, idx), entry.slice(idx + 1)];
  return [entry, undefined];
}

/** 入口检查:非 http(s) 或不在白名单内的网址直接拒绝 */
export function assertUrlAllowed(url: string, domains: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScopeError('网址格式不正确');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ScopeError('只支持 http 和 https 网址');
  }
  if (!isUrlAllowed(url, domains)) {
    throw new ScopeError(
      domains.length ? `该网址不在白名单内(${domains.join(', ')})` : '项目还没有设置域名白名单',
    );
  }
}
