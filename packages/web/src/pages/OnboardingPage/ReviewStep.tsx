import { useCallback, useEffect, useState } from 'react';
import type { OnboardingApplyRequest, OnboardingApplyResponse, OnboardingPreviewResponse } from '@botty/shared';
import { api } from '../../lib/api.js';
import { navigate } from '../../lib/router.js';
import { diffLines } from './lineDiff.js';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function FileDiff({ current, content }: { current: string | null; content: string }) {
  // New file — no point diffing against nothing, just show it all as added.
  const lines =
    current === null
      ? content.split('\n').map((text) => ({ type: 'add' as const, text }))
      : diffLines(current, content);
  return (
    <pre className="ob-diff">
      {lines.map((l, i) => (
        <div key={i} className={`ob-diff-line ${l.type}`}>
          <span className="ob-diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

interface ReviewStepProps {
  /** null ⇔ every step was skipped — nothing to preview or apply. */
  request: OnboardingApplyRequest | null;
  onApplied: () => void;
  onBack: () => void;
}

/** Final step — server-rendered preview with per-file diffs, then one apply. */
export function ReviewStep({ request, onApplied, onBack }: ReviewStepProps) {
  const [preview, setPreview] = useState<OnboardingPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<OnboardingApplyResponse | null>(null);

  const fetchPreview = useCallback(async () => {
    if (!request) return;
    setPreviewError(null);
    try {
      setPreview(await api.onboardingPreview(request));
    } catch (err) {
      setPreviewError(errText(err));
    }
  }, [request]);

  useEffect(() => {
    void fetchPreview();
  }, [fetchPreview]);

  const apply = async () => {
    if (!request) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await api.onboardingApply(request);
      if (!res.ok) {
        const detail = Object.entries(res.warnings)
          .filter(([, w]) => w.length > 0)
          .map(([file, w]) => `${file}: ${w.join('; ')}`)
          .join(' · ');
        setApplyError(detail || 'apply failed');
        return;
      }
      setApplied(res);
      onApplied();
    } catch (err) {
      setApplyError(errText(err));
    } finally {
      setApplying(false);
    }
  };

  if (applied) {
    const warnings = Object.entries(applied.warnings).filter(([, w]) => w.length > 0);
    return (
      <div className="ob-step">
        <h2>Setup applied ✓</h2>
        <p className="ob-lead">
          Everything was written and hot-reloaded — no restart needed. Previous versions of each
          file are archived in <code>config/archive/</code> if you want to undo.
        </p>
        {warnings.length > 0 && (
          <ul className="warning-list ob-prefill-warnings">
            {warnings.map(([file, ws]) => ws.map((w, i) => <li key={`${file}-${i}`}>⚠ {file}: {w}</li>))}
          </ul>
        )}
        <button className="btn btn-send" onClick={() => navigate('chat')}>
          Go to chat →
        </button>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="ob-step">
        <h2>Review &amp; apply</h2>
        <p className="ob-lead">
          Every step was skipped — there is nothing to apply, and the current config stays exactly
          as it is.
        </p>
        <div className="ob-review-actions">
          <button className="btn" onClick={onBack}>
            ← Back
          </button>
          <span className="ob-footer-spacer" />
          <button className="btn btn-ghost" onClick={() => navigate('chat')}>
            Exit setup
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ob-step">
      <h2>Review &amp; apply</h2>
      <p className="ob-lead">
        Confirmed steps: {request.steps.join(', ')}. Only these files are written — everything else
        stays untouched.
      </p>
      {previewError && (
        <div className="page-error">
          Couldn&apos;t render the preview: {previewError}{' '}
          <button className="btn btn-mini" onClick={() => void fetchPreview()}>
            Retry
          </button>
        </div>
      )}
      {!preview && !previewError && <div className="ob-loading muted">rendering preview…</div>}
      {preview && (
        <>
          {Object.entries(preview.files).map(([name, f]) => (
            <section key={name} className="ob-file">
              <header className="ob-file-head">
                <span className="ob-file-name">{name}</span>
                {f.current === null && <span className="ob-file-chip changed">new file</span>}
                {f.current !== null && (
                  <span className={`ob-file-chip ${f.changed ? 'changed' : 'unchanged'}`}>
                    {f.changed ? 'changed' : 'unchanged'}
                  </span>
                )}
              </header>
              {f.changed ? (
                <FileDiff current={f.current} content={f.content} />
              ) : (
                <div className="ob-file-same muted">no changes</div>
              )}
            </section>
          ))}
          {preview.settings && Object.keys(preview.settings).length > 0 && (
            <section className="ob-file">
              <header className="ob-file-head">
                <span className="ob-file-name">settings</span>
                <span className="ob-file-chip changed">patched</span>
              </header>
              <pre className="ob-diff">
                {JSON.stringify(preview.settings, null, 2)
                  .split('\n')
                  .map((text, i) => (
                    <div key={i} className="ob-diff-line add">
                      <span className="ob-diff-sign">+</span>
                      {text}
                    </div>
                  ))}
              </pre>
            </section>
          )}
        </>
      )}
      <div className="ob-review-actions">
        <button className="btn" onClick={onBack}>
          ← Back
        </button>
        {applyError && <span className="page-error inline">{applyError}</span>}
        <span className="ob-footer-spacer" />
        <button className="btn btn-send" disabled={applying} onClick={() => void apply()}>
          {applying ? 'applying…' : 'Apply setup'}
        </button>
      </div>
    </div>
  );
}
