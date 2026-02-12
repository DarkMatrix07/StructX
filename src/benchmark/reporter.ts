import type { BenchmarkRunResult } from './runner';
import * as fs from 'fs';
import * as path from 'path';

export function generateMarkdownReport(results: BenchmarkRunResult[]): string {
  const lines: string[] = [];

  lines.push('# StructX Benchmark Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Summary table
  lines.push('## Results');
  lines.push('');
  lines.push('| # | Question | Mode | Input Tokens | Output Tokens | Cost | Time (ms) | Context |');
  lines.push('|---|----------|------|-------------|---------------|------|-----------|---------|');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const shortQ = r.question.length > 40 ? r.question.slice(0, 40) + '...' : r.question;

    if (r.structx) {
      lines.push(`| ${i + 1} | ${shortQ} | StructX | ${r.structx.inputTokens} | ${r.structx.outputTokens} | $${r.structx.cost.toFixed(4)} | ${r.structx.responseTimeMs} | ${r.structx.functionsRetrieved} functions |`);
    }
    if (r.traditional) {
      lines.push(`| ${i + 1} | ${shortQ} | Traditional | ${r.traditional.inputTokens} | ${r.traditional.outputTokens} | $${r.traditional.cost.toFixed(4)} | ${r.traditional.responseTimeMs} | ${r.traditional.filesAccessed} files |`);
    }
  }

  // Aggregate statistics
  lines.push('');
  lines.push('## Summary Statistics');
  lines.push('');

  const structxRuns = results.filter(r => r.structx).map(r => r.structx!);
  const traditionalRuns = results.filter(r => r.traditional).map(r => r.traditional!);

  if (structxRuns.length > 0 && traditionalRuns.length > 0) {
    const avgStructxTokens = avg(structxRuns.map(r => r.inputTokens + r.outputTokens));
    const avgTraditionalTokens = avg(traditionalRuns.map(r => r.inputTokens + r.outputTokens));
    const tokenReduction = ((avgTraditionalTokens - avgStructxTokens) / avgTraditionalTokens * 100);

    const avgStructxCost = avg(structxRuns.map(r => r.cost));
    const avgTraditionalCost = avg(traditionalRuns.map(r => r.cost));
    const costReduction = ((avgTraditionalCost - avgStructxCost) / avgTraditionalCost * 100);

    const avgStructxTime = avg(structxRuns.map(r => r.responseTimeMs));
    const avgTraditionalTime = avg(traditionalRuns.map(r => r.responseTimeMs));

    lines.push('| Metric | StructX | Traditional | Improvement |');
    lines.push('|--------|---------|-------------|-------------|');
    lines.push(`| Avg Tokens | ${avgStructxTokens.toFixed(0)} | ${avgTraditionalTokens.toFixed(0)} | ${tokenReduction.toFixed(1)}% reduction |`);
    lines.push(`| Avg Cost | $${avgStructxCost.toFixed(4)} | $${avgTraditionalCost.toFixed(4)} | ${costReduction.toFixed(1)}% reduction |`);
    lines.push(`| Avg Time | ${avgStructxTime.toFixed(0)}ms | ${avgTraditionalTime.toFixed(0)}ms | ${((avgTraditionalTime - avgStructxTime) / avgTraditionalTime * 100).toFixed(1)}% faster |`);
    lines.push(`| Total Cost | $${sum(structxRuns.map(r => r.cost)).toFixed(4)} | $${sum(traditionalRuns.map(r => r.cost)).toFixed(4)} | |`);
  }

  return lines.join('\n');
}

export function generateCsvReport(results: BenchmarkRunResult[]): string {
  const lines: string[] = [];
  lines.push('question,mode,input_tokens,output_tokens,total_tokens,cost_usd,response_time_ms,context_size');

  for (const r of results) {
    const q = `"${r.question.replace(/"/g, '""')}"`;
    if (r.structx) {
      lines.push(`${q},structx,${r.structx.inputTokens},${r.structx.outputTokens},${r.structx.inputTokens + r.structx.outputTokens},${r.structx.cost.toFixed(6)},${r.structx.responseTimeMs},${r.structx.functionsRetrieved}`);
    }
    if (r.traditional) {
      lines.push(`${q},traditional,${r.traditional.inputTokens},${r.traditional.outputTokens},${r.traditional.inputTokens + r.traditional.outputTokens},${r.traditional.cost.toFixed(6)},${r.traditional.responseTimeMs},${r.traditional.filesAccessed}`);
    }
  }

  return lines.join('\n');
}

export function saveReport(
  structxDir: string,
  markdownContent: string,
  csvContent: string
): { markdownPath: string; csvPath: string } {
  const reportsDir = path.join(structxDir, 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const markdownPath = path.join(reportsDir, `benchmark-${timestamp}.md`);
  const csvPath = path.join(reportsDir, `benchmark-${timestamp}.csv`);

  fs.writeFileSync(markdownPath, markdownContent, 'utf-8');
  fs.writeFileSync(csvPath, csvContent, 'utf-8');

  return { markdownPath, csvPath };
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}
