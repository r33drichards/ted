'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Flashbar, {
  type FlashbarProps,
} from '@cloudscape-design/components/flashbar';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Select, {
  type SelectProps,
} from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';

import type { ScheduledPrompt } from '@/lib/ted';

type SessionRow = { id: string; title: string | null; updated_at: string };

type IntervalUnit = 'minutes' | 'hours' | 'days';

const UNIT_OPTIONS: SelectProps.Option[] = [
  { label: 'minutes', value: 'minutes' },
  { label: 'hours', value: 'hours' },
  { label: 'days', value: 'days' },
];

const UNIT_SECONDS: Record<IntervalUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

type FormState = {
  name: string;
  prompt: string;
  sessionId: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  enabled: boolean;
};

const EMPTY_FORM: FormState = {
  name: '',
  prompt: '',
  sessionId: '',
  intervalValue: '15',
  intervalUnit: 'minutes',
  enabled: true,
};

function formSecondsToValue(seconds: number): {
  value: string;
  unit: IntervalUnit;
} {
  if (seconds % UNIT_SECONDS.days === 0) {
    return { value: String(seconds / UNIT_SECONDS.days), unit: 'days' };
  }
  if (seconds % UNIT_SECONDS.hours === 0) {
    return { value: String(seconds / UNIT_SECONDS.hours), unit: 'hours' };
  }
  return { value: String(Math.max(1, Math.round(seconds / 60))), unit: 'minutes' };
}

function intervalToSeconds(form: FormState): number | null {
  const n = Number(form.intervalValue);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n * UNIT_SECONDS[form.intervalUnit];
}

function formatInterval(seconds: number): string {
  if (seconds % UNIT_SECONDS.days === 0) {
    const d = seconds / UNIT_SECONDS.days;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (seconds % UNIT_SECONDS.hours === 0) {
    const h = seconds / UNIT_SECONDS.hours;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j.error) return `${res.status}: ${j.error}`;
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

export default function ScheduledPromptsClient({
  initialPrompts,
  sessions,
}: {
  initialPrompts: ScheduledPrompt[];
  sessions: SessionRow[];
}) {
  const router = useRouter();
  const [prompts, setPrompts] = useState<ScheduledPrompt[]>(initialPrompts);
  const [selected, setSelected] = useState<ScheduledPrompt[]>([]);
  const [flashes, setFlashes] = useState<FlashbarProps.MessageDefinition[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const sessionOptions: SelectProps.Option[] = useMemo(
    () =>
      sessions.map((s) => ({
        label: s.title ?? s.id.slice(0, 8),
        value: s.id,
        description: s.id,
      })),
    [sessions],
  );

  function flash(
    type: FlashbarProps.Type,
    content: string,
    extras?: Partial<FlashbarProps.MessageDefinition>,
  ) {
    const id = `${Date.now()}-${Math.random()}`;
    setFlashes((f) => [
      ...f,
      {
        id,
        type,
        content,
        dismissible: true,
        onDismiss: () => setFlashes((fs) => fs.filter((m) => m.id !== id)),
        ...extras,
      },
    ]);
  }

  async function refresh() {
    const res = await fetch('/api/scheduled-prompts', { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as { prompts: ScheduledPrompt[] };
      setPrompts(data.prompts);
    }
    router.refresh();
  }

  function openCreate() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(p: ScheduledPrompt) {
    const { value, unit } = formSecondsToValue(p.interval_seconds);
    setEditId(p.id);
    setForm({
      name: p.name,
      prompt: p.prompt,
      sessionId: p.session_id,
      intervalValue: value,
      intervalUnit: unit,
      enabled: p.enabled,
    });
    setModalOpen(true);
  }

  async function onSubmit() {
    const intervalSeconds = intervalToSeconds(form);
    if (!form.name || !form.prompt || !form.sessionId || intervalSeconds === null) {
      flash('error', 'Fill in all fields with a valid positive interval.');
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        name: form.name,
        prompt: form.prompt,
        session_id: form.sessionId,
        interval_seconds: intervalSeconds,
        enabled: form.enabled,
      };
      const res = editId
        ? await fetch(`/api/scheduled-prompts/${editId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/scheduled-prompts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        flash('error', await errorText(res));
        return;
      }
      setModalOpen(false);
      flash(
        'success',
        editId ? 'Scheduled prompt updated.' : 'Scheduled prompt created.',
      );
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEnabled(p: ScheduledPrompt) {
    const res = await fetch(`/api/scheduled-prompts/${p.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    if (!res.ok) {
      flash('error', await errorText(res));
      return;
    }
    await refresh();
  }

  async function deleteSelected() {
    if (selected.length === 0) return;
    if (
      !confirm(
        `Delete ${selected.length} scheduled prompt${
          selected.length === 1 ? '' : 's'
        }? This cannot be undone.`,
      )
    ) {
      return;
    }
    const results = await Promise.all(
      selected.map((p) =>
        fetch(`/api/scheduled-prompts/${p.id}`, { method: 'DELETE' }),
      ),
    );
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      flash('error', `Failed to delete ${failed.length} of ${selected.length}.`);
    } else {
      flash('success', `Deleted ${selected.length} scheduled prompt(s).`);
    }
    setSelected([]);
    await refresh();
  }

  return (
    <ContentLayout
      header={
        <Box padding={{ top: 'l' }}>
          <Header
            variant="h1"
            description="Send the same prompt to a chat on a recurring schedule. Temporal handles the timer; each tick signals your chat session as if you had typed the prompt yourself."
          >
            Scheduled prompts
          </Header>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {flashes.length > 0 && <Flashbar items={flashes} />}
        <Table
          trackBy="id"
          items={prompts}
          selectedItems={selected}
          selectionType="multi"
          onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
          header={
            <Header
              counter={`(${prompts.length})`}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    disabled={selected.length === 0}
                    onClick={deleteSelected}
                  >
                    Delete
                  </Button>
                  <Button
                    disabled={selected.length !== 1}
                    onClick={() => selected[0] && openEdit(selected[0])}
                  >
                    Edit
                  </Button>
                  <Button variant="primary" onClick={openCreate}>
                    Create
                  </Button>
                </SpaceBetween>
              }
            >
              Prompts
            </Header>
          }
          empty={
            <Box textAlign="center" color="inherit">
              <b>No scheduled prompts</b>
              <Box variant="p" color="inherit" padding={{ bottom: 's' }}>
                Create one to start sending a prompt on a recurring interval.
              </Box>
              <Button onClick={openCreate}>Create</Button>
            </Box>
          }
          columnDefinitions={[
            {
              id: 'name',
              header: 'Name',
              cell: (p) => p.name,
              isRowHeader: true,
            },
            {
              id: 'interval',
              header: 'Every',
              cell: (p) => formatInterval(p.interval_seconds),
            },
            {
              id: 'session',
              header: 'Chat',
              cell: (p) => {
                const s = sessions.find((x) => x.id === p.session_id);
                return s?.title ?? p.session_id.slice(0, 8);
              },
            },
            {
              id: 'enabled',
              header: 'Enabled',
              cell: (p) => (
                <Toggle
                  checked={p.enabled}
                  onChange={() => toggleEnabled(p)}
                  ariaLabel={`Toggle ${p.name}`}
                />
              ),
            },
            {
              id: 'status',
              header: 'Status',
              cell: (p) =>
                p.enabled ? (
                  <StatusIndicator type="success">Active</StatusIndicator>
                ) : (
                  <StatusIndicator type="stopped">Paused</StatusIndicator>
                ),
            },
            {
              id: 'lastRun',
              header: 'Last run',
              cell: (p) => formatRelative(p.last_run_at),
            },
          ]}
        />
      </SpaceBetween>

      <Modal
        visible={modalOpen}
        onDismiss={() => setModalOpen(false)}
        header={editId ? 'Edit scheduled prompt' : 'Create scheduled prompt'}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => setModalOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={onSubmit} loading={submitting}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween size="l">
            <FormField label="Name" description="A short label, unique to you.">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.detail.value })}
                placeholder="daily standup"
              />
            </FormField>
            <FormField
              label="Prompt"
              description="Sent to the chat each time the schedule fires."
            >
              <Textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.detail.value })}
                rows={4}
                placeholder="Summarise yesterday's commits."
              />
            </FormField>
            <FormField
              label="Chat"
              description="The schedule signals this existing chat session."
            >
              <Select
                selectedOption={
                  sessionOptions.find((o) => o.value === form.sessionId) ?? null
                }
                onChange={(e) =>
                  setForm({
                    ...form,
                    sessionId: e.detail.selectedOption?.value ?? '',
                  })
                }
                options={sessionOptions}
                placeholder="Pick a chat"
                empty="No chats yet — start one first."
              />
            </FormField>
            <FormField label="Interval" description="Minimum 1 minute.">
              <SpaceBetween direction="horizontal" size="xs">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={form.intervalValue}
                  onChange={(e) =>
                    setForm({ ...form, intervalValue: e.detail.value })
                  }
                />
                <Select
                  selectedOption={
                    UNIT_OPTIONS.find((o) => o.value === form.intervalUnit) ??
                    UNIT_OPTIONS[0]!
                  }
                  onChange={(e) =>
                    setForm({
                      ...form,
                      intervalUnit:
                        (e.detail.selectedOption?.value as IntervalUnit) ??
                        'minutes',
                    })
                  }
                  options={UNIT_OPTIONS}
                />
              </SpaceBetween>
            </FormField>
            <FormField label="Enabled">
              <Toggle
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.detail.checked })}
              >
                {form.enabled ? 'Running on schedule' : 'Paused'}
              </Toggle>
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>
    </ContentLayout>
  );
}
