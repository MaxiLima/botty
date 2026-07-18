import { useState } from 'react';
import { SOURCES, SOURCE_INTERVALS_REAL, SOURCE_INTERVALS_SIM } from '@botty/shared';
import type { SourceId, SourcesAnswers } from '@botty/shared';
import { SourceIcon } from '../../components/SourceIcon.js';

const LABELS: Record<SourceId, string> = {
  slack: 'Slack',
  gmail: 'Gmail',
  gcal: 'Calendar',
  jira: 'Jira',
  github: 'GitHub',
};

interface SourcesStepProps {
  value: SourcesAnswers;
  mode: 'sim' | 'real';
  onChange: (v: SourcesAnswers) => void;
}

/** Step 4 — heartbeat.md `## Sources`: on/off + optional poll interval override. */
export function SourcesStep({ value, mode, onChange }: SourcesStepProps) {
  const defaults = mode === 'real' ? SOURCE_INTERVALS_REAL : SOURCE_INTERVALS_SIM;
  const [drafts, setDrafts] = useState<Record<SourceId, string>>(() => {
    const d = {} as Record<SourceId, string>;
    for (const src of SOURCES) d[src] = value[src].intervalMin?.toString() ?? '';
    return d;
  });

  const setEnabled = (src: SourceId, enabled: boolean) =>
    onChange({ ...value, [src]: { ...value[src], enabled } });

  const setInterval_ = (src: SourceId, text: string) => {
    setDrafts((prev) => ({ ...prev, [src]: text }));
    const n = Number.parseInt(text, 10);
    const toggle = { ...value[src] };
    if (text.trim() === '' || !Number.isFinite(n) || n < 1) delete toggle.intervalMin;
    else toggle.intervalMin = n;
    onChange({ ...value, [src]: toggle });
  };

  return (
    <div className="ob-step">
      <h2>Sources</h2>
      <p className="ob-lead">
        Which sources botty polls, and how often. Leave the interval empty to use the {mode}-mode
        default.
      </p>
      {SOURCES.map((src) => {
        const draft = drafts[src];
        const n = Number.parseInt(draft, 10);
        const invalid = draft.trim() !== '' && !(Number.isFinite(n) && n >= 1);
        return (
          <div key={src} className={`ob-source-row ${value[src].enabled ? '' : 'off'}`}>
            <SourceIcon source={src} />
            <span className="ob-source-name">{LABELS[src]}</span>
            <label className="ob-check-toggle">
              <input
                type="checkbox"
                checked={value[src].enabled}
                onChange={(e) => setEnabled(src, e.target.checked)}
              />
              {value[src].enabled ? 'on' : 'off'}
            </label>
            <label className="ob-interval">
              <input
                className={`ob-input ob-num ${invalid ? 'invalid' : ''}`}
                value={draft}
                placeholder={`${defaults[src]} (default)`}
                onChange={(e) => setInterval_(src, e.target.value)}
              />
              <span className="ob-hint">min</span>
            </label>
            {mode === 'real' && (
              <span className="ob-hint ob-source-stub">
                driver not yet available — config saved for when it is
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
