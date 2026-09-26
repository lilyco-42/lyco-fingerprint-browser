import { describe, it, expect } from 'vitest';
import { parseImportOverrides, overrideName } from './import-overrides';
import { MAX_SHORT_STR } from './manifest';

const keep = { kind: 'keep' } as const;

describe('parseImportOverrides', () => {
  it('未提供覆盖项时返回空数组', () => {
    expect(parseImportOverrides(undefined, 2)).toEqual([]);
    expect(parseImportOverrides(null, 2)).toEqual([]);
  });

  it('解析合法覆盖项，名称去除首尾空白，丢弃多余字段', () => {
    const out = parseImportOverrides([
      { name: '  新名字 ', proxy: keep, extra: 1 },
      { name: '', proxy: { kind: 'none' } },
      { name: 'x', proxy: { kind: 'node', nodeId: 'n-1', junk: true } },
    ], 3);
    expect(out).toEqual([
      { name: '新名字', proxy: keep },
      { name: '', proxy: { kind: 'none' } },
      { name: 'x', proxy: { kind: 'node', nodeId: 'n-1' } },
    ]);
  });

  it.each([
    ['非数组', { name: 'a' }],
    ['数量不一致', [{ name: 'a', proxy: keep }]],
    ['元素不是对象', ['a', 'b']],
    ['名称不是字符串', [{ name: 1, proxy: keep }, { name: '', proxy: keep }]],
    ['名称过长', [{ name: 'x'.repeat(MAX_SHORT_STR + 1), proxy: keep }, { name: '', proxy: keep }]],
    ['线路缺失', [{ name: 'a' }, { name: '', proxy: keep }]],
    ['未知线路类型', [{ name: 'a', proxy: { kind: 'direct' } }, { name: '', proxy: keep }]],
    ['节点 ID 缺失', [{ name: 'a', proxy: { kind: 'node' } }, { name: '', proxy: keep }]],
    ['节点 ID 过长', [{ name: 'a', proxy: { kind: 'node', nodeId: 'n'.repeat(65) } }, { name: '', proxy: keep }]],
  ])('拒绝非法输入：%s', (_label, raw) => {
    expect(() => parseImportOverrides(raw, 2)).toThrow();
  });
});

describe('overrideName', () => {
  it('有新名称时使用新名称，否则沿用原名', () => {
    expect(overrideName('原名', { name: '新名', proxy: keep })).toBe('新名');
    expect(overrideName('原名', { name: '', proxy: keep })).toBe('原名');
    expect(overrideName('原名', undefined)).toBe('原名');
  });
});
