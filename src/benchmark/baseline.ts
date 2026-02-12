import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
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
  apiKey: string
): Promise<BaselineResult> {
  const client = new Anthropic({ apiKey });

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

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseTimeMs = Date.now() - startTime;

  const answer = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as any).text)
    .join('');

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  return {
    answer,
    inputTokens,
    outputTokens,
    cost: estimateCost(model, inputTokens, outputTokens),
    responseTimeMs,
    filesAccessed,
  };
}
