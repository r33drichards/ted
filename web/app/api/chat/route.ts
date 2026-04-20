import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { openStream, postMessage } from '@/lib/ted';

export const runtime = 'nodejs';

// Matches ted's src/publish.ts StreamEvent.
type StreamEvent = { type: 'delta'; text: string } | { type: 'turn_end' };

/**
 * Chat endpoint consumed by `useChat`.
 *
 * Request: { id: string (sessionId), messages: [{role,content}], ... }
 *          — we only use the last user message + id.
 *
 * Response: AI-SDK v4 data-stream protocol. Each event is a line
 *   `0:"<escaped text chunk>"\n` for text deltas, and a terminator at the
 *   end of the turn. We translate ted's Redis-stream JSON events into this.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const userId = session.user.id;

  const body = (await req.json()) as {
    id: string;
    messages: { role: string; content: string }[];
  };
  const sessionId = body.id;
  const last = body.messages[body.messages.length - 1];
  if (!last || last.role !== 'user') {
    return new Response('no user message', { status: 400 });
  }

  // POST the message first — ted creates the session row on first /message,
  // and the stream endpoint 404s until that row exists. Then open the SSE
  // stream. There's a narrow race where the first deltas could land before
  // we subscribe; Bedrock's ~1s time-to-first-token in practice makes it
  // safe, and we could tighten further by replaying from stream id 0 if we
  // see gaps — deferred.
  const abort = new AbortController();
  await postMessage(userId, sessionId, last.content);
  const tedStream = await openStream(userId, sessionId, abort.signal);
  if (!tedStream.ok || !tedStream.body) {
    return new Response(`ted stream ${tedStream.status}`, { status: 502 });
  }

  const reader = tedStream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let buf = '';
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // SSE frames are separated by blank lines.
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = frame
              .split('\n')
              .find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            let event: StreamEvent;
            try {
              event = JSON.parse(json) as StreamEvent;
            } catch {
              continue;
            }
            if (event.type === 'delta') {
              // AI-SDK v4 text-part: `0:"<json-escaped>"\n`
              const payload = `0:${JSON.stringify(event.text)}\n`;
              controller.enqueue(encoder.encode(payload));
            } else if (event.type === 'turn_end') {
              // finish-message: `d:{"finishReason":"stop"}\n`
              controller.enqueue(
                encoder.encode(
                  `d:${JSON.stringify({ finishReason: 'stop' })}\n`,
                ),
              );
              controller.close();
              abort.abort();
              return;
            }
          }
        }
      } catch {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-vercel-ai-data-stream': 'v1',
    },
  });
}
