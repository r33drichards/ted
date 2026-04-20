import { auth } from '@/lib/auth';
import { listMcpServers } from '@/lib/ted';
import { redirect } from 'next/navigation';
import McpServersClient from './McpServersClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function McpSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const servers = await listMcpServers(session.user.id);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold mb-1">MCP servers</h1>
      <p className="text-sm text-gray-600 mb-6">
        Remote MCP servers Claude can call during your chats. Changes take
        effect on your next message.
      </p>
      <McpServersClient initial={servers} />
    </main>
  );
}
