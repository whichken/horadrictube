import { lstat, realpath, readdir, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, relative, sep, dirname, basename, extname, join } from 'node:path';
import type { Config, Runtime, Profile } from './config.ts';
import { HttpError } from './log.ts';

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export const isVideo = (path: string): boolean =>
  /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm|mpg|mpeg)$/i.test(path);
export const isGenerated = (path: string, suffix: string): boolean =>
  basename(path, extname(path)).toLowerCase().endsWith(suffix.toLowerCase()) ||
  / HEVC$/i.test(basename(path, extname(path))) ||
  basename(path).startsWith('.horadrictube-');
export function mapPath(input: string, config: Config, rt: Runtime): string {
  if (input.includes('\0') || input.includes('\\'))
    throw new HttpError(400, 'Use a valid POSIX media path');
  let mapped = input;
  const mappings = [...config.pathMappings].sort((a, b) => b.from.length - a.from.length);
  for (const mapping of mappings) {
    const from = mapping.from.replace(/\/+$/, '') || '/';
    if (input === from || input.startsWith(from === '/' ? '/' : from + '/')) {
      mapped = join(mapping.to, input.slice(from.length));
      break;
    }
  }
  const path = resolve(rt.dataDir, mapped);
  if (!inside(rt.dataDir, path))
    throw new HttpError(400, 'Path is outside DATA_DIR; configure pathMappings for remote paths');
  return path;
}
export async function sourcePath(path: string, rt: Runtime): Promise<string> {
  const [root, actual] = await Promise.all([realpath(rt.dataDir), realpath(path)]);
  if (!inside(root, actual)) throw new HttpError(400, 'Media symlink escapes DATA_DIR');
  return actual;
}
export async function collectFiles(input: string, config: Config, rt: Runtime): Promise<string[]> {
  const path = mapPath(input, config, rt);
  const actual = await sourcePath(path, rt);
  const st = await lstat(actual);
  if (st.isFile()) return [path];
  if (!st.isDirectory()) throw new HttpError(400, 'Path must be a regular file or directory');
  const files: string[] = [];
  // Deliberately bounded; symlinks are not followed during recursive scans.
  let visited = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 100000)
        throw new HttpError(
          413,
          'Directory scan exceeds 100000 entries; submit a smaller directory',
        );
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && isVideo(child) && !isGenerated(child, config.suffix)) {
        files.push(child);
        if (files.length > config.maxQueuedJobs)
          throw new HttpError(413, 'Directory exceeds queue capacity');
      }
    }
  }
  await walk(actual);
  // Preserve the mounted-root-relative path even when DATA_DIR is itself a symlink.
  const root = await realpath(rt.dataDir);
  return files.sort().map((file) => join(rt.dataDir, relative(root, file)));
}
export function outputPath(source: string, config: Config, rt: Runtime, profile?: Profile): string {
  const rel = relative(rt.dataDir, source);
  let stem = basename(source, extname(source));
  for (const rename of profile?.fileRenames ?? [])
    stem = stem.replace(new RegExp(rename.regex), rename.substitution);
  if (!stem.toLowerCase().endsWith(config.suffix.toLowerCase()) && !/ HEVC$/i.test(stem))
    stem += config.suffix;
  if (
    !stem ||
    stem.includes('/') ||
    stem.includes('\\') ||
    stem.includes('\0') ||
    stem === '.' ||
    stem === '..'
  )
    throw new Error('Filename rename must produce a filename, not a path');
  const filename = stem + '.mkv';
  const output = resolve(rt.outDir, dirname(rel), filename);
  if (!inside(rt.outDir, output)) throw new Error('Output escapes OUT_DIR');
  return output;
}
export async function prepareOutput(output: string, rt: Runtime): Promise<void> {
  const root = await realpath(rt.outDir);
  // Walk one component at a time so an existing escaping symlink cannot cause mkdir outside the mount.
  let current = rt.outDir;
  for (const part of relative(rt.outDir, dirname(output)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (!inside(root, await realpath(current))) throw new Error('Output symlink escapes OUT_DIR');
  }
}

export function routingConfig(config: Config, requested: string): Config {
  const profile = config.profiles[requested === 'auto' ? config.defaultProfile : requested];
  return profile?.pathMappings ? { ...config, pathMappings: profile.pathMappings } : config;
}
