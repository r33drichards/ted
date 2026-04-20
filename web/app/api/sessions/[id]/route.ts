import { auth } from '@/lib/auth';
import { renameSession, setArchived, deleteSession } from '@/lib/ted';

export const runtime = 'nodejs';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const body = (await req.json()) as { title?: string; archived?: boolean };
  const { id } = await params;
  if (typeof body.title === 'string') {
    await renameSession(session.user.id, id, body.title);
  }
  if (typeof body.archived === 'boolean') {
    await setArchived(session.user.id, id, body.archived);
  }
  if (typeof body.title !== 'string' && typeof body.archived !== 'boolean') {
    return new Response('title or archived required', { status: 400 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const { id } = await params;
  await deleteSession(session.user.id, id);
  return Response.json({ ok: true });
}
