'use client';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { McpServer } from '@/lib/ted';

type HealthTool = { name: string; description: string | null };
type Health =
  | { status: 'loading' }
  | { status: 'ok'; tools: HealthTool[] }
  | { status: 'error'; message: string };

type FormState = {
  name: string;
  url: string;
  allowedTools: string;
  enabled: boolean;
};

const EMPTY: FormState = { name: '', url: '', allowedTools: '', enabled: true };

function parseTools(s: string): string[] {
  return s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function toolsToString(tools: string[]): string {
  return tools.join(', ');
}

export default function McpServersClient({
  initial,
}: {
  initial: McpServer[];
}) {
  const [servers, setServers] = useState<McpServer[]>(initial);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function checkHealth(id: string) {
    setHealth((h) => ({ ...h, [id]: { status: 'loading' } }));
    try {
      const res = await fetch(
        `/api/mcp/servers/${encodeURIComponent(id)}/health`,
        { cache: 'no-store' },
      );
      const data = (await res.json()) as {
        connected: boolean;
        tools: HealthTool[];
        error?: string;
      };
      setHealth((h) => ({
        ...h,
        [id]: data.connected
          ? { status: 'ok', tools: data.tools }
          : { status: 'error', message: data.error ?? 'failed' },
      }));
    } catch (err) {
      setHealth((h) => ({
        ...h,
        [id]: {
          status: 'error',
          message: err instanceof Error ? err.message : 'failed',
        },
      }));
    }
  }

  // Probe every enabled server once on mount and whenever the list changes.
  useEffect(() => {
    for (const s of servers) {
      if (s.enabled && !health[s.id]) checkHealth(s.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers]);

  async function refresh() {
    const res = await fetch('/api/mcp/servers', { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as { servers: McpServer[] };
      setServers(data.servers);
    }
    startTransition(() => router.refresh());
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        url: form.url,
        allowed_tools: parseTools(form.allowedTools),
        enabled: form.enabled,
      }),
    });
    if (!res.ok) {
      setError(await errorText(res));
      return;
    }
    setForm(EMPTY);
    setAdding(false);
    await refresh();
  }

  async function onUpdate(id: string) {
    setError(null);
    const res = await fetch(`/api/mcp/servers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: editForm.name,
        url: editForm.url,
        allowed_tools: parseTools(editForm.allowedTools),
        enabled: editForm.enabled,
      }),
    });
    if (!res.ok) {
      setError(await errorText(res));
      return;
    }
    setEditId(null);
    await refresh();
  }

  async function onDelete(id: string) {
    setError(null);
    if (!confirm('Delete this MCP server?')) return;
    const res = await fetch(`/api/mcp/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(await errorText(res));
      return;
    }
    await refresh();
  }

  async function onToggle(s: McpServer) {
    setError(null);
    const res = await fetch(`/api/mcp/servers/${s.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    if (!res.ok) {
      setError(await errorText(res));
      return;
    }
    await refresh();
    if (!s.enabled) checkHealth(s.id); // was disabled, now enabling — probe
  }

  function startEdit(s: McpServer) {
    setEditId(s.id);
    setEditForm({
      name: s.name,
      url: s.url,
      allowedTools: toolsToString(s.allowed_tools),
      enabled: s.enabled,
    });
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {error}
        </div>
      )}

      <ul className="space-y-3">
        {servers.length === 0 && (
          <li className="text-sm text-gray-500">No MCP servers configured.</li>
        )}
        {servers.map((s) =>
          editId === s.id ? (
            <li key={s.id} className="rounded border p-4">
              <EditFields form={editForm} setForm={setEditForm} />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => onUpdate(s.id)}
                  className="rounded bg-blue-600 px-3 py-1 text-sm text-white"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditId(null)}
                  className="rounded border px-3 py-1 text-sm"
                >
                  Cancel
                </button>
              </div>
            </li>
          ) : (
            <li key={s.id} className="rounded border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {!s.enabled && (
                      <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                        disabled
                      </span>
                    )}
                    <HealthBadge
                      state={health[s.id] ?? { status: 'loading' }}
                      onRefresh={() => checkHealth(s.id)}
                      onToggle={() =>
                        setExpanded((e) => ({ ...e, [s.id]: !e[s.id] }))
                      }
                      expanded={!!expanded[s.id]}
                      enabled={s.enabled}
                    />
                  </div>
                  <div className="truncate text-sm text-gray-600">{s.url}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {s.allowed_tools.length > 0
                      ? `tools: ${s.allowed_tools.join(', ')}`
                      : 'all tools allowed'}
                  </div>
                  {expanded[s.id] && (
                    <ToolList state={health[s.id] ?? { status: 'loading' }} />
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => onToggle(s)}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    {s.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => startEdit(s)}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(s.id)}
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ),
        )}
      </ul>

      {adding ? (
        <form onSubmit={onCreate} className="rounded border p-4 space-y-3">
          <EditFields form={form} setForm={setForm} />
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded bg-blue-600 px-3 py-1 text-sm text-white"
            >
              Add server
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setForm(EMPTY);
              }}
              className="rounded border px-3 py-1 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="rounded border px-3 py-1 text-sm"
        >
          + Add MCP server
        </button>
      )}
    </div>
  );
}

function EditFields({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="block text-gray-700">Name</span>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
          placeholder="github"
          required
        />
      </label>
      <label className="block text-sm">
        <span className="block text-gray-700">URL</span>
        <input
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
          placeholder="https://example.com/mcp"
          required
        />
      </label>
      <label className="block text-sm">
        <span className="block text-gray-700">
          Allowed tools (comma-separated, leave blank for all)
        </span>
        <input
          value={form.allowedTools}
          onChange={(e) => setForm({ ...form, allowedTools: e.target.value })}
          className="mt-1 w-full rounded border px-2 py-1 text-sm"
          placeholder="create_issue, search_repos"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Enabled
      </label>
    </div>
  );
}

function HealthBadge({
  state,
  onRefresh,
  onToggle,
  expanded,
  enabled,
}: {
  state: Health;
  onRefresh: () => void;
  onToggle: () => void;
  expanded: boolean;
  enabled: boolean;
}) {
  if (!enabled) {
    return (
      <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
        not probed
      </span>
    );
  }
  if (state.status === 'loading') {
    return (
      <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
        probing…
      </span>
    );
  }
  if (state.status === 'error') {
    return (
      <button
        type="button"
        onClick={onRefresh}
        title={state.message}
        className="rounded bg-red-900/50 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900"
      >
        disconnected
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="rounded bg-emerald-900/50 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-900"
    >
      connected · {state.tools.length} tool
      {state.tools.length === 1 ? '' : 's'}
      {expanded ? ' ▲' : ' ▼'}
    </button>
  );
}

function ToolList({ state }: { state: Health }) {
  if (state.status === 'loading')
    return <div className="mt-2 text-xs text-zinc-500">loading tools…</div>;
  if (state.status === 'error')
    return (
      <div className="mt-2 rounded bg-red-900/30 p-2 text-xs text-red-300">
        {state.message}
      </div>
    );
  if (state.tools.length === 0)
    return (
      <div className="mt-2 text-xs text-zinc-500">server exposes no tools</div>
    );
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {state.tools.map((t) => (
        <li
          key={t.name}
          className="rounded bg-zinc-800/60 px-2 py-1 text-zinc-300"
        >
          <code className="font-mono text-emerald-300">{t.name}</code>
          {t.description && (
            <span className="ml-2 text-zinc-400">{t.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j.error) return `${res.status}: ${j.error}`;
  } catch {
    /* fall through */
  }
  return `${res.status}`;
}
