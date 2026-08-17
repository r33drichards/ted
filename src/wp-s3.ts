/**
 * S3 access to the WordPress wp-content volume (Wasmer). Used by the
 * wp_fs agent tool and the wpfs MCP server. Requests are SigV4-signed
 * with credentials from WP_S3_* env vars — they never enter model context.
 */
import aws4 from 'aws4';

export const WP_S3_MAX_READ = 100_000;

function wpS3Config() {
  const endpoint = process.env.WP_S3_ENDPOINT;
  const bucket = process.env.WP_S3_BUCKET;
  const accessKeyId = process.env.WP_S3_ACCESS_KEY;
  const secretAccessKey = process.env.WP_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

export async function wpS3Request(
  method: string,
  path: string,
  query = '',
  body?: string,
): Promise<{ status: number; text: string }> {
  const cfg = wpS3Config();
  if (!cfg) throw new Error('WP volume S3 not configured (WP_S3_* env vars unset)');
  const url = new URL(cfg.endpoint);
  const fullPath = `/${cfg.bucket}/${path}${query}`;
  const opts: aws4.Request = {
    host: url.host,
    path: fullPath,
    method,
    service: 's3',
    region: 'auto',
    headers: {},
    ...(body !== undefined ? { body } : {}),
  };
  aws4.sign(opts, {
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  const res = await fetch(`${url.origin}${fullPath}`, {
    method,
    headers: opts.headers as Record<string, string>,
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  return { status: res.status, text };
}

export function normalizeWpPath(path: string): string {
  return String(path ?? '').replace(/^\/+/, '');
}

export async function wpList(prefix: string): Promise<string> {
  const r = await wpS3Request(
    'GET',
    '',
    `?list-type=2&max-keys=500&prefix=${encodeURIComponent(normalizeWpPath(prefix))}`,
  );
  if (r.status !== 200) throw new Error(`list failed (${r.status}): ${r.text.slice(0, 300)}`);
  const entries = [...r.text.matchAll(
    /<Key>([^<]+)<\/Key>(?:<LastModified>([^<]+)<\/LastModified>)?(?:<Size>(\d+)<\/Size>)?/g,
  )].map((m) => `${m[1]}${m[3] ? ` (${m[3]} bytes)` : ''}`);
  return entries.length > 0 ? entries.join('\n') : '(no matches)';
}

export async function wpRead(path: string): Promise<string> {
  const r = await wpS3Request('GET', normalizeWpPath(path));
  if (r.status !== 200) throw new Error(`read failed (${r.status}): ${r.text.slice(0, 300)}`);
  return r.text.length > WP_S3_MAX_READ
    ? r.text.slice(0, WP_S3_MAX_READ) + `\n… (truncated ${r.text.length - WP_S3_MAX_READ} chars)`
    : r.text;
}

export async function wpWrite(path: string, content: string): Promise<string> {
  const r = await wpS3Request('PUT', normalizeWpPath(path), '', content);
  if (r.status >= 300) throw new Error(`write failed (${r.status}): ${r.text.slice(0, 300)}`);
  return `Wrote ${content.length} bytes to ${normalizeWpPath(path)}.`;
}

export async function wpDelete(path: string): Promise<string> {
  const r = await wpS3Request('DELETE', normalizeWpPath(path));
  if (r.status >= 300) throw new Error(`delete failed (${r.status}): ${r.text.slice(0, 300)}`);
  return `Deleted ${normalizeWpPath(path)}.`;
}
