import { describe, it, expect } from 'vitest';
import { preserveNodeIds } from './node-ids';
import type { ProxyNode } from '../../types';

function node(id: string, name: string, extra: Partial<ProxyNode> = {}): ProxyNode {
  return { id, sourceId: 's', name, type: 'ss', server: '1.1.1.1', port: 1, rawYaml: '', ...extra };
}

describe('preserveNodeIds', () => {
  it('同名节点沿用旧 ID，新节点保留新 ID，不修改入参', () => {
    const prev = [node('old-a', 'HK'), node('old-b', 'JP')];
    const next = [node('new-1', 'JP', { server: '2.2.2.2' }), node('new-2', 'US')];
    const out = preserveNodeIds(prev, next);
    expect(out.map(n => n.id)).toEqual(['old-b', 'new-2']);
    expect(out[0].server).toBe('2.2.2.2');
    expect(next[0].id).toBe('new-1');
  });

  it('重名节点按出现顺序一一对应', () => {
    const prev = [node('o1', 'X'), node('o2', 'X')];
    const next = [node('n1', 'X'), node('n2', 'X'), node('n3', 'X')];
    expect(preserveNodeIds(prev, next).map(n => n.id)).toEqual(['o1', 'o2', 'n3']);
  });

  it('没有旧节点时原样返回', () => {
    const next = [node('n1', 'A')];
    expect(preserveNodeIds([], next)).toEqual(next);
  });
});
