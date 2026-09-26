// 监听页面会话的 CDP 事件：主框架因代理故障显示 Chrome 错误页后，将其替换为本地提示页；
// 主框架文档经网络成功返回时通知代理已恢复。

export interface FailureInfo {
  url: string;
  errorText: string;
}

export interface WatcherHooks {
  /** 主框架加载失败的错误码是否需要诊断 */
  shouldHandle(errorText: string): boolean;
  /** 返回要显示的 HTML；返回 null 表示保留 Chrome 原生错误页 */
  renderFailure(info: FailureInfo): Promise<string | null>;
  onRecovered(): void;
}

export type CdpSend = (method: string, params: unknown, sessionId?: string) => Promise<unknown>;

type Params = Record<string, unknown>;

interface SessionState {
  mainFrameId: string;
  /** 主框架正在进行的文档请求 */
  docRequests: Set<string>;
  lastError?: string;
  pending?: FailureInfo;
  /** 每次新导航递增，用于丢弃过期的异步替换 */
  generation: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function isNetworkDocument(response: Params): boolean {
  return /^https?:/i.test(str(response['url']))
    && !response['fromDiskCache'] && !response['fromServiceWorker'] && !response['fromPrefetchCache'];
}

export class ProxyFailureWatcher {
  private sessions = new Map<string, SessionState>();

  constructor(private send: CdpSend, private hooks: WatcherHooks) {}

  /** 页面 target 的主框架 ID 与 targetId 相同 */
  attach(sessionId: string, targetId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { mainFrameId: targetId, docRequests: new Set(), generation: 0 });
  }

  detach(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  handleEvent(method: string, params: Params, sessionId: string | undefined): void {
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!state || !sessionId) return;
    const isMain = (frameId: unknown): boolean => frameId === state.mainFrameId;

    switch (method) {
      case 'Page.frameStartedLoading':
        if (isMain(params['frameId'])) state.generation += 1;
        break;
      case 'Network.requestWillBeSent':
        if (params['type'] === 'Document' && isMain(params['frameId'])) state.docRequests.add(str(params['requestId']));
        break;
      case 'Network.loadingFailed':
        this.onLoadingFailed(state, params);
        break;
      case 'Network.responseReceived':
        if (params['type'] === 'Document' && isMain(params['frameId']) && isNetworkDocument((params['response'] ?? {}) as Params)) {
          state.lastError = undefined;
          this.hooks.onRecovered();
        }
        break;
      case 'Page.frameNavigated':
        this.onFrameNavigated(state, (params['frame'] ?? {}) as Params);
        break;
      case 'Page.frameStoppedLoading':
        if (isMain(params['frameId'])) this.replaceErrorPage(sessionId, state);
        break;
    }
  }

  private onLoadingFailed(state: SessionState, params: Params): void {
    const requestId = str(params['requestId']);
    if (!state.docRequests.delete(requestId)) return;
    const errorText = str(params['errorText']);
    if (this.hooks.shouldHandle(errorText)) state.lastError = errorText;
    else if (!params['canceled']) state.lastError = undefined;
  }

  private onFrameNavigated(state: SessionState, frame: Params): void {
    if (frame['id'] !== state.mainFrameId || frame['parentId']) return;
    state.generation += 1;
    const unreachableUrl = str(frame['unreachableUrl']);
    state.pending = unreachableUrl && state.lastError ? { url: unreachableUrl, errorText: state.lastError } : undefined;
    state.lastError = undefined;
  }

  private replaceErrorPage(sessionId: string, state: SessionState): void {
    const info = state.pending;
    if (!info) return;
    state.pending = undefined;
    const generation = state.generation;
    this.hooks.renderFailure(info)
      .then(html => {
        if (!html || this.sessions.get(sessionId) !== state || state.generation !== generation) return undefined;
        return this.send('Page.setDocumentContent', { frameId: state.mainFrameId, html }, sessionId);
      })
      .catch(e => console.error('[ProxyFailureWatcher] Failed to show proxy error page:', e));
  }
}
