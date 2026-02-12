import type { FunctionRow } from '../db/queries';

export interface DiffResult {
  signatureChanged: boolean;
  bodyChangedRatio: number;
  depsChanged: boolean;
}

export function shouldReanalyze(
  oldFunction: FunctionRow,
  newSignature: string,
  newCodeHash: string,
  newBody: string,
  threshold: number = 0.3
): { reanalyze: boolean; reason: string } {
  // New function (no old record)
  if (!oldFunction) {
    return { reanalyze: true, reason: 'new' };
  }

  // Code hash unchanged — nothing changed
  if (oldFunction.code_hash === newCodeHash) {
    return { reanalyze: false, reason: 'unchanged' };
  }

  // Signature changed
  if (oldFunction.signature !== newSignature) {
    return { reanalyze: true, reason: 'signature_changed' };
  }

  // Body changed significantly
  const diffRatio = calculateDiffRatio(oldFunction.body, newBody);
  if (diffRatio > threshold) {
    return { reanalyze: true, reason: 'body_changed' };
  }

  return { reanalyze: false, reason: 'minor_change' };
}

export function calculateDiffRatio(oldText: string, newText: string): number {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const oldSet = new Set(oldLines.map(l => l.trim()));
  const newSet = new Set(newLines.map(l => l.trim()));

  let changed = 0;
  for (const line of newSet) {
    if (!oldSet.has(line)) changed++;
  }
  for (const line of oldSet) {
    if (!newSet.has(line)) changed++;
  }

  const total = Math.max(oldLines.length, newLines.length, 1);
  return changed / total;
}

export function getPriority(reason: string, isExported: boolean): number {
  let base = 0;
  switch (reason) {
    case 'new': base = 5; break;
    case 'signature_changed': base = 10; break;
    case 'body_changed': base = 7; break;
    case 'deps_changed': base = 3; break;
    default: base = 1;
  }
  // Exported functions get higher priority
  return isExported ? base + 5 : base;
}
