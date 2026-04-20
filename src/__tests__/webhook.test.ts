import { describe, it, expect, vi } from 'vitest';
import { makeApp } from '../webhook.js';
import type { Msg } from '../types.js';

describe('webhook /message', () => {
  it('rejects missing fields with 400', async () => {
    const signalWithStart = vi.fn();
    const app = makeApp({
      signalWithStart,
      taskQueue: 'chat',
    });

    const res = await app.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'abc' }), // missing msg
    });

    expect(res.status).toBe(400);
    expect(signalWithStart).not.toHaveBeenCalled();
  });

  it('calls signalWithStart with the right arguments', async () => {
    const signalWithStart = vi.fn().mockResolvedValue({ workflowId: 'chat:abc' });
    const app = makeApp({
      signalWithStart,
      taskQueue: 'chat',
    });

    const res = await app.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'abc', msg: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(signalWithStart).toHaveBeenCalledTimes(1);
    const call = signalWithStart.mock.calls[0];
    expect(call[1]).toMatchObject({
      workflowId: 'chat:abc',
      taskQueue: 'chat',
      args: ['abc'],
      signalArgs: ['hello'],
    });
  });
});

describe('webhook /sessions/:id/messages', () => {
  it('returns messages from the injected reader', async () => {
    const messages: Msg[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ];
    const getMessages = vi.fn().mockResolvedValue(messages);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      getMessages,
    });

    const res = await app.request('/sessions/abc/messages');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'abc', messages });
    expect(getMessages).toHaveBeenCalledWith('abc');
  });
});

describe('webhook /sessions/:id/stream', () => {
  it('emits SSE events from the injected subscriber', async () => {
    async function* fakeSubscribe() {
      yield { id: '1-0', event: { type: 'delta' as const, text: 'hi' } };
      yield { id: '2-0', event: { type: 'turn_end' as const } };
    }
    const subscribeDeltas = vi.fn(() => fakeSubscribe());
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      subscribeDeltas: subscribeDeltas as any,
    });

    const res = await app.request('/sessions/abc/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('id: 1-0');
    expect(body).toContain('data: {"type":"delta","text":"hi"}');
    expect(body).toContain('id: 2-0');
    expect(body).toContain('data: {"type":"turn_end"}');
  });
});
