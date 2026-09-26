import { describe, it, expect } from 'vitest';
import { buildProxyErrorPage } from './error-page';
import { diagnoseProxyFailure } from './proxy-failure';

const found = diagnoseProxyFailure({ errorText: 'net::ERR_PROXY_CONNECTION_FAILED', mode: 'simple' });
if (!found) throw new Error('fixture');
const diagnosis = found;

function page(over: Partial<Parameters<typeof buildProxyErrorPage>[0]> = {}): string {
  return buildProxyErrorPage({
    envName: '环境 A', lineLabel: '机场 - HK-01', url: 'http://example.com/', errorText: 'net::ERR_PROXY_CONNECTION_FAILED', diagnosis, ...over,
  });
}

describe('buildProxyErrorPage', () => {
  it('包含环境、线路、地址、错误码与诊断结论', () => {
    const html = page();
    for (const text of ['环境 A', '机场 - HK-01', 'http://example.com/', 'ERR_PROXY_CONNECTION_FAILED', diagnosis.title, diagnosis.detail]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('不会绕过代理直连');
  });

  it('转义所有动态内容，防止被恶意 URL 或名称注入', () => {
    const html = page({ envName: '<img src=x onerror=alert(1)>', url: 'http://a.com/"><script>alert(1)</script>' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('完全自包含：CSP 禁止任何外部加载，不引用外部资源', () => {
    const html = page();
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(/i);
  });

  it('提供重试按钮', () => {
    expect(page()).toContain('location.reload()');
  });
});
