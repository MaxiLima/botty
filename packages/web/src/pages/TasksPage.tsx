import { useCallback, useEffect, useState } from 'react';
import type { ProactiveLogRow, Task, TaskHistory } from '@botty/shared';
import { api, type TaskActionBody } from '../lib/api.js';
import { daysUntil, priorityLabel, shortDate, shortDateTime, timeAgo } from '../lib/format.js';
import { useOnReconnect, useWsEvent } from '../lib/ws.js';
import { Drawer } from '../components/Drawer.js';
import { SourceIcon } from '../components/SourceIcon.js';
import '../styles/tasks.css';

const WEEK_MS = 7 * 86_400_000;

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const res = await api.tasks();
      setTasks(res.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());
  // tasks.updated pushes the refreshed open board; refetch to also catch snoozed/done moves.
  useWsEvent('tasks.updated', () => void refetch());

  const open = tasks.filter((t) => t.status === 'open').sort(byPriorityThenAge);
  const snoozed = tasks.filter((t) => t.status === 'snoozed').sort(bySnoozeDate);
  const done = tasks
    .filter((t) => t.status === 'done' && t.doneAt && Date.now() - new Date(t.doneAt).getTime() < WEEK_MS)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));

  return (
    <div className="tasks-page">
      {error && <div className="page-error">{error}</div>}
      <div className="task-columns">
        <TaskColumn title="Open" accent="open" tasks={open} onSelect={setSelectedId} />
        <TaskColumn title="Snoozed" accent="snoozed" tasks={snoozed} onSelect={setSelectedId} />
        <TaskColumn title="Done · this week" accent="done" tasks={done} onSelect={setSelectedId} />
      </div>
      {selectedId && <TaskDrawer id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

// Priority is 1 = HIGH … 3 = LOW, so ascending = most urgent first (same as briefings.ts).
function byPriorityThenAge(a: Task, b: Task): number {
  return a.priority - b.priority || a.createdAt.localeCompare(b.createdAt);
}
function bySnoozeDate(a: Task, b: Task): number {
  return (a.snoozeUntil ?? '').localeCompare(b.snoozeUntil ?? '');
}

function TaskColumn({
  title,
  accent,
  tasks,
  onSelect,
}: {
  title: string;
  accent: string;
  tasks: Task[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className={`task-col task-col-${accent}`}>
      <header className="task-col-head">
        <h2>{title}</h2>
        <span className="col-count">{tasks.length}</span>
      </header>
      <div className="task-col-body">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onClick={() => onSelect(t.id)} />
        ))}
        {tasks.length === 0 && <div className="col-empty">nothing here</div>}
      </div>
    </section>
  );
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const due = daysUntil(task.dueDate);
  return (
    <button className="task-card" onClick={onClick}>
      <div className="task-card-top">
        <SourceIcon source={task.source} />
        <span className={`prio prio-${priorityLabel(task.priority).toLowerCase()}`}>
          {priorityLabel(task.priority)}
        </span>
        {task.owner === 'them' && (
          <span className="task-waiting" title="their commitment — not the user's to-do">
            ⏳ waiting
          </span>
        )}
        <span className="task-age" title={task.createdAt}>
          {timeAgo(task.createdAt)}
        </span>
      </div>
      <div className="task-desc">{task.description}</div>
      <div className="task-card-meta">
        {task.requesterName && (
          <span className="task-requester">◦ {task.owner === 'them' ? `waiting on ${task.requesterName}` : task.requesterName}</span>
        )}
        {task.projectName && <span className="task-project">{task.projectName}</span>}
        {task.dueDate && (
          <span className={`task-due ${due !== null && due < 0 ? 'overdue' : due !== null && due <= 1 ? 'soon' : ''}`}>
            due {shortDate(task.dueDate)}
          </span>
        )}
        {task.status === 'snoozed' && task.snoozeUntil && (
          <span className="task-due">until {shortDate(task.snoozeUntil)}</span>
        )}
      </div>
    </button>
  );
}

function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ task: Task; history: TaskHistory[]; surfaces: ProactiveLogRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissReason, setDismissReason] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.task(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (body: TaskActionBody) => {
    setBusy(true);
    setError(null);
    try {
      await api.taskAction(id, body);
      setDismissReason(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const task = data?.task;
  return (
    <Drawer title={task ? <span className="drawer-task-title">{task.description}</span> : 'Task'} onClose={onClose}>
      {error && <div className="page-error">{error}</div>}
      {!task ? (
        !error && <div className="muted">loading…</div>
      ) : (
        <>
          <div className="kv-grid">
            <span>status</span>
            <span className={`status-chip status-${task.status}`}>{task.status}</span>
            <span>priority</span>
            <span>
              {priorityLabel(task.priority)} ({task.priority})
            </span>
            <span>source</span>
            <span>
              <SourceIcon source={task.source} /> {task.source}
              {task.sourceRef ? ` · ${task.sourceRef}` : ''}
            </span>
            <span>requester</span>
            <span>
              {task.requesterName ?? task.requestedBy ?? '–'}
              {task.owner === 'them' && <span className="task-waiting" style={{ marginLeft: 6 }}>⏳ waiting on them</span>}
            </span>
            <span>project</span>
            <span>{task.projectName ?? '–'}</span>
            <span>due</span>
            <span>{task.dueDate ? shortDate(task.dueDate) : '–'}</span>
            <span>created</span>
            <span title={task.createdAt}>{shortDateTime(task.createdAt)}</span>
            <span>surfaced</span>
            <span>
              {task.surfaceCount}× {task.lastSurfacedAt ? `· last ${timeAgo(task.lastSurfacedAt)} ago` : ''}
            </span>
          </div>

          <div className="drawer-actions">
            {task.status !== 'done' && (
              <button className="btn" disabled={busy} onClick={() => void act({ action: 'done' })}>
                ✓ Done
              </button>
            )}
            {task.status === 'open' && (
              <button className="btn" disabled={busy} onClick={() => void act({ action: 'snooze', snoozeDays: 3 })}>
                ⏲ Snooze 3d
              </button>
            )}
            {(task.status === 'done' || task.status === 'snoozed' || task.status === 'cancelled') && (
              <button className="btn" disabled={busy} onClick={() => void act({ action: 'reopen' })}>
                ↺ Reopen
              </button>
            )}
            {task.status !== 'done' && task.status !== 'cancelled' && (
              <button className="btn btn-danger" disabled={busy} onClick={() => setDismissReason((r) => (r === null ? '' : null))}>
                ✗ Dismiss
              </button>
            )}
            <label className="prio-select">
              priority
              <select
                value={task.priority}
                disabled={busy}
                onChange={(e) => void act({ action: 'priority', priority: Number(e.target.value) })}
              >
                {([[1, 'high'], [2, 'normal'], [3, 'low']] as const).map(([p, name]) => (
                  <option key={p} value={p}>
                    {p} · {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {dismissReason !== null && (
            <div className="notif-dismiss-row">
              <input
                className="notif-reason"
                placeholder="why dismiss? (recorded)"
                value={dismissReason}
                autoFocus
                onChange={(e) => setDismissReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void act({ action: 'dismiss', reason: dismissReason.trim() || undefined });
                }}
              />
              <button
                className="btn btn-mini btn-danger"
                disabled={busy}
                onClick={() => void act({ action: 'dismiss', reason: dismissReason.trim() || undefined })}
              >
                confirm
              </button>
            </div>
          )}

          {task.rawText && (
            <details className="raw-text">
              <summary>raw source text</summary>
              <pre>{task.rawText}</pre>
            </details>
          )}

          <h3 className="drawer-section">Surfaces & responses</h3>
          {data && data.surfaces.length > 0 ? (
            <ul className="surface-list">
              {data.surfaces.map((s) => (
                <li key={s.id}>
                  <div className="surface-head">
                    <span className="notif-kind">{s.surfaceKind}</span>
                    {s.score != null && <span className="score-chip">{s.score}/10</span>}
                    <span className="muted" title={s.surfacedAt}>
                      {timeAgo(s.surfacedAt)} ago
                    </span>
                  </div>
                  <div className="surface-msg">{s.message}</div>
                  {s.responseType && (
                    <div className="surface-response">
                      → {s.responseType}
                      {s.responseReason ? ` · "${s.responseReason}"` : ''}
                      {s.responseAt ? ` · ${timeAgo(s.responseAt)} ago` : ''}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">never surfaced</div>
          )}

          <h3 className="drawer-section">History</h3>
          {data && data.history.length > 0 ? (
            <ul className="history-list">
              {data.history.map((h) => (
                <li key={h.id}>
                  <span className="muted" title={h.changedAt}>
                    {shortDateTime(h.changedAt)}
                  </span>{' '}
                  <b>{h.field}</b>: {h.oldValue ?? '∅'} → {h.newValue ?? '∅'}{' '}
                  <span className="muted">by {h.changedBy}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">no changes recorded</div>
          )}
        </>
      )}
    </Drawer>
  );
}
