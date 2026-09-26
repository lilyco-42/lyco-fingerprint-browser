import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyFailureWatcher, type WatcherHooks } from './failure-watcher';

const SID = 'session-1';
const MAIN = 'target-1';

interface Sent { method: string; params: unknown; sessionId?: string }

function setup(render: WatcherHooks['renderFailure'] = async () => '<p>blocked</p>') {
  const sent: Sent[] = [];
  const send = vi.fn(async (method: string, params: unknown, sessionId?: string) => { sent.push({ method, params, sessionId }); return {}; });
  const hooks = { shouldHandle: vi.fn((err: string) => err.includes('PROXY')), renderFailure: vi.fn(render), onRecovered: vi.fn() };
  const watcher = new ProxyFailureWatcher(send, hooks);
  watcher.attach(SID, MAIN);
  const emit = (method: string, params: Record<string, unknown>, sessionId = SID) => watcher.handleEvent(method, params, sessionId);
  return { sent, hooks, watcher, emit };
}

const flush = () => new Promise(r => setTimeout(r, 0));

function failNavigation(emit: ReturnType<typeof setup>['emit'], errorText = 'net::ERR_PROXY_CONNECTION_FAILED', frameId = MAIN) {
  emit('Page.frameStartedLoading', { frameId });
  emit('Network.requestWillBeSent', { requestId: 'r1', type: 'Document', frameId, request: { url: 'http://example.com/' } });
  emit('Network.loadingFailed', { requestId: 'r1', type: 'Document', errorText, canceled: false });
  emit('Page.frameNavigated', { frame: { id: frameId, url: 'chrome-error://chromewebdata/', unreachableUrl: 'http://example.com/' } });
  emit('Page.frameStoppedLoading', { frameId });
}

describe('ProxyFailureWatcher', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('主框架因代理失败显示错误页后，替换为本地提示页', async () => {
    failNavigation(ctx.emit);
    await flush();
    expect(ctx.hooks.renderFailure).toHaveBeenCalledWith({ url: 'http://example.com/', errorText: 'net::ERR_PROXY_CONNECTION_FAILED' });
    expect(ctx.sent).toEqual([{ method: 'Page.setDocumentContent', params: { frameId: MAIN, html: '<p>blocked</p>' }, sessionId: SID }]);
  });

  it('shouldHandle 判定不处理的错误不替换', async () => {
    failNavigation(ctx.emit, 'net::ERR_CERT_DATE_INVALID');
    await flush();
    expect(ctx.hooks.shouldHandle).toHaveBeenCalledWith('net::ERR_CERT_DATE_INVALID');
    expect(ctx.hooks.renderFailure).not.toHaveBeenCalled();
    expect(ctx.sent).toEqual([]);
  });

  it('子框架失败不处理', async () => {
    failNavigation(ctx.emit, 'net::ERR_PROXY_CONNECTION_FAILED', 'iframe-1');
    await flush();
    expect(ctx.sent).toEqual([]);
  });

  it('未 attach 的会话与根会话事件被忽略', async () => {
    failNavigation((m, p) => ctx.watcher.handleEvent(m, p, 'unknown'));
    failNavigation((m, p) => ctx.watcher.handleEvent(m, p, undefined));
    await flush();
    expect(ctx.sent).toEqual([]);
  });

  it('诊断期间页面发生新导航则放弃替换', async () => {
    let release: (v: string) => void = () => undefined;
    const c = setup(() => new Promise<string>(r => { release = r; }));
    failNavigation(c.emit);
    c.emit('Page.frameStartedLoading', { frameId: MAIN });
    release('<p>late</p>');
    await flush();
    expect(c.sent).toEqual([]);
  });

  it('渲染钩子返回 null 或抛错时不替换', async () => {
    const nul = setup(async () => null);
    failNavigation(nul.emit);
    const bad = setup(async () => { throw new Error('boom'); });
    failNavigation(bad.emit);
    await flush();
    expect(nul.sent).toEqual([]);
    expect(bad.sent).toEqual([]);
  });

  it('正常导航提交后清除待处理的失败', async () => {
    ctx.emit('Network.requestWillBeSent', { requestId: 'r1', type: 'Document', frameId: MAIN });
    ctx.emit('Network.loadingFailed', { requestId: 'r1', type: 'Document', errorText: 'net::ERR_PROXY_CONNECTION_FAILED' });
    ctx.emit('Page.frameNavigated', { frame: { id: MAIN, url: 'https://ok.example/' } });
    ctx.emit('Page.frameStoppedLoading', { frameId: MAIN });
    await flush();
    expect(ctx.sent).toEqual([]);
  });

  it('主框架文档经网络成功返回时通知恢复，缓存或 data: 响应不算', () => {
    const doc = (response: Record<string, unknown>, frameId = MAIN) =>
      ctx.emit('Network.responseReceived', { requestId: 'x', type: 'Document', frameId, response });
    doc({ url: 'https://example.com/', fromDiskCache: true });
    doc({ url: 'data:text/html,hi' });
    doc({ url: 'https://example.com/', fromServiceWorker: true });
    doc({ url: 'https://example.com/' }, 'iframe-1');
    ctx.emit('Network.responseReceived', { type: 'Image', frameId: MAIN, response: { url: 'https://example.com/a.png' } });
    expect(ctx.hooks.onRecovered).not.toHaveBeenCalled();
    doc({ url: 'https://example.com/' });
    expect(ctx.hooks.onRecovered).toHaveBeenCalledTimes(1);
  });

  it('detach 后不再处理该会话', async () => {
    ctx.watcher.detach(SID);
    failNavigation(ctx.emit);
    await flush();
    expect(ctx.sent).toEqual([]);
  });
});
