import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type PackageLike = {
  version?: unknown;
};

let cachedVersion: string | null = null;

/**
 * 插件版本单一来源：读取随插件一起发布的 package.json。
 * 失败时回退到 "0.0.0" 以避免启动期崩溃。
 */
export function getPluginVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const here = fileURLToPath(import.meta.url);
    const packageJsonPath = path.resolve(path.dirname(here), '../package.json');
    const raw = readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as PackageLike;
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    cachedVersion = version || '0.0.0';
    return cachedVersion;
  } catch {
    cachedVersion = '0.0.0';
    return cachedVersion;
  }
}

