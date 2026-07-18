import { useState } from 'react';
import type { PersonaAnswers } from '@botty/shared';

type FieldsPersona = Extract<PersonaAnswers, { kind: 'fields' }>;
type SectionsPersona = Extract<PersonaAnswers, { kind: 'sections' }>;

export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

export function emptyPersonaFields(): FieldsPersona {
  return { kind: 'fields', name: '', role: '', addressAs: '', timezone: guessTimezone(), tone: '', banned: '' };
}

const EMPTY_SECTIONS: SectionsPersona = { kind: 'sections', identity: '', about: '', voice: '', banned: '' };

interface PersonaStepProps {
  value: PersonaAnswers;
  /** Prefill from the server — sections text feeds the fields↔sections toggle. */
  prefill: PersonaAnswers | undefined;
  onChange: (v: PersonaAnswers) => void;
}

/** Step 2 — persona.md. Guided composition, not a form: the server assembles the file. */
export function PersonaStep({ value, prefill, onChange }: PersonaStepProps) {
  // Each mode keeps its own draft so toggling back and forth loses nothing.
  const [fields, setFields] = useState<FieldsPersona>(() =>
    value.kind === 'fields' ? value : emptyPersonaFields(),
  );
  const [sections, setSections] = useState<SectionsPersona>(() =>
    value.kind === 'sections' ? value : prefill?.kind === 'sections' ? prefill : { ...EMPTY_SECTIONS },
  );

  // Degraded path: the file no longer matches the template headings — full-file editor.
  if (value.kind === 'raw') {
    return (
      <div className="ob-step">
        <h2>Persona</h2>
        <p className="ob-note ob-warn">
          Your current persona.md no longer matches the template&apos;s section headings, so the
          wizard shows the full file for editing instead of guided fields.
        </p>
        <textarea
          className="ob-textarea ob-raw"
          spellCheck={false}
          value={value.content}
          onChange={(e) => onChange({ kind: 'raw', content: e.target.value })}
        />
      </div>
    );
  }

  const mode = value.kind;
  const setMode = (m: 'fields' | 'sections') => {
    if (m !== mode) onChange(m === 'fields' ? fields : sections);
  };
  const patchFields = (p: Partial<Omit<FieldsPersona, 'kind'>>) => {
    const next = { ...fields, ...p };
    setFields(next);
    onChange(next);
  };
  const patchSections = (p: Partial<Omit<SectionsPersona, 'kind'>>) => {
    const next = { ...sections, ...p };
    setSections(next);
    onChange(next);
  };

  return (
    <div className="ob-step">
      <h2>Persona</h2>
      <p className="ob-lead">
        persona.md is injected verbatim into every prompt — it&apos;s who botty is talking to and
        how it should sound.
      </p>
      <div className="ob-toggle">
        <button className={mode === 'fields' ? 'on' : ''} onClick={() => setMode('fields')}>
          Guided fields
        </button>
        <button className={mode === 'sections' ? 'on' : ''} onClick={() => setMode('sections')}>
          Edit sections
        </button>
      </div>

      {mode === 'fields' ? (
        <>
          <div className="ob-grid2">
            <label className="ob-field">
              <span className="ob-label">Your name</span>
              <input className="ob-input" value={fields.name} onChange={(e) => patchFields({ name: e.target.value })} />
            </label>
            <label className="ob-field">
              <span className="ob-label">Role / company</span>
              <input className="ob-input" value={fields.role} onChange={(e) => patchFields({ role: e.target.value })} />
            </label>
            <label className="ob-field">
              <span className="ob-label">How botty should address you</span>
              <input
                className="ob-input"
                value={fields.addressAs}
                onChange={(e) => patchFields({ addressAs: e.target.value })}
              />
            </label>
            <label className="ob-field">
              <span className="ob-label">Timezone</span>
              <input
                className="ob-input"
                value={fields.timezone}
                placeholder="e.g. America/Argentina/Buenos_Aires"
                onChange={(e) => patchFields({ timezone: e.target.value })}
              />
            </label>
          </div>
          <p className="ob-hint">
            The timezone is written as a labeled line under <code>## About</code> — still prose, but
            it stops the model from guessing.
          </p>
          <label className="ob-field">
            <span className="ob-label">Voice &amp; tone notes</span>
            <textarea
              className="ob-textarea"
              value={fields.tone}
              placeholder="terse, dry, no exclamation marks…"
              onChange={(e) => patchFields({ tone: e.target.value })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">Banned behaviors</span>
            <textarea
              className="ob-textarea"
              value={fields.banned}
              placeholder="things botty must never do or say"
              onChange={(e) => patchFields({ banned: e.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <label className="ob-field">
            <span className="ob-label">## Identity</span>
            <textarea
              className="ob-textarea"
              value={sections.identity}
              onChange={(e) => patchSections({ identity: e.target.value })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">## About</span>
            <textarea
              className="ob-textarea"
              value={sections.about}
              onChange={(e) => patchSections({ about: e.target.value })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">## Voice &amp; tone</span>
            <textarea
              className="ob-textarea"
              value={sections.voice}
              onChange={(e) => patchSections({ voice: e.target.value })}
            />
          </label>
          <label className="ob-field">
            <span className="ob-label">## Banned</span>
            <textarea
              className="ob-textarea"
              value={sections.banned}
              onChange={(e) => patchSections({ banned: e.target.value })}
            />
          </label>
        </>
      )}
    </div>
  );
}
