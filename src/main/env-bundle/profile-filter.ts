// 导出 Chrome Profile 时需要跳过的内容：可再生的缓存、运行时锁文件与符号链接

/** 目录或文件名命中任一项即整体跳过（按路径片段精确匹配） */
const EXCLUDED_NAMES = new Set([
  // 缓存（可再生，体积大）
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'CacheStorage',
  'ScriptCache',
  'component_crx_cache',
  'optimization_guide_model_store',
  'BrowserMetrics',
  'Crashpad',
  // 运行时锁（mac/linux 为指向本机进程的符号链接，Windows 为 lockfile）
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
]);

/**
 * 判断 chrome_data 下的相对路径是否应打包导出。
 * @param relPath 相对 chrome_data 的路径，分隔符可为 / 或 \
 */
export function shouldIncludeProfileEntry(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(s => s !== '' && s !== '.');
  return !segments.some(s => EXCLUDED_NAMES.has(s));
}
