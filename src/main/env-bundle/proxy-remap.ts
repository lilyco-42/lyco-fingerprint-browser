// 导入时把包内的代理源/节点映射到本机：能复用则复用，否则新建并重新分配 ID

import * as yaml from 'js-yaml';
import type { Environment, ProxySource, ProxyNode, ProxyImportAction, ImportProxyChoice } from '../../types';
import type { BundleItem, BundleProxy } from './manifest';

export interface ProxyImportResult {
  action: ProxyImportAction;
  /** 用于预览展示的源名称 */
  sourceName: string;
  nodeName: string;
  proxySourceId: string;
  proxyNodeId: string;
}

export interface NewProxySource {
  source: ProxySource;
  nodes: ProxyNode[];
}

export interface ProxyImportPlan {
  results: ProxyImportResult[];
  newSources: NewProxySource[];
}

interface PlanContext {
  existingSources: readonly ProxySource[];
  existingNodes: readonly ProxyNode[];
  genId: () => string;
  now: string;
  /** 同一次导入内，相同的包内源只新建一次 */
  created: Map<string, { source: ProxySource; nodeIdMap: Map<string, string> }>;
  newSources: NewProxySource[];
}

function sourceKey(src: ProxySource): string {
  return src.type === 'subscription' && src.url ? `url:${src.url}` : `id:${src.id}`;
}

function empty(action: ProxyImportAction, sourceName = '', nodeName = ''): ProxyImportResult {
  return { action, sourceName, nodeName, proxySourceId: '', proxyNodeId: '' };
}

function tryReuse(proxy: BundleProxy, nodeName: string, ctx: PlanContext): ProxyImportResult | null {
  const { source } = proxy;
  if (source.type !== 'subscription' || !source.url) return null;
  const local = ctx.existingSources.find(s => s.type === 'subscription' && s.url === source.url);
  if (!local) return null;
  const localNode = ctx.existingNodes.find(n => n.sourceId === local.id && n.name === nodeName);
  if (!localNode) return null;
  return { action: 'reuse', sourceName: local.name, nodeName, proxySourceId: local.id, proxyNodeId: localNode.id };
}

function createSource(proxy: BundleProxy, ctx: PlanContext): { source: ProxySource; nodeIdMap: Map<string, string> } {
  const key = sourceKey(proxy.source);
  const cached = ctx.created.get(key);
  if (cached) return cached;

  const source: ProxySource = {
    id: ctx.genId(),
    name: `${proxy.source.name} (导入)`,
    type: proxy.source.type,
    // 文件型源的路径属于导出方机器，本机无意义
    url: proxy.source.type === 'subscription' ? proxy.source.url : '',
    nodeCount: proxy.nodes.length,
    lastUpdated: ctx.now,
    createdAt: ctx.now,
  };
  const nodeIdMap = new Map<string, string>();
  const nodes = proxy.nodes.map(n => {
    const id = ctx.genId();
    nodeIdMap.set(n.id, id);
    return { id, sourceId: source.id, name: n.name, type: n.type, server: n.server, port: n.port, rawYaml: n.rawYaml };
  });
  const entry = { source, nodeIdMap };
  ctx.created.set(key, entry);
  ctx.newSources.push({ source, nodes });
  return entry;
}

/** 用户指定改用本机已有节点 */
function planLocalNode(nodeId: string, ctx: PlanContext): ProxyImportResult {
  const node = ctx.existingNodes.find(n => n.id === nodeId);
  const source = node ? ctx.existingSources.find(s => s.id === node.sourceId) : undefined;
  if (!node || !source) throw new Error('所选线路不存在，可能已被删除，请重新选择');
  return { action: 'reuse', sourceName: source.name, nodeName: node.name, proxySourceId: source.id, proxyNodeId: node.id };
}

function planOne(item: BundleItem, ctx: PlanContext, choice: ImportProxyChoice | undefined): ProxyImportResult {
  if (choice?.kind === 'none') return empty('none');
  if (choice?.kind === 'node') return planLocalNode(choice.nodeId, ctx);

  const { env, proxy } = item;
  if (env.proxyMode === 'simple') return empty('simple');
  if (env.proxyMode !== 'mihomo') return empty('none');

  const refNode = proxy?.nodes.find(n => n.id === env.proxyNodeId);
  if (!proxy || !refNode) return empty('missing', proxy?.source.name ?? '');

  const reused = tryReuse(proxy, refNode.name, ctx);
  if (reused) return reused;

  const { source, nodeIdMap } = createSource(proxy, ctx);
  return {
    action: 'create',
    sourceName: source.name,
    nodeName: refNode.name,
    proxySourceId: source.id,
    proxyNodeId: nodeIdMap.get(refNode.id) ?? '',
  };
}

export function planProxyImports(
  items: readonly BundleItem[],
  existingSources: readonly ProxySource[],
  existingNodes: readonly ProxyNode[],
  genId: () => string,
  now: string,
  /** 与 items 一一对应的用户线路选择，缺省表示沿用包内配置 */
  choices: readonly ImportProxyChoice[] = [],
): ProxyImportPlan {
  const ctx: PlanContext = { existingSources, existingNodes, genId, now, created: new Map(), newSources: [] };
  const results = items.map((item, i) => planOne(item, ctx, choices[i]));
  return { results, newSources: ctx.newSources };
}

/** 把映射结果应用到环境上，返回新对象 */
export function applyProxyResult(env: Environment, result: ProxyImportResult): Environment {
  const ids = { proxySourceId: result.proxySourceId, proxyNodeId: result.proxyNodeId };
  switch (result.action) {
    case 'none': return { ...env, ...ids, proxyMode: '', proxySimple: '' };
    case 'reuse':
    case 'create': return { ...env, ...ids, proxyMode: 'mihomo', proxySimple: '' };
    default: return { ...env, ...ids };
  }
}

/**
 * 由节点 rawYaml 重建 mihomo 订阅备份内容（{ proxies: [...] }）。
 * rawYaml 可能是单个对象，也可能是只含一个元素的数组（订阅解析时的格式）。
 */
export function buildProxiesYaml(nodes: readonly ProxyNode[]): string {
  const proxies: Array<Record<string, unknown>> = [];
  for (const n of nodes) {
    try {
      const parsed = yaml.load(n.rawYaml);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        if (p && typeof p === 'object' && (p as Record<string, unknown>)['name']) {
          proxies.push(p as Record<string, unknown>);
        }
      }
    } catch { /* 跳过损坏的节点 YAML */ }
  }
  return yaml.dump({ proxies });
}
