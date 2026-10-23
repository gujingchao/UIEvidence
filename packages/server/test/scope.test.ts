import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isUrlAllowed, normalizeDomains, ScopeError } from '../src/scope.js';

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
