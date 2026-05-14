/**
 * HttpClient abstraction tests. Verifies the test double
 * ({@link RecordingHttpClient}) behaves as expected — production
 * {@link FetchHttpClient} is exercised end-to-end via linear.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { RecordingHttpClient, type RecordedCall } from '../tracker/http-client.ts';

describe('RecordingHttpClient', () => {
  test('captures method, url, headers, and parsed JSON body', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ ok: true });
    await http.fetch('https://api.example/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 1 }),
    });
    expect(http.calls.length).toBe(1);
    expect(http.calls[0]?.url).toBe('https://api.example/x');
    expect(http.calls[0]?.method).toBe('POST');
    expect(http.calls[0]?.headers.Authorization).toBe('Bearer abc');
    expect(http.calls[0]?.body).toEqual({ q: 1 });
  });

  test('defaults method to GET when not provided', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('anything');
    await http.fetch('https://x');
    expect(http.calls[0]?.method).toBe('GET');
  });

  test('returns 200 by default for a queued response', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ hello: 'world' });
    const res = await http.fetch('https://x');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  test('honours an explicit status + ok in the response config', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ status: 401, body: 'denied' });
    const res = await http.fetch('https://x');
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe('denied');
  });

  test('supports response factories that read the request body', async () => {
    const http = new RecordingHttpClient();
    http.enqueue((req: RecordedCall) => ({ echoed: req.body }));
    const res = await http.fetch('https://x', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    });
    expect(await res.json()).toEqual({ echoed: { a: 1 } });
  });

  test('throws when the queue is empty (fail-fast)', async () => {
    const http = new RecordingHttpClient();
    await expect(http.fetch('https://x', { method: 'POST' })).rejects.toThrow(/no stubbed response/i);
  });

  test('throws message includes a GraphQL query snippet when the body has one', async () => {
    const http = new RecordingHttpClient();
    await expect(
      http.fetch('https://x', { method: 'POST', body: JSON.stringify({ query: 'query Foo { x }' }) }),
    ).rejects.toThrow(/GraphQL: query Foo/);
  });

  test('reset() empties calls and queue', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('a').enqueue('b');
    await http.fetch('https://x');
    http.reset();
    expect(http.calls.length).toBe(0);
    await expect(http.fetch('https://x')).rejects.toThrow();
  });

  test('queues drain in order', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('first', 'second', 'third');
    const r1 = await http.fetch('https://x');
    const r2 = await http.fetch('https://x');
    const r3 = await http.fetch('https://x');
    expect(await r1.json()).toBe('first');
    expect(await r2.json()).toBe('second');
    expect(await r3.json()).toBe('third');
  });

  test('preserves raw string body when JSON parsing fails', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('ok');
    await http.fetch('https://x', { method: 'POST', body: 'not-json' });
    expect(http.calls[0]?.body).toBe('not-json');
  });
});
