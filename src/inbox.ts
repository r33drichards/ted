import type { Msg } from './types.js';

/**
 * Drains `inbox` into `history` as a single user turn.
 * Mutates both arrays. Returns the coalesced turn content, or `null` if
 * the inbox was empty (history is unchanged in that case).
 *
 * Coalesces multiple queued messages into one joined turn because Claude's
 * API requires alternating user/assistant roles.
 */
export function drainInbox(inbox: string[], history: Msg[]): string | null {
  if (inbox.length === 0) return null;
  const combined = inbox.splice(0).join('\n\n');
  history.push({ role: 'user', content: combined });
  return combined;
}
