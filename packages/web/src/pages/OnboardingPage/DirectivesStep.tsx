import { useRef, useState } from 'react';
import { DEFAULT_MODELS, DEFAULT_MODEL_PRICING, HEARTBEAT_DEFAULTS } from '@botty/shared';
import type { DirectivesAnswers, LlmTask } from '@botty/shared';
import { navigate } from '../../lib/router.js';

const LLM_TASKS = Object.keys(DEFAULT_MODELS) as LlmTask[];
const MODEL_IDS = Object.keys(DEFAULT_MODEL_PRICING);

type Advanced = DirectivesAnswers['advanced'];

interface ChecklistRow {
  id: number;
  every: string;
  unit: 'm' | 'h' | 'd';
  text: string;
}

/** Optional int input — empty means "leave the current file value untouched". */
function OptNumberInput({
  value,
  min,
  max,
  placeholder,
  onCommit,
}: {
  value: number | undefined;
  min: number;
  max?: number;
  placeholder: string;
  onCommit: (v: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const n = Number.parseInt(draft, 10);
  const valid = Number.isFinite(n) && n >= min && (max === undefined || n <= max);
  const invalid = draft.trim() !== '' && !valid;
  return (
    <input
      className={`ob-input ob-num ${invalid ? 'invalid' : ''}`}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value.trim() === '') {
          onCommit(undefined);
          return;
        }
        const parsed = Number.parseInt(e.target.value, 10);
        if (Number.isFinite(parsed) && parsed >= min && (max === undefined || parsed <= max)) {
          onCommit(parsed);
        }
      }}
    />
  );
}

function OptBoolSelect({
  value,
  onCommit,
}: {
  value: boolean | undefined;
  onCommit: (v: boolean | undefined) => void;
}) {
  return (
    <select
      className="ob-input"
      value={value === undefined ? '' : value ? 'on' : 'off'}
      onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value === 'on')}
    >
      <option value="">keep current</option>
      <option value="on">on</option>
      <option value="off">off</option>
    </select>
  );
}

interface DirectivesStepProps {
  value: DirectivesAnswers;
  onChange: (v: DirectivesAnswers) => void;
}

/** Step 7 — heartbeat.md instructions/this-week/tasks + the curated advanced subset. */
export function DirectivesStep({ value, onChange }: DirectivesStepProps) {
  const [checkRows, setCheckRows] = useState<ChecklistRow[]>(() =>
    value.checklist.map((c, i) => ({ id: i, every: String(c.every), unit: c.unit, text: c.text })),
  );
  const idRef = useRef(value.checklist.length);

  const pushChecklist = (rows: ChecklistRow[]) => {
    setCheckRows(rows);
    onChange({
      ...value,
      checklist: rows.map((r) => {
        const n = Number.parseInt(r.every, 10);
        return { every: Number.isFinite(n) && n >= 1 ? n : 1, unit: r.unit, text: r.text };
      }),
    });
  };
  const patchRow = (id: number, p: Partial<Omit<ChecklistRow, 'id'>>) =>
    pushChecklist(checkRows.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const patchAdvanced = (p: Partial<Advanced>) =>
    onChange({ ...value, advanced: { ...value.advanced, ...p } });

  const models = value.advanced.models ?? {};
  const setModel = (task: LlmTask, model: string) => {
    const next = { ...models };
    if (model === DEFAULT_MODELS[task]) delete next[task];
    else next[task] = model;
    patchAdvanced({ models: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <div className="ob-step">
      <h2>Directives</h2>
      <label className="ob-field">
        <span className="ob-label">Standing instructions</span>
        <textarea
          className="ob-textarea"
          value={value.instructions}
          placeholder="how botty should behave day to day (template default is bias toward silence)"
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
        />
      </label>
      <label className="ob-field">
        <span className="ob-label">This week</span>
        <textarea
          className="ob-textarea"
          value={value.thisWeek}
          placeholder="current priorities — optional"
          onChange={(e) => onChange({ ...value, thisWeek: e.target.value })}
        />
      </label>

      <span className="ob-label">Recurring checklist</span>
      {checkRows.map((row) => {
        const n = Number.parseInt(row.every, 10);
        const invalid = !(Number.isFinite(n) && n >= 1);
        return (
          <div key={row.id} className="ob-card-row">
            <span className="ob-hint">every</span>
            <input
              className={`ob-input ob-num ${invalid ? 'invalid' : ''}`}
              value={row.every}
              onChange={(e) => patchRow(row.id, { every: e.target.value })}
            />
            <select
              className="ob-input"
              value={row.unit}
              onChange={(e) => patchRow(row.id, { unit: e.target.value as ChecklistRow['unit'] })}
            >
              <option value="m">minutes</option>
              <option value="h">hours</option>
              <option value="d">days</option>
            </select>
            <input
              className="ob-input ob-grow"
              value={row.text}
              placeholder="check the deploy queue"
              onChange={(e) => patchRow(row.id, { text: e.target.value })}
            />
            <button
              className="btn btn-ghost btn-danger btn-mini ob-card-remove"
              onClick={() => pushChecklist(checkRows.filter((r) => r.id !== row.id))}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        className="btn btn-mini"
        onClick={() =>
          pushChecklist([...checkRows, { id: idRef.current++, every: '1', unit: 'd', text: '' }])
        }
      >
        + checklist item
      </button>

      <details className="ob-advanced">
        <summary>Advanced — behavior knobs &amp; model routing</summary>
        <p className="ob-hint">
          Empty fields leave the current heartbeat.md values untouched. This is the curated subset —{' '}
          <button className="ob-link" onClick={() => navigate('config')}>
            open the heartbeat editor
          </button>{' '}
          for the full knob list.
        </p>
        <div className="ob-grid2">
          <label className="ob-field">
            <span className="ob-label">Surfacing threshold (1-10)</span>
            <OptNumberInput
              value={value.advanced.surfacingThreshold}
              min={1}
              max={10}
              placeholder={`keep current (default ${HEARTBEAT_DEFAULTS.surfacingThreshold})`}
              onCommit={(v) => patchAdvanced({ surfacingThreshold: v })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">Max proactive / hour</span>
            <OptNumberInput
              value={value.advanced.maxProactivePerHour}
              min={0}
              placeholder={`keep current (default ${HEARTBEAT_DEFAULTS.maxProactivePerHour})`}
              onCommit={(v) => patchAdvanced({ maxProactivePerHour: v })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">Min gap between nudges (min)</span>
            <OptNumberInput
              value={value.advanced.minGapBetweenNudgesMin}
              min={0}
              placeholder={`keep current (default ${HEARTBEAT_DEFAULTS.minGapBetweenNudgesMin})`}
              onCommit={(v) => patchAdvanced({ minGapBetweenNudgesMin: v })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">Commitments max / day</span>
            <OptNumberInput
              value={value.advanced.commitmentsMaxPerDay}
              min={0}
              placeholder={`keep current (default ${HEARTBEAT_DEFAULTS.commitmentsMaxPerDay})`}
              onCommit={(v) => patchAdvanced({ commitmentsMaxPerDay: v })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">Auto-resolve tasks</span>
            <OptBoolSelect
              value={value.advanced.autoResolveTasks}
              onCommit={(v) => patchAdvanced({ autoResolveTasks: v })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">Infer commitments</span>
            <OptBoolSelect
              value={value.advanced.inferCommitments}
              onCommit={(v) => patchAdvanced({ inferCommitments: v })}
            />
          </label>
        </div>
        <span className="ob-label">Model routing (llm.models — written to settings, not a file)</span>
        <div className="ob-grid2">
          {LLM_TASKS.map((task) => {
            const current = models[task] ?? DEFAULT_MODELS[task];
            const options = MODEL_IDS.includes(current) ? MODEL_IDS : [...MODEL_IDS, current];
            return (
              <label key={task} className="ob-field">
                <span className="ob-label">{task}</span>
                <select className="ob-input" value={current} onChange={(e) => setModel(task, e.target.value)}>
                  {options.map((m) => (
                    <option key={m} value={m}>
                      {m}
                      {m === DEFAULT_MODELS[task] ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </details>
    </div>
  );
}
