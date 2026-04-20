import { describe, it, expect } from 'vitest';
import { buildMcpServersParam } from '../activities.js';
import type { McpServerRow } from '../db.js';

function row(partial: Partial<McpServerRow>): McpServerRow {
  return {
    id: 'id',
    user_id: 'u',
    name: 'n',
    url: 'https://example.com/mcp',
    allowed_tools: [],
    enabled: true,
    created_at: '2026-04-20T00:00:00Z',
    updated_at: '2026-04-20T00:00:00Z',
    ...partial,
  };
}

describe('buildMcpServersParam', () => {
  it('returns [] for empty input', () => {
    expect(buildMcpServersParam([])).toEqual([]);
  });

  it('omits tool_configuration when allowed_tools is empty', () => {
    const out = buildMcpServersParam([
      row({ name: 'a', url: 'https://a.example/mcp', allowed_tools: [] }),
    ]);
    expect(out).toEqual([
      { type: 'url', url: 'https://a.example/mcp', name: 'a' },
    ]);
    expect(out[0]).not.toHaveProperty('tool_configuration');
  });

  it('includes tool_configuration when allowed_tools has entries', () => {
    const out = buildMcpServersParam([
      row({
        name: 'b',
        url: 'https://b.example/mcp',
        allowed_tools: ['do_thing', 'other'],
      }),
    ]);
    expect(out).toEqual([
      {
        type: 'url',
        url: 'https://b.example/mcp',
        name: 'b',
        tool_configuration: { allowed_tools: ['do_thing', 'other'] },
      },
    ]);
  });
});
