/**
 * Pure helpers extracted from the orchestrator: gate-reply classification,
 * human-comment detection (filters bot/symphony authors).
 */

import { describe, expect, test } from 'bun:test';
import { classifyApprovalIntent, findHumanReplyAfter, hasBotCommentAfter } from '../orchestrator/orchestrator.ts';

describe('classifyApprovalIntent', () => {
  test.each([
    ['approve'],
    ['APPROVED'],
    ['lgtm to me'],
    ['go ahead'],
    ['ship it'],
    ['yes please'],
    ['continue with the plan'],
  ])('classifies "%s" as approve', (text: string) => {
    expect(classifyApprovalIntent(text)).toBe('approve');
  });

  test.each([
    ['reject'],
    ['no, please abort'],
    ['cancel this'],
    ['stop the workflow'],
    ['abort now'],
  ])('classifies "%s" as reject', (text: string) => {
    expect(classifyApprovalIntent(text)).toBe('reject');
  });

  test.each([
    ['hmm not sure'],
    ['what about this?'],
    ['can you explain?'],
  ])('classifies "%s" as ambiguous', (text: string) => {
    expect(classifyApprovalIntent(text)).toBe('ambiguous');
  });

  test('trims surrounding whitespace before classifying', () => {
    expect(classifyApprovalIntent('   approve   ')).toBe('approve');
  });
});

describe('findHumanReplyAfter', () => {
  const pausedAt = Date.parse('2026-05-09T00:00:00Z');

  test('returns the latest non-bot comment after the pause timestamp', () => {
    const r = findHumanReplyAfter(
      [
        { id: 'c0', body: 'before pause', author: { id: 'h', name: 'Alice' }, created_at: '2026-05-08T23:00:00Z' },
        { id: 'c1', body: 'first reply', author: { id: 'h', name: 'Alice' }, created_at: '2026-05-09T00:01:00Z' },
        { id: 'c2', body: 'second reply', author: { id: 'h', name: 'Alice' }, created_at: '2026-05-09T00:02:00Z' },
      ],
      pausedAt,
    );
    expect(r?.id).toBe('c2');
    expect(r?.body).toBe('second reply');
    expect(r?.created_at).toBe('2026-05-09T00:02:00Z');
  });

  test('skips comments authored by symphony/gaggle/bot accounts', () => {
    const r = findHumanReplyAfter(
      [
        { id: 'c1', body: 'human reply', author: { id: 'h', name: 'Alice' }, created_at: '2026-05-09T00:01:00Z' },
        { id: 'c2', body: 'bot ack', author: { id: 'b', name: 'Symphony Bot' }, created_at: '2026-05-09T00:02:00Z' },
        { id: 'c3', body: 'gaggle ack', author: { id: 'g', name: 'GaggleDispatch' }, created_at: '2026-05-09T00:03:00Z' },
      ],
      pausedAt,
    );
    expect(r?.body).toBe('human reply');
  });

  test('skips anonymous comments (author.name=null)', () => {
    const r = findHumanReplyAfter(
      [{ id: 'c1', body: 'anon', author: { id: null, name: null }, created_at: '2026-05-09T00:01:00Z' }],
      pausedAt,
    );
    expect(r).toBeNull();
  });

  test('returns null when all comments are at or before pausedAt', () => {
    const r = findHumanReplyAfter(
      [{ id: 'c1', body: 'old', author: { id: 'h', name: 'Alice' }, created_at: '2026-05-08T00:00:00Z' }],
      pausedAt,
    );
    expect(r).toBeNull();
  });
});

describe('hasBotCommentAfter', () => {
  const t = Date.parse('2026-05-09T00:01:00Z');

  test('returns true when a bot comment exists after the given timestamp (by author name)', () => {
    expect(hasBotCommentAfter(
      [
        { body: 'hello', author: { name: 'Alice' }, created_at: '2026-05-09T00:02:00Z' },
        { body: 'done', author: { name: 'GaggleDispatch' }, created_at: '2026-05-09T00:03:00Z' },
      ],
      t,
    )).toBe(true);
  });

  test('returns true when a bot comment is identified by 🤖 body prefix (personal API key case)', () => {
    expect(hasBotCommentAfter(
      [
        { body: '🤖 I wasn\'t sure how to interpret that reply.', author: { name: 'Leo Romero' }, created_at: '2026-05-09T00:02:00Z' },
      ],
      t,
    )).toBe(true);
  });

  test('returns false when the only bot comment is before the timestamp', () => {
    expect(hasBotCommentAfter(
      [{ body: 'done', author: { name: 'Symphony Bot' }, created_at: '2026-05-09T00:00:00Z' }],
      t,
    )).toBe(false);
  });

  test('returns false when there are no bot comments at all', () => {
    expect(hasBotCommentAfter(
      [{ body: 'implement it', author: { name: 'Alice' }, created_at: '2026-05-09T00:02:00Z' }],
      t,
    )).toBe(false);
  });

  test('returns false for anonymous comments (author.name=null, no 🤖 prefix)', () => {
    expect(hasBotCommentAfter(
      [{ body: 'some comment', author: { name: null }, created_at: '2026-05-09T00:02:00Z' }],
      t,
    )).toBe(false);
  });
});
