import { describe, it, expect } from 'vitest';
import { isProxyFailure, shouldDiagnose, diagnoseProxyFailure } from './proxy-failure';

describe('isProxyFailure', () => {
  it.each([
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_SOCKS_CONNECTION_FAILED',
    'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'net::ERR_PROXY_CERTIFICATE_INVALID',
    'net::ERR_NO_SUPPORTED_PROXIES',
  ])('识别代理类错误 %s', err => {
    expect(isProxyFailure(err)).toBe(true);
  });

  it.each(['net::ERR_ABORTED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CERT_DATE_INVALID', ''])('忽略非代理错误 %s', err => {
    expect(isProxyFailure(err)).toBe(false);
  });
});

describe('shouldDiagnose', () => {
  it('mihomo 上游失败时 Chrome 只看到通用连接错误，也需要诊断', () => {
    for (const err of ['net::ERR_EMPTY_RESPONSE', 'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_TIMED_OUT']) {
      expect(shouldDiagnose('mihomo', err)).toBe(true);
      expect(shouldDiagnose('simple', err)).toBe(false);
    }
  });

  it('代理类错误两种模式都诊断，证书等错误都不诊断', () => {
    expect(shouldDiagnose('simple', 'net::ERR_PROXY_CONNECTION_FAILED')).toBe(true);
    expect(shouldDiagnose('mihomo', 'net::ERR_CERT_DATE_INVALID')).toBe(false);
  });
});

describe('diagnoseProxyFailure', () => {
  const base = { errorText: 'net::ERR_SOCKS_CONNECTION_FAILED', nodeName: 'HK-01' };

  it('mihomo 进程不在运行：代理核心已停止，提示重启代理', () => {
    const d = diagnoseProxyFailure({ ...base, mode: 'mihomo', coreRunning: false, nodeDelay: -1 });
    expect(d?.kind).toBe('core-down');
    expect(d?.issue).toMatch(/mihomo/);
    expect(d?.detail).toMatch(/重启代理/);
  });

  it('节点测速失败：线路不可用', () => {
    const d = diagnoseProxyFailure({ ...base, mode: 'mihomo', coreRunning: true, nodeDelay: -1 });
    expect(d?.kind).toBe('node-down');
    expect(d?.issue).toContain('HK-01');
  });

  it('节点正常：判定为目标网站经代理不可达，不标记代理异常', () => {
    const d = diagnoseProxyFailure({ ...base, mode: 'mihomo', coreRunning: true, nodeDelay: 120 });
    expect(d?.kind).toBe('target-unreachable');
    expect(d?.issue).toBeUndefined();
  });

  it('节点正常且是通用连接错误：属于网站自身问题，保留 Chrome 原生错误页', () => {
    expect(diagnoseProxyFailure({ ...base, errorText: 'net::ERR_EMPTY_RESPONSE', mode: 'mihomo', coreRunning: true, nodeDelay: 80 })).toBeNull();
  });

  it('节点不可用时通用连接错误也判定为线路不可用', () => {
    const d = diagnoseProxyFailure({ ...base, errorText: 'net::ERR_EMPTY_RESPONSE', mode: 'mihomo', coreRunning: true, nodeDelay: -1 });
    expect(d?.kind).toBe('node-down');
  });

  it('简单代理连不上代理服务器', () => {
    const d = diagnoseProxyFailure({ errorText: 'net::ERR_PROXY_CONNECTION_FAILED', mode: 'simple' });
    expect(d?.kind).toBe('proxy-unreachable');
    expect(d?.issue).toBeDefined();
  });

  it('简单代理其他错误视为代理无法连到目标网站', () => {
    const d = diagnoseProxyFailure({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED', mode: 'simple' });
    expect(d?.kind).toBe('target-unreachable');
    expect(d?.issue).toBeUndefined();
  });
});
