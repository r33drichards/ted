import { auth } from '@/lib/auth';
import { tedFetch } from '@/lib/ted';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const { id } = await params;
  const res = await tedFetch(
    session.user.id,
    `/mcp/servers/${encodeURIComponent(id)}/health`,
  );
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
