import { describe, expect, test } from 'bun:test';
import { saveAnalysis, getAnalysis, deleteAnalysis } from '../registry/analysis-registry.ts';
import { tmp, makeAnalysis } from './helpers/fixtures.ts';

describe('AnalysisRegistry', () => {
  test('getAnalysis returns null for unknown issue', () => {
    const dir = tmp();
    expect(getAnalysis(dir, 'iss-x')).toBeNull();
  });

  test('saveAnalysis then getAnalysis round-trips the data', () => {
    const dir = tmp();
    const analysis = makeAnalysis();
    saveAnalysis(dir, 'iss-1', analysis);
    const result = getAnalysis(dir, 'iss-1');
    expect(result).toEqual(analysis);
  });

  test('saveAnalysis overwrites existing entry', () => {
    const dir = tmp();
    saveAnalysis(dir, 'iss-1', makeAnalysis([], 'first'));
    saveAnalysis(dir, 'iss-1', makeAnalysis([], 'second'));
    expect(getAnalysis(dir, 'iss-1')?.analysis_summary).toBe('second');
  });

  test('deleteAnalysis removes the entry', () => {
    const dir = tmp();
    saveAnalysis(dir, 'iss-1', makeAnalysis());
    deleteAnalysis(dir, 'iss-1');
    expect(getAnalysis(dir, 'iss-1')).toBeNull();
  });

  test('deleteAnalysis is a no-op for unknown issue', () => {
    const dir = tmp();
    expect(() => deleteAnalysis(dir, 'iss-x')).not.toThrow();
  });

  test('data persists across load calls (simulating restart)', () => {
    const dir = tmp();
    const analysis = makeAnalysis();
    saveAnalysis(dir, 'iss-1', analysis);
    const result = getAnalysis(dir, 'iss-1');
    expect(result?.issue_id).toBe('iss-1');
  });

  test('multiple issues are independent', () => {
    const dir = tmp();
    saveAnalysis(dir, 'iss-1', makeAnalysis([], 'for-1'));
    saveAnalysis(dir, 'iss-2', makeAnalysis([], 'for-2'));
    expect(getAnalysis(dir, 'iss-1')?.analysis_summary).toBe('for-1');
    expect(getAnalysis(dir, 'iss-2')?.analysis_summary).toBe('for-2');
  });
});
