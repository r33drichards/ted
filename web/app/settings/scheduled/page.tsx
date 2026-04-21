import { auth } from '@/lib/auth';
import {
  listScheduledPrompts,
  listSessions,
} from '@/lib/ted';
import { redirect } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import ScheduledPromptsClient from './ScheduledPromptsClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ScheduledPromptsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const [prompts, sessions] = await Promise.all([
    listScheduledPrompts(session.user.id),
    listSessions(session.user.id),
  ]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-white">
        <ScheduledPromptsClient
          initialPrompts={prompts}
          sessions={sessions}
        />
      </main>
    </div>
  );
}
