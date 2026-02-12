import * as fs from 'fs';
import * as path from 'path';

export interface StructXConfig {
  repoPath: string;
  anthropicApiKey: string;
  analysisModel: string;
  classifierModel: string;
  answerModel: string;
  batchSize: number;
  diffThreshold: number;
  structxDir: string;
}

const DEFAULT_CONFIG: Omit<StructXConfig, 'repoPath' | 'anthropicApiKey' | 'structxDir'> = {
  analysisModel: 'claude-haiku-4-5-20251001',
  classifierModel: 'claude-haiku-4-5-20251001',
  answerModel: 'claude-sonnet-4-5-20250929',
  batchSize: 8,
  diffThreshold: 0.3,
};

export function getStructXDir(repoPath?: string): string {
  const base = repoPath || process.cwd();
  return path.join(base, '.structx');
}

export function getConfigPath(structxDir: string): string {
  return path.join(structxDir, 'config.json');
}

export function loadConfig(structxDir: string): StructXConfig {
  const configPath = getConfigPath(structxDir);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run 'structx init' first.`);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const apiKey = raw.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    anthropicApiKey: apiKey,
    structxDir,
  };
}

export function saveConfig(structxDir: string, config: Partial<StructXConfig>): void {
  const configPath = getConfigPath(structxDir);

  if (!fs.existsSync(structxDir)) {
    fs.mkdirSync(structxDir, { recursive: true });
  }

  // Don't persist the API key to disk if it came from env
  const toSave = { ...config };
  if (process.env.ANTHROPIC_API_KEY && toSave.anthropicApiKey === process.env.ANTHROPIC_API_KEY) {
    delete toSave.anthropicApiKey;
  }
  delete toSave.structxDir;

  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), 'utf-8');
}
