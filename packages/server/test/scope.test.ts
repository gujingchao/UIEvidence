import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isHostAllowed, isUrlAllowed, normalizeDomains, ScopeError } from '../src/scope.js';

describe('域名白名单', () => {
  it('精确匹配主机名,忽略端口', () => {
    expect(isUrlAllowed('http://example.com/a', ['example.com'])).toBe(true);
    expect(isUrlAllowed('https://example.com:8443/a', ['example.com'])).toBe(true);
    expect(isUrlAllowed('https://www.example.com/', ['example.com'])).toBe(false);
  });

  it('通配符只匹配子域名,不含主域名本身', () => {
    expect(isUrlAllowed('https://www.example.com/', ['*.example.com'])).toBe(true);
    expect(isUrlAllowed('https://a.b.example.com/', ['*.example.com'])).toBe(true);
    expect(isUrlAllowed('https://example.com/', ['*.example.com'])).toBe(false);
    expect(isUrlAllowed('https://evilexample.com/', ['*.example.com'])).toBe(false);
  });

  it('条目带端口时端口必须一致', () => {
    expect(isUrlAllowed('http://127.0.0.1:4000/', ['127.0.0.1:4000'])).toBe(true);
    expect(isUrlAllowed('http://127.0.0.1:4001/', ['127.0.0.1:4000'])).toBe(false);
  });

  it.each([
    ['http://example.com/', 'example.com:80'],
    ['http://example.com:80/', 'example.com:80'],
    ['https://example.com/', 'example.com:443'],
    ['https://example.com:443/', 'example.com:443'],
    ['https://www.example.com/', '*.example.com:443'],
  ])('默认端口也能匹配白名单:%s', (url, domain) => {
    expect(isUrlAllowed(url, [domain])).toBe(true);
  });

  it('默认端口不能放行其他协议的端口或非默认端口', () => {
    expect(isUrlAllowed('https://example.com/', ['example.com:80'])).toBe(false);
    expect(isUrlAllowed('http://example.com/', ['example.com:443'])).toBe(false);
    expect(isUrlAllowed('https://example.com:8443/', ['example.com:443'])).toBe(false);
  });

  it('IPv6 白名单支持端口、默认端口和等价的地址写法', () => {
    expect(isUrlAllowed('http://[::1]:4100/', ['[::1]:4100'])).toBe(true);
    expect(isUrlAllowed('http://[::1]:4101/', ['[::1]:4100'])).toBe(false);
    expect(isUrlAllowed('http://[::1]:4100/', ['[::1]'])).toBe(true);
    expect(isUrlAllowed('http://[::1]/', ['[::1]:80'])).toBe(true);
    expect(isUrlAllowed('https://[::1]/', ['[0:0:0:0:0:0:0:1]:443'])).toBe(true);
    expect(isUrlAllowed('http://[::2]:4100/', ['[::1]:4100'])).toBe(false);
  });

  it('登录状态的 IPv6 主机名与白名单使用相同的归一化规则', () => {
    expect(isHostAllowed('[::1]', ['[::1]:4100'])).toBe(true);
    expect(isHostAllowed('::1', ['[0:0:0:0:0:0:0:1]:4100'])).toBe(true);
    expect(isHostAllowed('[::2]', ['[::1]'])).toBe(false);
  });

  it('127.0.0.1 和 localhost 是不同的主机名', () => {
    expect(isUrlAllowed('http://localhost:4000/', ['127.0.0.1'])).toBe(false);
  });

  it('不是 http(s) 的网址不通过', () => {
    expect(isUrlAllowed('file:///etc/passwd', ['example.com'])).toBe(false);
    expect(isUrlAllowed('javascript:alert(1)', ['example.com'])).toBe(false);
    expect(() => assertUrlAllowed('ftp://example.com', ['example.com'])).toThrow(ScopeError);
  });

  it('白名单为空时拒绝所有网址', () => {
    expect(() => assertUrlAllowed('http://example.com', [])).toThrow(/没有设置域名白名单/);
  });

  it('归一化:去掉协议、路径和大小写,去重', () => {
    expect(normalizeDomains([' HTTPS://Example.com/path ', 'example.com', ''])).toEqual(['example.com']);
  });
});
