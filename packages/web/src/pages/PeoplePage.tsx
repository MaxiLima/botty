import { useCallback, useEffect, useState } from 'react';
import type { Interaction, Person, Task } from '@botty/shared';
import { api } from '../lib/api.js';
import { isoInDays, shortDateTime, timeAgo } from '../lib/format.js';
import { useOnReconnect, useWsEvent } from '../lib/ws.js';
import { Drawer } from '../components/Drawer.js';
import { SourceIcon } from '../components/SourceIcon.js';
import '../styles/people.css';

export function PeoplePage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const res = await api.people();
      setPeople(res.people);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());
  // Task writes can change openTaskCount / lastInteractionAt.
  useWsEvent('tasks.updated', () => void refetch());

  const mute = async (p: Person) => {
    try {
      const until = p.mutedUntil && new Date(p.mutedUntil) > new Date() ? null : isoInDays(7);
      await api.mutePerson(p.id, until);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const weightRank = { CRITICAL: 0, HIGH: 1, NORMAL: 2 } as const;
  const roster = [...people].sort(
    (a, b) => a.tier - b.tier || weightRank[a.weight] - weightRank[b.weight] || a.name.localeCompare(b.name),
  );
  // Frequent unknowns: tier-2 people botty met in the wild (not from TEAM.md) with recent activity.
  const candidates = roster.filter(
    (p) => p.tier === 2 && p.source !== 'team' && ((p.openTaskCount ?? 0) > 0 || p.lastInteractionAt !== null),
  );

  return (
    <div className="people-page">
      {error && <div className="page-error">{error}</div>}
      <table className="people-table">
        <thead>
          <tr>
            <th>name</th>
            <th>weight</th>
            <th>cadence</th>
            <th>last interaction</th>
            <th className="num">open tasks</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {roster.map((p) => {
            const muted = p.mutedUntil !== null && new Date(p.mutedUntil) > new Date();
            return (
              <tr
                key={p.id}
                className={muted ? 'row-muted' : ''}
                tabIndex={0}
                role="button"
                onClick={() => setSelectedId(p.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return; // keys on the mute button stay its own
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedId(p.id);
                  }
                }}
              >
                <td>
                  <span className="person-name">{p.name}</span>
                  <span className="person-handle">
                    {p.slackHandle ? `@${p.slackHandle.replace(/^@/, '')}` : (p.email ?? '')}
                  </span>
                </td>
                <td>
                  <span className={`weight-chip weight-${p.weight.toLowerCase()}`}>{p.weight}</span>
                  <span className="tier-chip">T{p.tier}</span>
                </td>
                <td className="muted">{p.cadence ?? '–'}</td>
                <td className="muted">{p.lastInteractionAt ? `${timeAgo(p.lastInteractionAt)} ago` : 'never'}</td>
                <td className="num">{p.openTaskCount ?? 0}</td>
                <td>
                  <button
                    className={`btn btn-mini ${muted ? 'btn-danger' : 'btn-ghost'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void mute(p);
                    }}
                    title={muted ? `muted until ${shortDateTime(p.mutedUntil)} — click to unmute` : 'mute for 7 days'}
                  >
                    {muted ? 'muted' : 'mute'}
                  </button>
                </td>
              </tr>
            );
          })}
          {roster.length === 0 && (
            <tr>
              <td colSpan={6} className="col-empty">
                no people yet — TEAM.md materializes here on boot
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="promotion-section">
        <h2>Promotion candidates</h2>
        <p className="muted">
          Frequent unknowns — tier-2 people botty keeps seeing. Add them to TEAM.md to enable full extraction.
        </p>
        {candidates.length === 0 ? (
          <div className="col-empty">none right now</div>
        ) : (
          <div className="candidate-row">
            {candidates.map((p) => (
              <button key={p.id} className="candidate-chip" onClick={() => setSelectedId(p.id)}>
                <b>{p.name}</b>
                <span>
                  {p.openTaskCount ?? 0} open · {p.lastInteractionAt ? `${timeAgo(p.lastInteractionAt)} ago` : 'no ix'}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedId && <PersonDrawer id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function PersonDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ person: Person; interactions: Interaction[]; tasks: Task[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .person(id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const p = data?.person;
  return (
    <Drawer title={p ? p.name : 'Person'} onClose={onClose}>
      {error && <div className="page-error">{error}</div>}
      {!p ? (
        !error && <div className="muted">loading…</div>
      ) : (
        <>
          <div className="kv-grid">
            <span>weight</span>
            <span>
              <span className={`weight-chip weight-${p.weight.toLowerCase()}`}>{p.weight}</span>{' '}
              <span className="tier-chip">tier {p.tier}</span>
            </span>
            <span>slack</span>
            <span>{p.slackHandle ?? '–'}</span>
            <span>email</span>
            <span>{p.email ?? '–'}</span>
            <span>cadence</span>
            <span>{p.cadence ?? '–'}</span>
            <span>muted</span>
            <span>{p.mutedUntil ? `until ${shortDateTime(p.mutedUntil)}` : 'no'}</span>
            <span>origin</span>
            <span>{p.source}</span>
          </div>
          {p.notes && <p className="person-notes">{p.notes}</p>}

          <h3 className="drawer-section">Open tasks ({data?.tasks.length ?? 0})</h3>
          {data && data.tasks.length > 0 ? (
            <ul className="mini-task-list">
              {data.tasks.map((t) => (
                <li key={t.id}>
                  <SourceIcon source={t.source} />
                  <span className={`status-chip status-${t.status}`}>{t.status}</span>
                  <span className="mini-task-desc">{t.description}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">none</div>
          )}

          <h3 className="drawer-section">Recent interactions</h3>
          {data && data.interactions.length > 0 ? (
            <ul className="interaction-list">
              {data.interactions.map((ix) => (
                <li key={ix.id}>
                  <div className="surface-head">
                    <SourceIcon source={ix.source} />
                    <span className="notif-kind">
                      {ix.kind} · {ix.direction}
                    </span>
                    <span className="muted" title={ix.occurredAt}>
                      {timeAgo(ix.occurredAt)} ago
                    </span>
                  </div>
                  {ix.snippet && <div className="surface-msg">{ix.snippet}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">none recorded</div>
          )}
        </>
      )}
    </Drawer>
  );
}
