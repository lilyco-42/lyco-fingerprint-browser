// 测试用的环境/代理样例数据
import type { Environment, ProxySource, ProxyNode } from '../../types';

export function makeEnv(over: Partial<Environment> = {}): Environment {
  return {
    id: 'env-1',
    name: '测试环境',
    createdAt: '2026-01-01T00:00:00.000Z',
    userAgent: 'Mozilla/5.0 Test',
    fingerprint: {
      timezone: 'Asia/Tokyo', language: 'ja', latitude: 35.6, longitude: 139.7,
      canvasSeed: 1, webglSeed: 2, hardwareConcurrency: 8, screenWidth: 1920, screenHeight: 1080,
      colorDepth: 24, deviceMemory: 8, screenRefreshRate: 60, platform: 'Win32', architecture: 'x86',
      maxTouchPoints: 0, devicePixelRatio: 1, networkEffectiveType: '4g', batteryCharging: true,
      batteryLevel: 0.8, gpuVendor: 'Google Inc.', gpuRenderer: 'ANGLE',
    },
    proxyMode: '',
    proxySimple: '',
    proxySourceId: '',
    proxyNodeId: '',
    notes: '',
    homePage: '',
    ...over,
  };
}

export function makeSource(over: Partial<ProxySource> = {}): ProxySource {
  return {
    id: 'src-1', name: '机场', type: 'subscription', url: 'https://sub.example.com/a',
    nodeCount: 2, lastUpdated: '', createdAt: '', ...over,
  };
}

export function makeNode(over: Partial<ProxyNode> = {}): ProxyNode {
  return {
    id: 'node-1', sourceId: 'src-1', name: 'HK-01', type: 'ss', server: '1.1.1.1', port: 443,
    rawYaml: '- name: HK-01\n  type: ss\n  server: 1.1.1.1\n  port: 443', ...over,
  };
}

export function seqId(prefix = 'new'): () => string {
  let i = 0;
  return () => `${prefix}-${++i}`;
}
