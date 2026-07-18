import { useRef, useState } from 'react';
import type { McpAnswers, McpServerAnswer } from '@botty/shared';
import { api } from '../../lib/api.js';

const KEY_RE = /^[a-zA-Z0-9_-]+$/;

interface EnvRow {
  name: string;
  value: string;
}
interface ToolRow {
  name: string;
  mode: 'read' | 'action';
}
interface ServerRow {
  id: number;
  key: string;
  command: string;
  /** One arg per line. */
  argsText: string;
  env: EnvRow[];
  tools: ToolRow[];
}
interface ProbeState {
  busy: boolean;
  error: string | null;
  tools: string[] | null;
}

function rowToServer(row: ServerRow): McpServerAnswer {
  const env: Record<string, string> = {};
  for (const e of row.env) if (e.name.trim()) env[e.name.trim()] = e.value;
  const tools: Record<string, 'read' | 'action'> = {};
  for (const t of row.tools) if (t.name.trim()) tools[t.name.trim()] = t.mode;
  return {
    type: 'stdio',
    command: row.command.trim(),
    args: row.argsText
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean),
    env,
    tools,
  };
}

interface McpStepProps {
  value: McpAnswers;
  onChange: (v: McpAnswers) => void;
}

/** Step 5 — mcp.json: external MCP servers, env secrets and the tool allowlist. */
export function McpStep({ value, onChange }: McpStepProps) {
  const [rows, setRows] = useState<ServerRow[]>(() =>
    Object.entries(value.servers).map(([key, s], i) => ({
      id: i,
      key,
      command: s.command,
      argsText: s.args.join('\n'),
      env: Object.entries(s.env).map(([name, v]) => ({ name, value: v })),
      tools: Object.entries(s.tools).map(([name, mode]) => ({ name, mode })),
    })),
  );
  const idRef = useRef(rows.length);
  const [probes, setProbes] = useState<Record<number, ProbeState>>({});

  const push = (next: ServerRow[]) => {
    setRows(next);
    const servers: Record<string, McpServerAnswer> = {};
    for (const r of next) {
      const key = r.key.trim();
      if (!KEY_RE.test(key) || !r.command.trim()) continue;
      servers[key] = rowToServer(r);
    }
    onChange({ servers });
  };
  const patch = (id: number, p: Partial<Omit<ServerRow, 'id'>>) =>
    push(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: number) => push(rows.filter((r) => r.id !== id));
  const add = () =>
    push([...rows, { id: idRef.current++, key: '', command: '', argsText: '', env: [], tools: [] }]);

  const probe = async (row: ServerRow) => {
    setProbes((p) => ({ ...p, [row.id]: { busy: true, error: null, tools: null } }));
    let next: ProbeState;
    try {
      const res = await api.mcpProbe(rowToServer(row));
      next = res.ok
        ? { busy: false, error: null, tools: res.tools }
        : { busy: false, error: res.error ?? 'probe failed', tools: null };
    } catch (err) {
      next = { busy: false, error: err instanceof Error ? err.message : String(err), tools: null };
    }
    setProbes((p) => ({ ...p, [row.id]: next }));
  };

  const addTool = (row: ServerRow, name: string) => {
    if (row.tools.some((t) => t.name === name)) return;
    patch(row.id, { tools: [...row.tools, { name, mode: 'read' }] });
  };

  return (
    <div className="ob-step">
      <h2>MCP servers &amp; tools</h2>
      <p className="ob-lead">
        External MCP servers give botty extra tools. Only allowlisted tools are exposed:{' '}
        <code>read</code> tools run freely, while <code>action</code> tools never run mid-turn —
        botty queues them as pending actions and waits for your explicit approval (the consent
        gate).
      </p>
      {rows.map((row) => {
        const probeState = probes[row.id];
        const keyInvalid = row.key.trim() !== '' && !KEY_RE.test(row.key.trim());
        const incomplete = !KEY_RE.test(row.key.trim()) || !row.command.trim();
        return (
          <div key={row.id} className="ob-card">
            <div className="ob-card-row">
              <label className="ob-field">
                <span className="ob-label">Key</span>
                <input
                  className={`ob-input ${keyInvalid ? 'invalid' : ''}`}
                  value={row.key}
                  placeholder="my-server"
                  onChange={(e) => patch(row.id, { key: e.target.value })}
                />
              </label>
              <label className="ob-field ob-grow">
                <span className="ob-label">Command</span>
                <input
                  className="ob-input"
                  value={row.command}
                  placeholder="npx"
                  onChange={(e) => patch(row.id, { command: e.target.value })}
                />
              </label>
              <button
                className="btn btn-ghost btn-danger btn-mini ob-card-remove"
                onClick={() => remove(row.id)}
              >
                ✕
              </button>
            </div>
            {incomplete && (
              <p className="ob-hint ob-warn">
                Needs a key (letters, digits, - or _) and a command before it&apos;s included.
              </p>
            )}
            <label className="ob-field">
              <span className="ob-label">Args — one per line</span>
              <textarea
                className="ob-textarea ob-args"
                spellCheck={false}
                value={row.argsText}
                onChange={(e) => patch(row.id, { argsText: e.target.value })}
              />
            </label>

            <span className="ob-label">Env vars</span>
            {row.env.map((e, i) => (
              <div key={i} className="ob-card-row">
                <input
                  className="ob-input"
                  value={e.name}
                  placeholder="NAME"
                  onChange={(ev) =>
                    patch(row.id, {
                      env: row.env.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)),
                    })
                  }
                />
                <input
                  className="ob-input ob-grow"
                  type="password"
                  value={e.value}
                  placeholder="value (masked)"
                  onChange={(ev) =>
                    patch(row.id, {
                      env: row.env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)),
                    })
                  }
                />
                <button
                  className="btn btn-ghost btn-danger btn-mini ob-card-remove"
                  onClick={() => patch(row.id, { env: row.env.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn btn-mini"
              onClick={() => patch(row.id, { env: [...row.env, { name: '', value: '' }] })}
            >
              + env var
            </button>

            <span className="ob-label">Tool allowlist</span>
            {row.tools.map((t, i) => (
              <div key={i} className="ob-card-row">
                <input
                  className="ob-input ob-grow"
                  value={t.name}
                  placeholder="tool_name"
                  onChange={(ev) =>
                    patch(row.id, {
                      tools: row.tools.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)),
                    })
                  }
                />
                <select
                  className="ob-input"
                  value={t.mode}
                  onChange={(ev) =>
                    patch(row.id, {
                      tools: row.tools.map((x, j) =>
                        j === i ? { ...x, mode: ev.target.value as ToolRow['mode'] } : x,
                      ),
                    })
                  }
                >
                  <option value="read">read</option>
                  <option value="action">action</option>
                </select>
                <button
                  className="btn btn-ghost btn-danger btn-mini ob-card-remove"
                  onClick={() => patch(row.id, { tools: row.tools.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="ob-card-row">
              <button
                className="btn btn-mini"
                onClick={() => patch(row.id, { tools: [...row.tools, { name: '', mode: 'read' }] })}
              >
                + tool
              </button>
              <span className="ob-footer-spacer" />
              <button
                className="btn btn-mini"
                disabled={probeState?.busy || !row.command.trim()}
                onClick={() => void probe(row)}
              >
                {probeState?.busy ? 'probing…' : 'Test connection'}
              </button>
            </div>
            {probeState?.error && (
              <div className="page-error">
                Probe failed: {probeState.error} — saving is not blocked; unreachable servers still
                expose allowlisted tools generically.
              </div>
            )}
            {probeState?.tools && (
              <div className="ob-probe-tools">
                <span className="ob-hint">advertised tools — click to allowlist:</span>
                {probeState.tools.map((name) => (
                  <button
                    key={name}
                    className={`ob-chip ${row.tools.some((t) => t.name === name) ? 'on' : ''}`}
                    onClick={() => addTool(row, name)}
                  >
                    {name}
                  </button>
                ))}
                {probeState.tools.length === 0 && <span className="ob-hint">none advertised</span>}
              </div>
            )}
          </div>
        );
      })}
      <button className="btn" onClick={add}>
        + Add server
      </button>
    </div>
  );
}
