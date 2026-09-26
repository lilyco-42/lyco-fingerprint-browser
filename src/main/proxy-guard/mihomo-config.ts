// 生成环境专用的 mihomo 运行配置：所有连接只经所选节点出站，不存在 DIRECT 出口

export const SELECTED_GROUP = 'MIRAGE-SELECTED';

type ProxyEntry = Record<string, unknown>;

export function buildEnvMihomoConfig(
  proxies: readonly ProxyEntry[],
  selectedName: string,
  socksPort: number,
  controlPort: number,
): Record<string, unknown> {
  if (!selectedName || !proxies.some(p => p['name'] === selectedName)) {
    throw new Error(`代理配置中找不到节点「${selectedName}」，请刷新订阅或重新选择线路`);
  }
  return {
    'socks-port': socksPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'mode': 'rule',
    'log-level': 'silent',
    'external-controller': `127.0.0.1:${controlPort}`,
    'proxies': proxies,
    // 经策略组引用节点，节点名含逗号等字符时规则也不会被拆坏
    'proxy-groups': [{ name: SELECTED_GROUP, type: 'select', proxies: [selectedName] }],
    'rules': [`MATCH,${SELECTED_GROUP}`],
  };
}
