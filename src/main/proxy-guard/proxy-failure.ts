// 代理故障的识别与诊断：只根据 Chrome 错误码与 mihomo 状态得出结论，不做任何网络请求

/** Chrome 中明确与代理链路相关的网络错误 */
const PROXY_ERRORS: ReadonlySet<string> = new Set([
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
  'net::ERR_TUNNEL_CONNECTION_FAILED',
  'net::ERR_PROXY_CERTIFICATE_INVALID',
  'net::ERR_NO_SUPPORTED_PROXIES',
]);

/**
 * mihomo 会先向浏览器回复 SOCKS 握手成功再连接上游节点，上游失败时 Chrome 只能看到这些通用连接错误，
 * 需要结合节点测速才能判断是否为代理故障
 */
const CONNECTION_ERRORS: ReadonlySet<string> = new Set([
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_FAILED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_TIMED_OUT',
  'net::ERR_SSL_PROTOCOL_ERROR',
]);

export function isProxyFailure(errorText: string): boolean {
  return PROXY_ERRORS.has(errorText);
}

export function shouldDiagnose(mode: 'mihomo' | 'simple', errorText: string): boolean {
  return isProxyFailure(errorText) || (mode === 'mihomo' && CONNECTION_ERRORS.has(errorText));
}

/** mihomo 意外退出时在主界面显示的异常说明 */
export const CORE_DOWN_ISSUE = '代理核心 mihomo 已退出，浏览器已断网（不会直连）';

export type ProxyFailureKind = 'core-down' | 'node-down' | 'proxy-unreachable' | 'target-unreachable';

export interface ProxyFailureDiagnosis {
  kind: ProxyFailureKind;
  title: string;
  detail: string;
  /** 需要在主界面标记为「代理异常」时的说明；目标网站自身不可达时为空 */
  issue?: string;
}

export type DiagnoseInput =
  | { mode: 'mihomo'; errorText: string; nodeName: string; coreRunning: boolean; nodeDelay: number }
  | { mode: 'simple'; errorText: string };

function diagnoseMihomo(input: Extract<DiagnoseInput, { mode: 'mihomo' }>): ProxyFailureDiagnosis | null {
  if (!input.coreRunning) {
    return {
      kind: 'core-down',
      title: '代理核心已停止',
      detail: '该环境的 mihomo 进程已退出。请在 Mirage 主界面点击「重启代理」，恢复后点击下方「重试」。',
      issue: CORE_DOWN_ISSUE,
    };
  }
  if (input.nodeDelay < 0) {
    return {
      kind: 'node-down',
      title: '线路不可用',
      detail: `节点「${input.nodeName}」测速失败，可能已失效或被墙。请稍后重试，或关闭环境后在「编辑」中更换线路。`,
      issue: `线路「${input.nodeName}」测速失败`,
    };
  }
  // 线路正常时，通用连接错误来自网站本身，保留 Chrome 原生错误页
  if (!isProxyFailure(input.errorText)) return null;
  return {
    kind: 'target-unreachable',
    title: '目标网站无法通过代理访问',
    detail: '代理线路本身可用，但无法经代理连接到该网站：网站可能暂时不可达，或拒绝了代理出口 IP。',
  };
}

/** 返回 null 表示不属于代理故障 */
export function diagnoseProxyFailure(input: DiagnoseInput): ProxyFailureDiagnosis | null {
  if (input.mode === 'mihomo') return diagnoseMihomo(input);
  if (input.errorText === 'net::ERR_PROXY_CONNECTION_FAILED') {
    return {
      kind: 'proxy-unreachable',
      title: '无法连接代理服务器',
      detail: '代理服务器没有响应，请确认代理程序（如 Burp Suite、mitmproxy）已启动且地址端口正确，然后点击「重试」。',
      issue: '无法连接代理服务器',
    };
  }
  return {
    kind: 'target-unreachable',
    title: '代理无法连接到目标网站',
    detail: '代理服务器已连接，但它拒绝或无法建立到该网站的连接。',
  };
}
