// 导入确认时渲染进程提交的修改（新名称、改用的线路），属于不可信输入，逐项校验

import type { ImportItemOverride, ImportProxyChoice } from '../../types';
import { MAX_SHORT_STR } from './manifest';

const MAX_NODE_ID_LENGTH = 64;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseProxyChoice(raw: unknown, where: string): ImportProxyChoice {
  if (!isObj(raw)) throw new Error(`${where}: 线路无效`);
  switch (raw['kind']) {
    case 'keep': return { kind: 'keep' };
    case 'none': return { kind: 'none' };
    case 'node': {
      const nodeId = raw['nodeId'];
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > MAX_NODE_ID_LENGTH) {
        throw new Error(`${where}: 线路节点无效`);
      }
      return { kind: 'node', nodeId };
    }
    default: throw new Error(`${where}: 未知的线路类型`);
  }
}

function parseOne(raw: unknown, where: string): ImportItemOverride {
  if (!isObj(raw)) throw new Error(`${where}: 应为对象`);
  const name = raw['name'];
  if (typeof name !== 'string') throw new Error(`${where}: 名称应为字符串`);
  const trimmed = name.trim();
  if (trimmed.length > MAX_SHORT_STR) throw new Error(`${where}: 名称不能超过 ${MAX_SHORT_STR} 个字符`);
  return { name: trimmed, proxy: parseProxyChoice(raw['proxy'], where) };
}

/** 未提供时返回空数组（全部沿用包内配置）；提供时数量必须与包内环境一一对应 */
export function parseImportOverrides(raw: unknown, count: number): ImportItemOverride[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length !== count) throw new Error('导入参数与待导入环境数量不一致');
  return raw.map((item, i) => parseOne(item, `第 ${i + 1} 个环境`));
}

export function overrideName(original: string, override: ImportItemOverride | undefined): string {
  return override?.name || original;
}
