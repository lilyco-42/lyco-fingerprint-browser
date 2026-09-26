// 测试用：手工构造任意条目（含恶意路径、符号链接）的 tar.gz，绕过 node-tar 打包时的安全处理
import zlib from 'node:zlib';

export interface RawEntry {
  path: string;
  /** '0' 普通文件, '2' 符号链接, '5' 目录 */
  type?: '0' | '2' | '5';
  content?: string;
  linkpath?: string;
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(e: RawEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(e.path, 0, 100, 'utf-8');
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write('        ', 148);
  h.write(e.type ?? '0', 156);
  if (e.linkpath) h.write(e.linkpath, 157, 100, 'utf-8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  const sum = h.reduce((acc, b) => acc + b, 0);
  h.write(octal(sum, 7) + ' ', 148);
  return h;
}

export function buildRawTarGz(entries: RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.type === '0' || !e.type ? e.content ?? '' : '', 'utf-8');
    parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}
