import * as path from 'path';

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

export function toRepoRelativePath(repoPath: string, filePath: string): string {
  return normalizeRepoPath(path.relative(repoPath, filePath));
}

export function formatLocation(filePath: string, line: number): string {
  return `${normalizeRepoPath(filePath)}:${line}`;
}
