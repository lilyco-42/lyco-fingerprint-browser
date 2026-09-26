// 代理故障提示页：完全本地生成，CSP 禁止任何外部加载，避免提示页自身再发出网络请求
import type { ProxyFailureDiagnosis } from './proxy-failure';

export interface ErrorPageInput {
  envName: string;
  lineLabel: string;
  url: string;
  errorText: string;
  diagnosis: ProxyFailureDiagnosis;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value: string): string {
  return value.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

const STYLE = `
body{margin:0;font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f3f4f6;color:#1f2937}
main{max-width:640px;margin:12vh auto 0;padding:32px 36px;background:#fff;border:1px solid #e5e7eb;border-radius:10px}
h1{margin:0 0 4px;font-size:22px;color:#b91c1c}
.guard{margin:0 0 20px;color:#6b7280}
.detail{margin:0 0 20px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 24px;font-size:13px}
dt{color:#6b7280}dd{margin:0;word-break:break-all}
code{font:12px ui-monospace,Menlo,Consolas,monospace}
button{padding:6px 20px;font-size:14px;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}main{background:#1f2937;border-color:#374151}h1{color:#f87171}.guard,dt{color:#9ca3af}}
`;

export function buildProxyErrorPage(input: ErrorPageInput): string {
  const { envName, lineLabel, url, errorText, diagnosis } = input;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(diagnosis.title)}</title><style>${STYLE}</style></head>
<body><main>
<h1>${esc(diagnosis.title)}</h1>
<p class="guard">为防止泄漏真实 IP，浏览器不会绕过代理直连，此次访问已被阻断。</p>
<p class="detail">${esc(diagnosis.detail)}</p>
<dl>
<dt>环境</dt><dd>${esc(envName)}</dd>
<dt>线路</dt><dd>${esc(lineLabel)}</dd>
<dt>地址</dt><dd>${esc(url)}</dd>
<dt>错误</dt><dd><code>${esc(errorText)}</code></dd>
</dl>
<button type="button" onclick="location.reload()">重试</button>
</main></body></html>`;
}
