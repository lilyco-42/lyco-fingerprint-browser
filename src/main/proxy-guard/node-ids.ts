// 刷新订阅时按节点名称沿用旧 ID，避免环境引用的节点因 ID 变化而失效

import type { ProxyNode } from '../../types';

/** 同名节点按出现顺序一一沿用旧 ID，其余保留新 ID；返回新数组，不修改入参 */
export function preserveNodeIds(previous: readonly ProxyNode[], next: readonly ProxyNode[]): ProxyNode[] {
  const idsByName = new Map<string, string[]>();
  for (const n of previous) idsByName.set(n.name, [...(idsByName.get(n.name) ?? []), n.id]);
  return next.map(n => {
    const reused = idsByName.get(n.name)?.shift();
    return reused ? { ...n, id: reused } : n;
  });
}
