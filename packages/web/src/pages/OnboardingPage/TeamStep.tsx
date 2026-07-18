import { useRef, useState } from 'react';
import type { TeamAnswers, TeamMemberAnswer } from '@botty/shared';

interface Row {
  id: number;
  member: TeamMemberAnswer;
}

interface TeamStepProps {
  value: TeamAnswers;
  onChange: (v: TeamAnswers) => void;
}

/** Step 3 — team.md. Repeating group; rows with a blank name are dropped at apply. */
export function TeamStep({ value, onChange }: TeamStepProps) {
  const [rows, setRows] = useState<Row[]>(() => value.people.map((member, i) => ({ id: i, member })));
  const idRef = useRef(value.people.length);

  const push = (next: Row[]) => {
    setRows(next);
    onChange({ people: next.map((r) => r.member) });
  };
  const patch = (id: number, p: Partial<TeamMemberAnswer>) =>
    push(rows.map((r) => (r.id === id ? { ...r, member: { ...r.member, ...p } } : r)));
  const remove = (id: number) => push(rows.filter((r) => r.id !== id));
  const add = () =>
    push([...rows, { id: idRef.current++, member: { name: '', weight: 'NORMAL' } }]);

  return (
    <div className="ob-step">
      <h2>Team</h2>
      <p className="ob-lead">
        Who botty tracks — the roster doubles as the ingestion whitelist. CRITICAL and HIGH people
        are Tier-1: their messages get full task extraction. NORMAL people are logged as
        interactions only.
      </p>
      {rows.length === 0 && (
        <p className="ob-note">
          An empty roster is valid — botty runs interactions-only until people are added.
        </p>
      )}
      {rows.map(({ id, member }) => (
        <div key={id} className="ob-card">
          <div className="ob-card-row">
            <label className="ob-field ob-grow">
              <span className="ob-label">Name *</span>
              <input
                className="ob-input"
                value={member.name}
                onChange={(e) => patch(id, { name: e.target.value })}
              />
            </label>
            <label className="ob-field">
              <span className="ob-label">Weight</span>
              <select
                className="ob-input"
                value={member.weight}
                onChange={(e) => patch(id, { weight: e.target.value as TeamMemberAnswer['weight'] })}
              >
                <option value="CRITICAL">CRITICAL</option>
                <option value="HIGH">HIGH</option>
                <option value="NORMAL">NORMAL</option>
              </select>
            </label>
            <label className="ob-field">
              <span className="ob-label">Slack handle</span>
              <input
                className="ob-input"
                value={member.slackHandle ?? ''}
                placeholder="@handle"
                onChange={(e) => patch(id, { slackHandle: e.target.value })}
              />
            </label>
            <button className="btn btn-ghost btn-danger btn-mini ob-card-remove" onClick={() => remove(id)}>
              ✕
            </button>
          </div>
          <div className="ob-card-row">
            <label className="ob-field ob-grow">
              <span className="ob-label">Email</span>
              <input
                className="ob-input"
                value={member.email ?? ''}
                onChange={(e) => patch(id, { email: e.target.value })}
              />
            </label>
            <label className="ob-field ob-grow">
              <span className="ob-label">Cadence</span>
              <input
                className="ob-input"
                value={member.cadence ?? ''}
                placeholder="e.g. weekly 1:1"
                onChange={(e) => patch(id, { cadence: e.target.value })}
              />
            </label>
            <label className="ob-field ob-grow">
              <span className="ob-label">Notes</span>
              <input
                className="ob-input"
                value={member.notes ?? ''}
                onChange={(e) => patch(id, { notes: e.target.value })}
              />
            </label>
          </div>
        </div>
      ))}
      <button className="btn" onClick={add}>
        + Add person
      </button>
    </div>
  );
}
