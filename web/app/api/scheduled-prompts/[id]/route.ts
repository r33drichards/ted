import { auth } from '@/lib/auth';
import { tedFetch } from '@/lib/ted';

export const runtime = 'nodejs';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const { id } = await params;
  const body = await req.text();
  const res = await tedFetch(
    session.user.id,
    `/scheduled-prompts/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
    },
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const { id } = await params;
  const res = await tedFetch(
    session.user.id,
    `/scheduled-prompts/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
    },
  });
}
