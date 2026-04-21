import { auth } from '@/lib/auth';
import { tedFetch } from '@/lib/ted';

export const runtime = 'nodejs';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const res = await tedFetch(session.user.id, '/scheduled-prompts');
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
    },
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const body = await req.text();
  const res = await tedFetch(session.user.id, '/scheduled-prompts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
    },
  });
}
