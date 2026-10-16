import https from 'node:https';
import http from 'node:http';
import * as yaml from 'js-yaml';
import { newId } from './store';
import type { ProxyNode } from '../types';
import { saveSubscriptionBackup } from './mihomo-manager';

interface ClashConfig {
  proxies?: Array<Record<string, unknown>>;
}

const DEFAULT_SUBSCRIPTION_USER_AGENT = 'clash-verge/v2.5.1';
const MAX_REDIRECTS = 8;

function fetchUrl(url: string, userAgent?: string, redirectCount = 0, deadline = Date.now() + 15000): Promise<string> {
  const finalUserAgent = userAgent?.trim() || DEFAULT_SUBSCRIPTION_USER_AGENT;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      reject(new Error('订阅地址必须是 HTTP 或 HTTPS')); return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {reject(new Error('Subscription fetch timeout'));return;}
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': finalUserAgent,
        'Accept': '*/*',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();clearTimeout(timer);
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error('Subscription fetch redirect limit exceeded'));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        if (parsed.protocol === 'https:' && !nextUrl.startsWith('https:')) {reject(new Error('拒绝降低订阅连接安全级别'));return;}
        fetchUrl(nextUrl, finalUserAgent, redirectCount + 1, deadline).then(resolve).catch(reject);
        return;
      }
      if (status < 200 || status >= 300) {res.resume();clearTimeout(timer);reject(new Error('订阅下载失败（HTTP '+status+'）'));return;}
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (c: Buffer) => {bytes+=c.length;if(bytes>2_000_000)req.destroy(new Error('订阅配置过大'));else chunks.push(c);});
      res.on('error', error => {clearTimeout(timer);reject(error);});
      res.on('end', () => {clearTimeout(timer);resolve(Buffer.concat(chunks).toString('utf-8'));});
    });
    timer = setTimeout(() => req.destroy(new Error('Subscription fetch timeout')), remaining);
    req.on('error', error => {clearTimeout(timer);reject(error);});
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Subscription fetch timeout'));
    });
  });
}

function tryBase64Decode(str: string): string {
  const trimmed = str.trim().replace(/\n/g, '');
  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
      // Only use if decoding produced printable text
      if (decoded.includes('proxies:') || decoded.includes('vmess://') || decoded.includes('ss://')) {
        return decoded;
      }
    }
  } catch { /* ignore */ }
  return str;
}

function nodeToProxyNode(node: Record<string, unknown>, sourceId: string): ProxyNode {
  return {
    id: newId(),
    sourceId,
    name: String(node['name'] ?? 'Unknown'),
    type: String(node['type'] ?? 'unknown'),
    server: String(node['server'] ?? ''),
    port: Number(node['port'] ?? 0),
    rawYaml: yaml.dump([node]).trim(),
  };
}

export async function fetchSubscription(url: string, sourceId: string, userAgent?: string): Promise<ProxyNode[]> {
  let raw = await fetchUrl(url, userAgent);
  raw = tryBase64Decode(raw);

  try {
    const config = yaml.load(raw) as ClashConfig;
    if (config?.proxies && Array.isArray(config.proxies)) {
      saveSubscriptionBackup(sourceId, raw);
      return config.proxies.map(p => nodeToProxyNode(p, sourceId));
    }
  } catch { /* not valid YAML */ }

  return [];
}

export function parseYamlContent(content: string, sourceId: string): ProxyNode[] {
  try {
    const config = yaml.load(content) as ClashConfig;
    if (config?.proxies && Array.isArray(config.proxies)) {
      saveSubscriptionBackup(sourceId, content);
      return config.proxies.map(p => nodeToProxyNode(p, sourceId));
    }
  } catch { /* invalid YAML */ }
  return [];
}
