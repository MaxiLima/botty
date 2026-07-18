import { useState } from 'react';
import type { ScheduleAnswers } from '@botty/shared';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** HH:MM input that only commits valid values — answers can never go invalid. */
function TimeInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const invalid = !HHMM_RE.test(draft);
  return (
    <input
      className={`ob-input ob-time ${invalid ? 'invalid' : ''}`}
      value={draft}
      placeholder="HH:MM"
      title={invalid ? 'expected HH:MM — last valid value is kept until this parses' : undefined}
      onChange={(e) => {
        setDraft(e.target.value);
        if (HHMM_RE.test(e.target.value)) onCommit(e.target.value);
      }}
    />
  );
}

interface ScheduleStepProps {
  value: ScheduleAnswers;
  onChange: (v: ScheduleAnswers) => void;
}

/** Step 6 — heartbeat.md `## Schedule`. */
export function ScheduleStep({ value, onChange }: ScheduleStepProps) {
  const [tickDraft, setTickDraft] = useState(String(value.tickIntervalMin));
  const tickN = Number.parseInt(tickDraft, 10);
  const tickInvalid = !(Number.isFinite(tickN) && tickN >= 1);

  const toggleDay = (day: number) => {
    const days = value.activeDays.includes(day)
      ? value.activeDays.filter((d) => d !== day)
      : [...value.activeDays, day].sort((a, b) => a - b);
    onChange({ ...value, activeDays: days });
  };

  return (
    <div className="ob-step">
      <h2>Schedule &amp; rhythm</h2>
      <p className="ob-lead">
        Working hours are a hard on/off window: outside them (or on inactive days) botty does
        nothing — no source polls, no ticks, no briefings, zero token usage. Quiet hours are a
        softer gate inside that window: intake continues but nudges hold.
      </p>
      <div className="ob-grid2">
        <div className="ob-field">
          <span className="ob-label">Working hours</span>
          <div className="ob-time-pair">
            <TimeInput
              value={value.workingHours.start}
              onCommit={(v) => onChange({ ...value, workingHours: { ...value.workingHours, start: v } })}
            />
            <span className="ob-hint">to</span>
            <TimeInput
              value={value.workingHours.end}
              onCommit={(v) => onChange({ ...value, workingHours: { ...value.workingHours, end: v } })}
            />
          </div>
        </div>
        <div className="ob-field">
          <span className="ob-label">Quiet hours</span>
          <div className="ob-time-pair">
            <TimeInput
              value={value.quietHours.start}
              onCommit={(v) => onChange({ ...value, quietHours: { ...value.quietHours, start: v } })}
            />
            <span className="ob-hint">to</span>
            <TimeInput
              value={value.quietHours.end}
              onCommit={(v) => onChange({ ...value, quietHours: { ...value.quietHours, end: v } })}
            />
          </div>
        </div>
      </div>
      <div className="ob-field">
        <span className="ob-label">Active days</span>
        <div className="ob-days">
          {DAY_LABELS.map((label, day) => (
            <button
              key={label}
              className={`ob-day ${value.activeDays.includes(day) ? 'on' : ''}`}
              onClick={() => toggleDay(day)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="ob-grid2">
        <label className="ob-field">
          <span className="ob-label">Tick interval (min)</span>
          <input
            className={`ob-input ob-num ${tickInvalid ? 'invalid' : ''}`}
            value={tickDraft}
            onChange={(e) => {
              setTickDraft(e.target.value);
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 1) onChange({ ...value, tickIntervalMin: n });
            }}
          />
        </label>
        <div className="ob-field">
          <span className="ob-label">Briefings</span>
          <div className="ob-time-pair">
            <span className="ob-hint">morning</span>
            <TimeInput value={value.morningBriefAt} onCommit={(v) => onChange({ ...value, morningBriefAt: v })} />
            <span className="ob-hint">evening</span>
            <TimeInput value={value.eveningBriefAt} onCommit={(v) => onChange({ ...value, eveningBriefAt: v })} />
          </div>
        </div>
      </div>
    </div>
  );
}
