import net from 'node:net';
import tls from 'node:tls';

export type IrcMessage = {
  prefix?: string;
  command: string;
  params: string[];
};

/**
 * Parse a single IRC line (without trailing CRLF) per RFC 1459 §2.3.1.
 * Returns null for empty input.
 */
export function parseIrcLine(line: string): IrcMessage | null {
  let rest = line;
  if (!rest) return null;

  let prefix: string | undefined;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }

  let command: string | undefined;
  const params: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    const tok = sp < 0 ? rest : rest.slice(0, sp);
    if (!command) command = tok;
    else params.push(tok);
    if (sp < 0) break;
    rest = rest.slice(sp + 1).replace(/^ +/, '');
  }
  if (!command) return null;
  return { prefix, command: command.toUpperCase(), params };
}

export function nickFromPrefix(prefix: string | undefined): string | null {
  if (!prefix) return null;
  const bang = prefix.indexOf('!');
  return bang < 0 ? prefix : prefix.slice(0, bang);
}

/**
 * Split arbitrary text into IRC-safe PRIVMSG payloads:
 * - no CR/LF (collapse to spaces)
 * - each chunk ≤ `max` bytes (default 400, well under the 512 line cap
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
      // single oversize word: hard-split on byte boundaries
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

// ---------- runtime glue ----------

type Config = {
  server: string;
  port: number;
  tls: boolean;
  nick: string;
  channel: string;
  sessionId: string;
  userId: string;
  webhookUrl: string;
  password?: string;
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
    sessionId: process.env.IRC_SESSION_ID ?? `irc-${channel.slice(1)}`,
    userId: must('IRC_USER_ID'),
    webhookUrl: process.env.WEBHOOK_URL ?? 'http://localhost:8787',
    password: process.env.IRC_PASSWORD,
  };
}

type LineSocket = {
  write(line: string): void;
  end(): void;
};

function connect(cfg: Config, onLine: (line: string) => void): Promise<LineSocket> {
  return new Promise((resolve, reject) => {
    const socket = cfg.tls
      ? tls.connect({ host: cfg.server, port: cfg.port, servername: cfg.server })
      : net.connect({ host: cfg.server, port: cfg.port });

    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    };

    const ready = () => {
      const api: LineSocket = {
        write(line: string) {
          socket.write(line + '\r\n');
        },
        end() {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
        },
      };
      resolve(api);
    };

    socket.once('error', reject);
    socket.on('data', onData);
    socket.on('close', () => {
      console.error('[irc] connection closed');
      process.exit(1);
    });

    if (cfg.tls) {
      (socket as tls.TLSSocket).once('secureConnect', ready);
    } else {
      (socket as net.Socket).once('connect', ready);
    }
  });
}

async function postToWebhook(cfg: Config, msg: string): Promise<void> {
  const res = await fetch(`${cfg.webhookUrl}/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-User-ID': cfg.userId,
    },
    body: JSON.stringify({ sessionId: cfg.sessionId, msg }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`webhook ${res.status}: ${body}`);
  }
}

/**
 * Minimal SSE parser over a fetch Response body. Yields one event
 * per `data:` line. Multi-line events are joined with '\n'.
 */
async function* readSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) {
    throw new Error(`sse ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let dataLines: string[] = [];
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
          yield dataLines.join('\n');
          dataLines = [];
        }
        continue;
      }
      if (raw.startsWith(':')) continue; // comment
      if (raw.startsWith('data:')) {
        dataLines.push(raw.slice(5).replace(/^ /, ''));
      }
      // ignore id:/event:/retry: — we don't resume across reconnects
    }
  }
}

async function streamToIrc(
  cfg: Config,
  signal: AbortSignal,
  sendPrivmsg: (text: string) => void,
): Promise<void> {
  const url = `${cfg.webhookUrl}/sessions/${encodeURIComponent(cfg.sessionId)}/stream`;
  const headers = { 'X-User-ID': cfg.userId };

  let pending = '';
  for await (const data of readSse(url, headers, signal)) {
    let event: { type: string; text?: string };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === 'delta' && typeof event.text === 'string') {
      pending += event.text;
    } else if (event.type === 'turn_end') {
      const msg = pending;
      pending = '';
      if (msg.trim()) {
        for (const chunk of chunkForIrc(msg)) {
          sendPrivmsg(chunk);
        }
      }
    }
  }
}

async function main() {
  const cfg = loadConfig();
  console.log(
    `[irc] connecting to ${cfg.server}:${cfg.port} as ${cfg.nick}, joining ${cfg.channel}`,
  );

  // The session must exist before GET /stream succeeds — prime it.
  try {
    await postToWebhook(cfg, `[irc bridge online in ${cfg.channel}]`);
  } catch (err) {
    console.error('[irc] failed to prime session:', (err as Error).message);
    process.exit(1);
  }

  let sock: LineSocket | null = null;
  const sendPrivmsg = (text: string) => {
    if (!sock) return;
    sock.write(`PRIVMSG ${cfg.channel} :${text}`);
  };

  sock = await connect(cfg, (line) => {
    const m = parseIrcLine(line);
    if (!m) return;

    if (m.command === 'PING') {
      sock?.write(`PONG :${m.params[0] ?? ''}`);
      return;
    }

    // 001 RPL_WELCOME — safe to join now
    if (m.command === '001') {
      sock?.write(`JOIN ${cfg.channel}`);
      return;
    }

    if (m.command === 'PRIVMSG') {
      const target = m.params[0];
      const text = m.params[1] ?? '';
      if (target !== cfg.channel) return; // ignore PMs
      const from = nickFromPrefix(m.prefix) ?? 'unknown';
      if (from === cfg.nick) return; // don't echo ourselves
      const payload = `${from}: ${text}`;
      postToWebhook(cfg, payload).catch((err) =>
        console.error('[irc] webhook post failed:', err.message),
      );
    }
  });

  if (cfg.password) sock.write(`PASS ${cfg.password}`);
  sock.write(`NICK ${cfg.nick}`);
  sock.write(`USER ${cfg.nick} 0 * :${cfg.nick}`);

  const abort = new AbortController();
  process.on('SIGINT', () => {
    abort.abort();
    sock?.end();
    process.exit(0);
  });

  while (!abort.signal.aborted) {
    try {
      await streamToIrc(cfg, abort.signal, sendPrivmsg);
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error('[irc] stream error:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
