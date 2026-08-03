import * as fs from 'fs';
import * as path from 'path';
import type { LlmClientConfig, LlmProvider } from './utils/llm';

export interface StructXConfig {
  repoPath: string;
  // Kept named anthropicApiKey for backwards compatibility with existing config.json
  // files; the value is the API key for whichever provider is configured.
  anthropicApiKey: string;
  provider: LlmProvider;
  baseURL?: string;
  analysisModel: string;
  classifierModel: string;
  answerModel: string;
  answerMaxTokens: number;
  batchSize: number;
  diffThreshold: number;
  // Resolve call targets through the TypeScript type checker during ingest.
  // On by default: it is what makes the call graph exact rather than a
  // name-matching guess. Costs roughly 40% more ingest time, so very large
  // repos can set this to false in .structx/config.json and fall back to the
  // pre-3.4 name-based resolver.
  typeResolution: boolean;
  structxDir: string;
}

const ANTHROPIC_DEFAULTS = {
  analysisModel: 'claude-haiku-4-5-20251001',
  classifierModel: 'claude-haiku-4-5-20251001',
  answerModel: 'claude-sonnet-4-5-20250929',
};

const GEMINI_DEFAULTS = {
  // Cheap-fast pick for batch analysis and fast-path classification, smarter
  // model for the answerer where reasoning matters most.
  analysisModel: 'gemini-2.0-flash',
  classifierModel: 'gemini-2.0-flash',
  answerModel: 'gemini-2.5-pro-preview-06-05',
};

const OPENROUTER_DEFAULTS = {
  // Sensible cheap-but-capable picks. Users can override per-project in config.json.
  analysisModel: 'anthropic/claude-haiku-4.5',
  classifierModel: 'anthropic/claude-haiku-4.5',
  answerModel: 'anthropic/claude-sonnet-4.5',
};

const DEFAULT_CONFIG: Omit<StructXConfig, 'repoPath' | 'anthropicApiKey' | 'structxDir' | 'provider' | 'analysisModel' | 'classifierModel' | 'answerModel'> = {
  answerMaxTokens: 1024,
  batchSize: 8,
  diffThreshold: 0.3,
  typeResolution: true,
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

  // Provider precedence: explicit config > whichever env var is set.
  // Detection priority when multiple env keys are present matches the README:
  // Anthropic > Gemini > OpenRouter.
  const provider: LlmProvider = raw.provider ?? detectProviderFromEnv();

  const envKey = pickApiKeyForProvider(provider);
  const apiKey = raw.anthropicApiKey || envKey;

  const providerDefaults = provider === 'openrouter'
    ? OPENROUTER_DEFAULTS
    : provider === 'gemini'
      ? GEMINI_DEFAULTS
      : ANTHROPIC_DEFAULTS;
  const repoPath = resolveConfiguredRepoPath(raw.repoPath, structxDir);

  return {
    ...DEFAULT_CONFIG,
    ...providerDefaults,
    ...raw,
    repoPath,
    provider,
    classifierModel: raw.classifierModel ?? raw.queryModel ?? providerDefaults.classifierModel,
    answerModel: raw.answerModel ?? raw.queryModel ?? providerDefaults.answerModel,
    answerMaxTokens: normalizeAnswerMaxTokens(raw.answerMaxTokens),
    typeResolution: raw.typeResolution !== false,
    anthropicApiKey: apiKey,
    structxDir,
  };
}

function detectProviderFromEnv(): LlmProvider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return 'anthropic';
}

function pickApiKeyForProvider(provider: LlmProvider): string {
  if (provider === 'gemini') {
    return process.env.GEMINI_API_KEY
      || process.env.GOOGLE_API_KEY
      || '';
  }
  if (provider === 'openrouter') {
    return process.env.OPENROUTER_API_KEY
      || process.env.ANTHROPIC_API_KEY
      || '';
  }
  return process.env.ANTHROPIC_API_KEY || '';
}

function normalizeAnswerMaxTokens(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : DEFAULT_CONFIG.answerMaxTokens;

  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.answerMaxTokens;
  const integer = Math.floor(parsed);
  if (integer < 64) return 64;
  if (integer > 8192) return 8192;
  return integer;
}

function resolveConfiguredRepoPath(rawRepoPath: string | undefined, structxDir: string): string {
  const fallback = path.dirname(structxDir);
  if (!rawRepoPath) return fallback;
  if (fs.existsSync(rawRepoPath)) return path.resolve(rawRepoPath);

  // Repair legacy Windows drive-relative paths such as "E:StructX-demo" that
  // should have been persisted as "E:\\StructX-demo".
  if (/^[A-Za-z]:[^\\/]/.test(rawRepoPath)) {
    const repaired = `${rawRepoPath.slice(0, 2)}\\${rawRepoPath.slice(2)}`;
    if (fs.existsSync(repaired)) return path.resolve(repaired);
  }

  const resolved = path.resolve(rawRepoPath);
  if (fs.existsSync(resolved)) return resolved;
  return fallback;
}

// Build the LLM client config consumed by analyzer/classifier/answerer from a
// loaded StructXConfig. Centralized so all three call sites stay in sync if
// the provider list grows or new fields (organization, project) are added.
export function getLlmConfig(config: StructXConfig): LlmClientConfig {
  return {
    provider: config.provider,
    apiKey: config.anthropicApiKey,
    baseURL: config.baseURL,
  };
}

// Add `.structx/` to the project's .gitignore so the local SQLite DB doesn't
// get committed. Idempotent — checks for an existing entry under any common
// spelling. Returns true when the file was modified.
export function ensureStructxGitignored(repoPath: string): boolean {
  const gitignorePath = path.join(repoPath, '.gitignore');

  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = existing.split(/\r?\n/).map(l => l.trim());
    if (lines.some(l => l === '.structx' || l === '.structx/' || l === '/.structx' || l === '/.structx/')) {
      return false;
    }
  }

  const block = (existing && !existing.endsWith('\n') ? '\n' : '')
    + '\n# StructX local knowledge graph\n.structx/\n';
  fs.appendFileSync(gitignorePath, block, 'utf-8');
  return true;
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
