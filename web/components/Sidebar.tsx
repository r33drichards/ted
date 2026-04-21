'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

type Row = { id: string; title: string | null; updated_at: string };

export default function Sidebar() {
  const [rows, setRows] = useState<Row[]>([]);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  async function refresh() {
    try {
      const res = await fetch('/api/sessions', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { sessions: Row[] };
        setRows(data.sessions);
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [pathname]);

  // Click-outside closes the menu.
  useEffect(() => {
    const close = () => setOpenMenu(null);
    if (openMenu) {
      window.addEventListener('click', close);
      return () => window.removeEventListener('click', close);
    }
  }, [openMenu]);

  async function archive(id: string) {
    setOpenMenu(null);
    // Optimistic drop from list.
    setRows((prev) => prev.filter((r) => r.id !== id));
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    if (!res.ok) await refresh(); // roll back via re-fetch
    else if (pathname === `/chat/${id}`) router.push('/chat/new');
  }

  async function remove(id: string) {
    setOpenMenu(null);
    if (!confirm('Delete this chat permanently? This cannot be undone.')) return;
    setRows((prev) => prev.filter((r) => r.id !== id));
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) await refresh();
    else if (pathname === `/chat/${id}`) router.push('/chat/new');
  }

  return (
    <aside className="flex h-full w-64 flex-col border-r border-zinc-800 bg-zinc-900 p-3">
      <Link
        href="/chat/new"
        className="mb-3 rounded-md bg-emerald-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-500"
      >
        + New chat
      </Link>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="p-2 text-xs text-zinc-500">No chats yet</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r) => {
              const active = pathname === `/chat/${r.id}`;
              return (
                <li key={r.id} className="group relative">
                  <Link
                    href={`/chat/${r.id}`}
                    className={`block truncate rounded-md px-2 py-1.5 pr-8 text-sm ${
                      active
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-300 hover:bg-zinc-800/60'
                    }`}
                  >
                    {r.title ?? r.id.slice(0, 8)}
                  </Link>
                  <button
                    type="button"
                    aria-label="Chat options"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenu((cur) => (cur === r.id ? null : r.id));
                    }}
                    className="absolute right-1 top-1 hidden rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 group-hover:inline-block"
                  >
                    ...
                  </button>
                  {openMenu === r.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-1 top-7 z-10 w-36 rounded-md border border-zinc-700 bg-zinc-900 py-1 text-sm shadow-lg"
                    >
                      <button
                        type="button"
                        onClick={() => archive(r.id)}
                        className="block w-full px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                      >
                        Archive
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        className="block w-full px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <Link
          href="/settings/mcp"
          className={`block rounded-md px-3 py-2 text-sm ${
            pathname === '/settings/mcp'
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:bg-zinc-800'
          }`}
        >
          MCP servers
        </Link>
        <Link
          href="/settings/scheduled"
          className={`block rounded-md px-3 py-2 text-sm ${
            pathname === '/settings/scheduled'
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:bg-zinc-800'
          }`}
        >
          Scheduled prompts
        </Link>
        <form action="/api/auth/signout" method="post">
          <button
            type="submit"
            className="w-full rounded-md px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-800"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
