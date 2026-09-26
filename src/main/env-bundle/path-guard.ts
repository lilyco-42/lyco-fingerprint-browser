// 解包导入文件时的条目安全检查：防止路径穿越、符号链接与设备文件

const ALLOWED_TYPES = new Set(['File', 'OldFile', 'ContiguousFile', 'Directory']);

/**
 * 判断 tar 条目能否被解出。
 * @param entryPath 条目路径（tar 内部统一用 /）
 * @param entryType tar 条目类型，只允许普通文件与目录
 * @param allowed   允许的精确路径或以 / 结尾的目录前缀
 */
export function isSafeEntry(entryPath: string, entryType: string, allowed: readonly string[]): boolean {
  if (!ALLOWED_TYPES.has(entryType)) return false;
  if (!entryPath || entryPath.includes('\0') || entryPath.includes('\\')) return false;
  if (entryPath.startsWith('/') || /^[A-Za-z]:/.test(entryPath)) return false;
  if (entryPath.split('/').some(s => s === '..')) return false;

  const normalized = entryPath.replace(/^(\.\/)+/, '');
  return allowed.some(rule => (rule.endsWith('/') ? normalized.startsWith(rule) : normalized === rule));
}
