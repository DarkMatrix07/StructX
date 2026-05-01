import * as fs from 'fs';
import * as path from 'path';
import type { LLMProvider } from '../providers/interface';
import { scanDirectory } from '../ingest/scanner';
import { estimateCost } from '../utils/tokens';

export interface BaselineResult {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  responseTimeMs: number;
  filesAccessed: number;
}

export async function runBaseline(
  question: string,
  repoPath: string,
  model: string,
  provider: LLMProvider
): Promise<BaselineResult> {
  // Read all TypeScript files
  const files = scanDirectory(repoPath);
  let codeContext = '';
  let filesAccessed = 0;

  for (const filePath of files) {
    const relativePath = path.relative(repoPath, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    codeContext += `\n--- ${relativePath} ---\n${content}\n`;
    filesAccessed++;
  }

  const prompt = `You are a code analysis assistant. Below is the complete source code of a TypeScript project. Answer the developer's question based on this code.

${codeContext}

Question: ${question}`;

  const startTime = Date.now();

  const response = await provider.chat({
    model,
    maxTokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseTimeMs = Date.now() - startTime;

  return {
    answer: response.text,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cost: estimateCost(model, response.inputTokens, response.outputTokens),
    responseTimeMs,
    filesAccessed,
  };
}
