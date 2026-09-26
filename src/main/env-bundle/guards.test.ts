import { describe, it, expect } from 'vitest';
import { isSafeEntry } from './path-guard';
import { shouldIncludeProfileEntry } from './profile-filter';

const ALLOWED = ['manifest.json', 'profiles/env-1/'];

describe('isSafeEntry', () => {
  it.each([
    ['manifest.json', 'File'],
    ['./manifest.json', 'File'],
    ['profiles/env-1/', 'Directory'],
    ['profiles/env-1/Default/Cookies', 'File'],
    ['profiles/env-1/Default/Local Storage/leveldb/000003.log', 'OldFile'],
  ])('允许 %s (%s)', (p, t) => {
    expect(isSafeEntry(p, t, ALLOWED)).toBe(true);
  });

  it.each([
    ['../etc/passwd', 'File'],
    ['profiles/env-1/../../x', 'File'],
    ['/etc/passwd', 'File'],
    ['C:/Windows/x', 'File'],
    ['profiles\\env-1\\x', 'File'],
    ['profiles/env-1/a\0b', 'File'],
    ['', 'File'],
    ['profiles/env-2/x', 'File'],
    ['profiles/env-10/x', 'File'],
    ['other.json', 'File'],
    ['profiles/env-1/link', 'SymbolicLink'],
    ['profiles/env-1/hard', 'Link'],
    ['profiles/env-1/dev', 'CharacterDevice'],
  ])('拒绝 %s (%s)', (p, t) => {
    expect(isSafeEntry(p, t, ALLOWED)).toBe(false);
  });
});

describe('shouldIncludeProfileEntry', () => {
  it.each([
    'Default/Cookies',
    'Default/Local Storage/leveldb/CURRENT',
    'Default/Extensions/abc/1.0/manifest.json',
    'Local State',
    'Default\\Bookmarks',
    '.',
  ])('保留 %s', p => {
    expect(shouldIncludeProfileEntry(p)).toBe(true);
  });

  it.each([
    'Default/Cache/Cache_Data/f_000001',
    'Default/Code Cache/js/index',
    'Default/Service Worker/CacheStorage/abc',
    'GrShaderCache/data_0',
    'SingletonLock',
    'SingletonSocket',
    'lockfile',
    'Crashpad/settings.dat',
    'Default\\GPUCache\\index',
  ])('排除 %s', p => {
    expect(shouldIncludeProfileEntry(p)).toBe(false);
  });
});
