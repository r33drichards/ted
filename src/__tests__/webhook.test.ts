import { describe, it, expect, vi } from 'vitest';
import { makeApp } from '../webhook.js';
import type { Msg } from '../types.js';

const USER = 'user-alice';
const AUTH = { 'X-User-ID': USER };

describe('webhook auth', () => {
  it('rejects requests without X-User-ID with 401', async () => {
    const app = makeApp({ signalWithStart: vi.fn(), taskQueue: 'chat' });
    const res = await app.request('/sessions');
    expect(res.status).toBe(401);
  });
});

describe('webhook /message', () => {
  it('rejects missing fields with 400', async () => {
    const signalWithStart = vi.fn();
    const app = makeApp({
      signalWithStart,
      taskQueue: 'chat',
      sessionBelongsTo: vi.fn().mockResolvedValue(true),
      createSession: vi.fn(),
    });

    const res = await app.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ sessionId: 'abc' }),
    });

    expect(res.status).toBe(400);
    expect(signalWithStart).not.toHaveBeenCalled();
  });

  it('creates session on first message and calls signalWithStart', async () => {
    const signalWithStart = vi.fn().mockResolvedValue({ workflowId: 'chat:abc' });
    const sessionBelongsTo = vi
      .fn()
      .mockResolvedValueOnce(false) // first check
      .mockResolvedValueOnce(true); // after createSession
    const createSession = vi.fn().mockResolvedValue(undefined);

    const app = makeApp({
      signalWithStart,
      taskQueue: 'chat',
      sessionBelongsTo,
      createSession,
    });

    const res = await app.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ sessionId: 'abc', msg: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith(USER, 'abc', null);
    expect(signalWithStart).toHaveBeenCalledTimes(1);
    const call = signalWithStart.mock.calls[0];
    expect(call[1]).toMatchObject({
      workflowId: 'chat:abc',
      taskQueue: 'chat',
      args: ['abc', [], USER],
      signalArgs: ['hello'],
    });
  });

  it('returns 403 when session already belongs to a different user', async () => {
    const signalWithStart = vi.fn();
    const sessionBelongsTo = vi.fn().mockResolvedValue(false); // both checks false
    const createSession = vi.fn().mockResolvedValue(undefined);

    const app = makeApp({
      signalWithStart,
      taskQueue: 'chat',
      sessionBelongsTo,
      createSession,
    });

    const res = await app.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ sessionId: 'taken', msg: 'hi' }),
    });
    expect(res.status).toBe(403);
    expect(signalWithStart).not.toHaveBeenCalled();
  });
});

describe('webhook /sessions/:id/messages', () => {
  it('returns messages scoped to owning user', async () => {
    const messages: Msg[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ];
    const getMessages = vi.fn().mockResolvedValue(messages);
    const sessionBelongsTo = vi.fn().mockResolvedValue(true);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      getMessages,
      sessionBelongsTo,
    });

    const res = await app.request('/sessions/abc/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'abc', messages });
    expect(getMessages).toHaveBeenCalledWith('abc', USER);
  });

  it('returns 404 when session not owned', async () => {
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      sessionBelongsTo: vi.fn().mockResolvedValue(false),
    });
    const res = await app.request('/sessions/xyz/messages', { headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe('webhook /sessions list', () => {
  it('returns the user\'s sessions', async () => {
    const rows = [{ id: 's1', title: 'first', updated_at: '2026-04-20T00:00:00Z' }];
    const getSessions = vi.fn().mockResolvedValue(rows);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      getSessions,
    });
    const res = await app.request('/sessions', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: rows });
    expect(getSessions).toHaveBeenCalledWith(USER);
  });
});

describe('webhook PATCH /sessions/:id', () => {
  it('renames when owned', async () => {
    const renameSession = vi.fn().mockResolvedValue(true);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      renameSession,
    });
    const res = await app.request('/sessions/abc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ title: 'New title' }),
    });
    expect(res.status).toBe(200);
    expect(renameSession).toHaveBeenCalledWith('abc', USER, 'New title');
  });

  it('returns 404 when not owned', async () => {
    const renameSession = vi.fn().mockResolvedValue(false);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      renameSession,
    });
    const res = await app.request('/sessions/abc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('archives when archived=true provided', async () => {
    const setSessionArchived = vi.fn().mockResolvedValue(true);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      setSessionArchived,
    });
    const res = await app.request('/sessions/abc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(200);
    expect(setSessionArchived).toHaveBeenCalledWith('abc', USER, true);
  });

  it('rejects empty payload', async () => {
    const app = makeApp({ signalWithStart: vi.fn(), taskQueue: 'chat' });
    const res = await app.request('/sessions/abc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('webhook DELETE /sessions/:id', () => {
  it('deletes when owned and signals the workflow', async () => {
    const sessionBelongsTo = vi.fn().mockResolvedValue(true);
    const deleteSession = vi.fn().mockResolvedValue(true);
    const signalClose = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      sessionBelongsTo,
      deleteSession,
      signalClose,
    });
    const res = await app.request('/sessions/abc', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(signalClose).toHaveBeenCalledWith('chat:abc');
    expect(deleteSession).toHaveBeenCalledWith('abc', USER);
  });

  it('returns 404 when not owned', async () => {
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      sessionBelongsTo: vi.fn().mockResolvedValue(false),
    });
    const res = await app.request('/sessions/abc', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('still deletes DB rows when signalClose throws', async () => {
    const deleteSession = vi.fn().mockResolvedValue(true);
    const signalClose = vi.fn().mockRejectedValue(new Error('not running'));
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      sessionBelongsTo: vi.fn().mockResolvedValue(true),
      deleteSession,
      signalClose,
    });
    const res = await app.request('/sessions/abc', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalled();
  });
});

describe('webhook /sessions/:id/stream', () => {
  it('emits SSE events from the injected subscriber', async () => {
    async function* fakeSubscribe() {
      yield { id: '1-0', event: { type: 'delta' as const, text: 'hi' } };
      yield { id: '2-0', event: { type: 'turn_end' as const } };
    }
    const subscribeDeltas = vi.fn(() => fakeSubscribe());
    const sessionBelongsTo = vi.fn().mockResolvedValue(true);
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      subscribeDeltas: subscribeDeltas as any,
      sessionBelongsTo,
    });

    const res = await app.request('/sessions/abc/stream', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('id: 1-0');
    expect(body).toContain('data: {"type":"delta","text":"hi"}');
    expect(body).toContain('id: 2-0');
    expect(body).toContain('data: {"type":"turn_end"}');
  });

  it('returns 404 when session not owned', async () => {
    const app = makeApp({
      signalWithStart: vi.fn(),
      taskQueue: 'chat',
      sessionBelongsTo: vi.fn().mockResolvedValue(false),
    });
    const res = await app.request('/sessions/x/stream', { headers: AUTH });
    expect(res.status).toBe(404);
  });
});
