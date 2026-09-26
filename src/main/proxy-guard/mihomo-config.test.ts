import { describe, it, expect } from 'vitest';
import { buildEnvMihomoConfig, SELECTED_GROUP } from './mihomo-config';

const proxies = [
  { name: 'HK-01', type: 'ss', server: '1.1.1.1', port: 443 },
  { name: 'JP,01', type: 'ss', server: '2.2.2.2', port: 443 },
];

describe('buildEnvMihomoConfig', () => {
  it('全部流量经选定节点，仅监听本机', () => {
    const cfg = buildEnvMihomoConfig(proxies, 'HK-01', 41000, 50000);
    expect(cfg).toMatchObject({
      'socks-port': 41000,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      'mode': 'rule',
      'external-controller': '127.0.0.1:50000',
      'proxy-groups': [{ name: SELECTED_GROUP, type: 'select', proxies: ['HK-01'] }],
      'rules': [`MATCH,${SELECTED_GROUP}`],
    });
    expect(cfg['proxies']).toEqual(proxies);
  });

  it('节点名称含逗号时仍能正确引用', () => {
    const cfg = buildEnvMihomoConfig(proxies, 'JP,01', 41000, 50000);
    expect(cfg['proxy-groups']).toEqual([{ name: SELECTED_GROUP, type: 'select', proxies: ['JP,01'] }]);
    expect(cfg['rules']).toEqual([`MATCH,${SELECTED_GROUP}`]);
  });

  it('找不到所选节点时报错，不生成会直连的配置', () => {
    expect(() => buildEnvMihomoConfig(proxies, 'US-01', 41000, 50000)).toThrow(/找不到节点/);
    expect(() => buildEnvMihomoConfig([], 'HK-01', 41000, 50000)).toThrow(/找不到节点/);
    expect(() => buildEnvMihomoConfig(proxies, '', 41000, 50000)).toThrow();
  });
});
