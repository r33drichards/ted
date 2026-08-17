// @ts-ignore — no type declarations for irc-framework
import IRC from 'irc-framework';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync } from 'fs';

/**
 * Split arbitrary text into IRC-safe PRIVMSG payloads:
 * - no CR/LF (collapse to spaces)
 * - each chunk <= `max` bytes (default 400, well under the 512 line cap
 *   so prefix + "PRIVMSG #chan :" fits).
 */
export function chunkForIrc(text: string, max = 400): string[] {
  const oneline = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oneline) return [];
  const out: string[] = [];
  let buf = '';
  for (const word of oneline.split(' ')) {
    if (!word) continue;
    const candidate = buf ? `${buf} ${word}` : word;
    if (Buffer.byteLength(candidate) <= max) {
      buf = candidate;
      continue;
    }
    if (buf) out.push(buf);
    if (Buffer.byteLength(word) <= max) {
      buf = word;
    } else {
      let b = Buffer.from(word);
      while (b.length > max) {
        out.push(b.subarray(0, max).toString('utf8'));
        b = b.subarray(max);
      }
      buf = b.toString('utf8');
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Cap text for IRC relay, keeping the head and noting the truncation.
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} … (${text.length - max} more chars truncated)`;
}

/**
 * Parse a bridge admin command (default prefix ","). Returns null when the
 * message is not a command. Commands are handled by the bridge itself and
 * never forwarded to the agent.
 */
export type AdminCommand = { verb: string; rest: string };

export function parseAdminCommand(msg: string, prefix = ','): AdminCommand | null {
  if (!msg.startsWith(prefix) || msg.length <= prefix.length) return null;
  const body = msg.slice(prefix.length).trim();
  if (!body) return null;
  const sp = body.indexOf(' ');
  const verb = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : body.slice(sp + 1).trim();
  return { verb, rest };
}

/** Normalize a raw-command payload: accept "/join #x" as "JOIN #x". */
export function normalizeRawLine(rest: string): string {
  let line = rest.trim();
  if (line.startsWith('/')) {
    line = line.slice(1);
    const sp = line.indexOf(' ');
    const verb = sp === -1 ? line : line.slice(0, sp);
    line = verb.toUpperCase() + (sp === -1 ? '' : line.slice(sp));
  }
  return line;
}

/** Split ",join #a,#b #c" style channel lists. */
export function parseChannelList(rest: string): string[] {
  return rest
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 1 && (c.startsWith('#') || c.startsWith('&')));
}

// ---------- runtime glue ----------

type Config = {
  server: string;
  port: number;
  tls: boolean;
  nick: string;
  channel: string;
  userId: string;
  webhookUrl: string;
  password?: string;
  bridgePort: number;
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function loadConfig(): Config {
  const channel = must('IRC_CHANNEL');
  if (!channel.startsWith('#') && !channel.startsWith('&')) {
    throw new Error('IRC_CHANNEL must start with # or &');
  }
  return {
    server: must('IRC_SERVER'),
    port: Number(process.env.IRC_PORT ?? 6667),
    tls: process.env.IRC_TLS === 'true',
    nick: process.env.IRC_NICK ?? 'ted-bot',
    channel,
    userId: must('IRC_USER_ID'),
    webhookUrl: process.env.WEBHOOK_URL ?? 'http://localhost:8787',
    password: process.env.IRC_PASSWORD,
    bridgePort: Number(process.env.IRC_BRIDGE_PORT ?? 8788),
  };
}

function sessionForChannel(channel: string): string {
  return `irc-${channel.replace(/^[#&]/, '')}`;
}

async function postToWebhook(
  cfg: Config,
  sessionId: string,
  msg: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${cfg.webhookUrl}/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-User-ID': cfg.userId,
    },
    body: JSON.stringify({ sessionId, msg, ...extra }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`webhook ${res.status}: ${body}`);
  }
}

/**
 * Minimal SSE parser over a fetch Response body. Yields each event's id
 * (when present) alongside its data so callers can resume from a cursor.
 */
async function* readSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<{ id: string | null; data: string }> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) {
    throw new Error(`sse ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let dataLines: string[] = [];
  let eventId: string | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (raw === '') {
        if (dataLines.length) {
          yield { id: eventId, data: dataLines.join('\n') };
          dataLines = [];
          eventId = null;
        }
        continue;
      }
      if (raw.startsWith(':')) continue;
      if (raw.startsWith('id:')) {
        eventId = raw.slice(3).replace(/^ /, '');
        continue;
      }
      if (raw.startsWith('data:')) {
        dataLines.push(raw.slice(5).replace(/^ /, ''));
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Stream cursor persistence — lets the bridge resume a session's    */
/*  delta stream after an IRC drop or process restart instead of      */
/*  skipping everything published while it was away.                  */
/* ------------------------------------------------------------------ */

const STATE_FILE = process.env.BRIDGE_STATE_FILE ?? '/tmp/ted-bridge-state.json';

function loadCursors(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const streamCursors: Record<string, string> = loadCursors();

function saveCursor(sessionId: string, id: string): void {
  streamCursors[sessionId] = id;
  try {
    writeFileSync(STATE_FILE, JSON.stringify(streamCursors));
  } catch {
    // best-effort
  }
}

const THINKING_MAX_CHARS = Number(process.env.IRC_THINKING_MAX_CHARS ?? 400);
const REPLY_MAX_CHARS = Number(process.env.IRC_REPLY_MAX_CHARS ?? 2400);

async function streamToIrc(
  cfg: Config,
  sessionId: string,
  signal: AbortSignal,
  sendPrivmsg: (text: string) => void,
): Promise<void> {
  // Resume from the last relayed event so nothing is lost across IRC
  // drops or bridge restarts — the Redis stream retains recent history.
  const cursor = streamCursors[sessionId];
  const url =
    `${cfg.webhookUrl}/sessions/${encodeURIComponent(sessionId)}/stream` +
    (cursor ? `?from=${encodeURIComponent(cursor)}` : '');
  const headers = { 'X-User-ID': cfg.userId };

  let thinking = '';
  let pending = '';
  for await (const { id, data } of readSse(url, headers, signal)) {
    let event: { type: string; text?: string; name?: string };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === 'delta' && typeof event.text === 'string') {
      pending += event.text;
    } else if (event.type === 'thinking' && typeof event.text === 'string') {
      thinking += event.text;
    } else if (event.type === 'tool_call' && event.name) {
      sendPrivmsg(`[using ${event.name}]`);
    } else if (event.type === 'turn_end') {
      if (thinking.trim()) {
        for (const chunk of chunkForIrc(`[thinking] ${capText(thinking, THINKING_MAX_CHARS)}`)) {
          sendPrivmsg(chunk);
        }
      }
      if (pending.trim()) {
        for (const chunk of chunkForIrc(capText(pending, REPLY_MAX_CHARS))) {
          sendPrivmsg(chunk);
        }
      }
      thinking = '';
      pending = '';
    }
    if (id) saveCursor(sessionId, id);
  }
}

async function main() {
  const cfg = loadConfig();
  console.log(
    `[irc] connecting to ${cfg.server}:${cfg.port} as ${cfg.nick}, joining ${cfg.channel}`,
  );

  // Prime the initial channel's session before connecting to IRC — retry
  // until the webhook is reachable so the bridge survives being started
  // before the ted service.
  for (let attempt = 1; ; attempt++) {
    try {
      await postToWebhook(
        cfg,
        sessionForChannel(cfg.channel),
        `[irc bridge online in ${cfg.channel}]`,
      );
      break;
    } catch (err) {
      console.error(
        `[irc] prime attempt ${attempt} failed:`,
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2000, 15000)));
    }
  }

  const client = new IRC.Client();

  client.connect({
    host: cfg.server,
    port: cfg.port,
    tls: cfg.tls,
    nick: cfg.nick,
    username: cfg.nick,
    gecos: cfg.nick,
    password: cfg.password || undefined,
    auto_reconnect: true,
    auto_reconnect_wait: 4000,
    auto_reconnect_max_retries: 0, // unlimited
  });

  const joined = new Set<string>();
  const streams = new Map<string, AbortController>();

  // Outbound pacing: one PRIVMSG per interval so long outputs can't trip
  // the server's flood protection (RecvQ exceeded → disconnect).
  const SAY_INTERVAL_MS = Number(process.env.IRC_SAY_INTERVAL_MS ?? 650);
  const SAY_QUEUE_MAX = Number(process.env.IRC_SAY_QUEUE_MAX ?? 60);
  const sayQueue: Array<{ channel: string; text: string }> = [];
  setInterval(() => {
    const item = sayQueue.shift();
    if (!item) return;
    try {
      client.say(item.channel, item.text);
    } catch (err) {
      // Likely mid-reconnect: put it back and retry next tick.
      sayQueue.unshift(item);
    }
  }, SAY_INTERVAL_MS);
  function enqueueSay(channel: string, text: string): void {
    if (sayQueue.length >= SAY_QUEUE_MAX) {
      if (sayQueue.length === SAY_QUEUE_MAX) {
        sayQueue.push({ channel, text: '[output dropped: flood protection]' });
      }
      return;
    }
    sayQueue.push({ channel, text });
  }

  function startStream(channel: string): void {
    if (streams.has(channel)) return;
    const sessionId = sessionForChannel(channel);
    const abort = new AbortController();
    streams.set(channel, abort);
    const sendPrivmsg = (text: string) => {
      enqueueSay(channel, text);
    };
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          await streamToIrc(cfg, sessionId, abort.signal, sendPrivmsg);
        } catch (err) {
          if (abort.signal.aborted) return;
          console.error(
            `[irc] stream error for ${channel}:`,
            (err as Error).message,
          );
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
  }

  function stopStream(channel: string): void {
    const abort = streams.get(channel);
    if (abort) {
      abort.abort();
      streams.delete(channel);
    }
    joined.delete(channel);
  }

  let everRegistered = false;

  client.on('registered', () => {
    everRegistered = true;
    console.log('[irc] registered, joining', cfg.channel);
    client.join(cfg.channel);
    // After a reconnect, re-JOIN any channels we were already in.
    for (const ch of joined) {
      if (ch !== cfg.channel) {
        console.log('[irc] re-joining', ch);
        client.join(ch);
      }
    }
    // Join the operator-managed autojoin list (stored in Postgres,
    // served by the webhook, CRUD'd via the agent's channels_* tools).
    void fetch(`${cfg.webhookUrl}/autojoin`, { headers: { 'X-User-ID': cfg.userId } })
      .then((r) => (r.ok ? r.json() : { channels: [] }))
      .then((body: any) => {
        for (const ch of body?.channels ?? []) {
          if (typeof ch === 'string' && !joined.has(ch)) {
            console.log('[irc] autojoin', ch);
            client.join(ch);
          }
        }
      })
      .catch((err) =>
        console.error('[irc] autojoin fetch failed:', (err as Error).message),
      );
  });

  client.on('join', (event: { channel: string; nick: string }) => {
    if (event.nick !== cfg.nick) return;
    console.log('[irc] joined', event.channel);
    const wasJoined = joined.has(event.channel);
    joined.add(event.channel);
    startStream(event.channel);
    // Best-effort prime for channels other than the initial one (which was
    // primed up-front with retry).
    if (!wasJoined && event.channel !== cfg.channel) {
      postToWebhook(
        cfg,
        sessionForChannel(event.channel),
        `[irc bridge joined ${event.channel}]`,
      ).catch((err) =>
        console.error(
          `[irc] prime ${event.channel} failed:`,
          (err as Error).message,
        ),
      );
    }
  });

  client.on('part', (event: { channel: string; nick: string }) => {
    if (event.nick !== cfg.nick) return;
    console.log('[irc] parted', event.channel);
    stopStream(event.channel);
  });

  client.on(
    'kick',
    (event: { channel: string; kicked: string; nick: string }) => {
      if (event.kicked !== cfg.nick) return;
      console.log('[irc] kicked from', event.channel, 'by', event.nick);
      stopStream(event.channel);
    },
  );

  // Admin commands handled by the bridge itself (never forwarded to the
  // agent), so they work even while the agent is mid-turn.
  async function handleAdminCommand(channel: string, cmd: AdminCommand): Promise<void> {
    const say = (text: string) => client.say(channel, `[admin] ${text}`);
    switch (cmd.verb) {
      case 'join': {
        const channels = parseChannelList(cmd.rest);
        if (channels.length === 0) return say('usage: ,join #chan[,#chan2 ...]');
        for (const ch of channels) client.join(ch);
        return say(`joining ${channels.join(', ')}`);
      }
      case 'part': {
        const channels = parseChannelList(cmd.rest);
        if (channels.length === 0) return say('usage: ,part #chan[,#chan2 ...]');
        for (const ch of channels) client.part(ch);
        return say(`parting ${channels.join(', ')}`);
      }
      case 'send': {
        const line = normalizeRawLine(cmd.rest);
        if (!line) return say('usage: ,send <raw irc line> (e.g. ,send /join #chan)');
        try {
          client.raw(line);
          return say(`sent: ${line}`);
        } catch (err) {
          return say(`send failed: ${(err as Error).message}`);
        }
      }
      case 'stop':
      case 'cancel': {
        try {
          const res = await fetch(
            `${cfg.webhookUrl}/sessions/${encodeURIComponent(sessionForChannel(channel))}/stop`,
            { method: 'POST', headers: { 'X-User-ID': cfg.userId } },
          );
          if (!res.ok) return say(`stop failed: webhook ${res.status}`);
          return say('stop requested — the turn halts at the next step boundary');
        } catch (err) {
          return say(`stop failed: ${(err as Error).message}`);
        }
      }
      case 'help':
        return say(',stop | ,join #a,#b | ,part #a | ,send <raw or /cmd> | ,help');
      default:
        return say(`unknown command "${cmd.verb}" — try ,help`);
    }
  }

  client.on(
    'privmsg',
    (event: { target: string; nick: string; message: string }) => {
      if (!joined.has(event.target)) return;
      // Ignore own messages and any stale instances with the same base nick
      const baseNick = (process.env.IRC_NICK ?? 'ted-bot');
      if (event.nick.startsWith(baseNick)) return;
      const cmd = parseAdminCommand(event.message);
      if (cmd) {
        void handleAdminCommand(event.target, cmd).catch((err) =>
          console.error('[irc] admin command failed:', (err as Error).message),
        );
        return;
      }
      const payload = `${event.nick}: ${event.message}`;
      postToWebhook(
        cfg,
        sessionForChannel(event.target),
        payload,
      ).catch((err) =>
        console.error('[irc] webhook post failed:', (err as Error).message),
      );
    },
  );

  client.on('reconnecting', () => {
    console.log('[irc] reconnecting...');
  });

  client.on('close', () => {
    console.error('[irc] connection closed');
    // If the very first registration attempt dies (e.g. the IRC server is
    // still holding a ghost connection from a previous container),
    // irc-framework's auto_reconnect does not always fire. Exit and let the
    // platform restart policy retry with a clean slate.
    if (!everRegistered) {
      console.error('[irc] connection closed before ever registering; exiting for restart');
      process.exit(1);
    }
  });

  process.on('SIGINT', () => {
    for (const abort of streams.values()) abort.abort();
    client.quit('shutting down');
    process.exit(0);
  });

  // HTTP control plane: POST /irc/raw { line }
  // No auth — bound to Railway's private network.
  const app = new Hono();
  app.post('/irc/raw', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof (body as any).line !== 'string') {
      return c.json({ error: 'line: string required' }, 400);
    }
    const line = (body as { line: string }).line.trim();
    if (!line) return c.json({ error: 'empty line' }, 400);
    if (/[\r\n]/.test(line)) {
      return c.json({ error: 'line must not contain CR/LF' }, 400);
    }
    if (Buffer.byteLength(line) > 510) {
      return c.json({ error: 'line exceeds 510 bytes' }, 400);
    }
    try {
      client.raw(line);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    return c.json({ ok: true });
  });
  console.log(`[irc] bridge HTTP listening on :${cfg.bridgePort}`);
  serve({ fetch: app.fetch, port: cfg.bridgePort });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
