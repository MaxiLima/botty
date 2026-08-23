import { useCallback, useEffect, useState } from 'react';
import { CONFIG_FILE_NAMES, type ConfigFileName } from '@botty/shared';
import { api, type ConfigIssue } from '../lib/api.js';
import { shortDateTime } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { useOnReconnect, useWsEvent } from '../lib/ws.js';
import '../styles/config.css';

const FILE_INFO: Record<ConfigFileName, { file: string; blurb: string }> = {
  persona: { file: 'PERSONA.md', blurb: 'identity, voice, banned phrases, who you are' },
  team: { file: 'TEAM.md', blurb: 'people + weights — doubles as the ingestion whitelist' },
  heartbeat: { file: 'HEARTBEAT.md', blurb: 'loop schedule, thresholds, poll intervals, instructions' },
};

interface EditorState {
  loaded: string; // content as last fetched
  draft: string;
  loadedAt: string;
  warnings: string[];
  saving: boolean;
  error: string | null;
  /**
   * Non-null when the content this editor is showing is NOT what the agent is
   * running — the on-disk (or just-saved) file failed to parse cleanly, so
   * the agent kept serving the last-known-good version underneath. Only
   * heartbeat.md has a last-known-good fallback (config/index.ts); persona
   * and team always take effect as saved, so this stays null for them.
   */
  issues: ConfigIssue | null;
}

type AllState = Record<ConfigFileName, EditorState>;

const empty = (): EditorState => ({
  loaded: '',
  draft: '',
  loadedAt: '',
  warnings: [],
  saving: false,
  error: null,
  issues: null,
});

export function ConfigPage() {
  const [state, setState] = useState<AllState>({ persona: empty(), team: empty(), heartbeat: empty() });
  const [pageError, setPageError] = useState<string | null>(null);

  const patch = (name: ConfigFileName, p: Partial<EditorState>) =>
    setState((prev) => ({ ...prev, [name]: { ...prev[name], ...p } }));

  const refetch = useCallback(async (only?: ConfigFileName) => {
    try {
      setPageError(null);
      const { files, issues } = await api.config();
      const at = new Date().toISOString();
      setState((prev) => {
        const next = { ...prev };
        for (const name of CONFIG_FILE_NAMES) {
          if (only && name !== only) continue;
          const cur = prev[name];
          const dirty = cur.draft !== cur.loaded;
          next[name] = {
            ...cur,
            loaded: files[name],
            // don't clobber unsaved local edits on a hot-reload push
            draft: dirty ? cur.draft : files[name],
            loadedAt: at,
            issues: (name === 'heartbeat' ? issues.heartbeat : null) ?? null,
          };
        }
        return next;
      });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());
  useWsEvent('config.changed', (p) => {
    const name = p.name as ConfigFileName;
    // A hot-reload push that carries warnings means the agent rejected that
    // revision and kept serving the last-known-good one underneath — flag it
    // immediately (don't wait on the refetch round-trip) so "the page shows
    // the new text as if it were live" can't happen even for a moment.
    if (p.warnings && p.warnings.length > 0 && CONFIG_FILE_NAMES.includes(name)) {
      patch(name as ConfigFileName, { issues: { warnings: p.warnings, since: new Date().toISOString() } });
    }
    void refetch(CONFIG_FILE_NAMES.includes(name) ? name : undefined);
  });

  const save = async (name: ConfigFileName) => {
    patch(name, { saving: true, error: null });
    try {
      const res = await api.saveConfig(name, state[name].draft);
      patch(name, { saving: false, warnings: res.warnings, loaded: state[name].draft, loadedAt: new Date().toISOString() });
      // A save with warnings never replaces last-known-good either — refetch
      // to pick up the authoritative `issues` state rather than assuming
      // `loaded` (this draft) is now what's running.
      if (res.warnings.length > 0) void refetch(name);
    } catch (err) {
      patch(name, { saving: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="config-page">
      {pageError && <div className="page-error">{pageError}</div>}
      <div className="config-toolbar">
        <span className="muted">Prefer a guided walkthrough of these files?</span>
        <button className="btn btn-ghost" onClick={() => navigate('onboarding')}>
          Run setup again
        </button>
      </div>
      <div className="config-grid">
        {CONFIG_FILE_NAMES.map((name) => {
          const s = state[name];
          const dirty = s.draft !== s.loaded;
          // The editor is showing content the agent is NOT running whenever
          // there's an unresolved parse issue AND the user hasn't since typed
          // something different — a fresh edit is the user's own draft, not
          // the rejected on-disk content, so it doesn't need the "not live"
          // treatment (saving it will surface its own warnings on the next
          // refetch if it's still broken).
          const notLive = s.issues !== null && !dirty;
          return (
            <section key={name} className={`config-editor ${dirty ? 'dirty' : ''} ${notLive ? 'not-live' : ''}`}>
              <header className="config-head">
                <div>
                  <h2>{FILE_INFO[name].file}</h2>
                  <span className="muted">{FILE_INFO[name].blurb}</span>
                </div>
                <div className="config-head-right">
                  {s.loadedAt && (
                    <span className="muted" title={s.loadedAt}>
                      loaded {shortDateTime(s.loadedAt)}
                    </span>
                  )}
                  <button className="btn" disabled={!dirty || s.saving} onClick={() => void save(name)}>
                    {s.saving ? 'saving…' : dirty ? 'Save' : 'Saved'}
                  </button>
                </div>
              </header>
              {notLive && s.issues && (
                <div className="config-not-live-banner" role="alert">
                  <strong>⚠ Not live.</strong> This file failed to parse — botty is still running the
                  last-known-good version from before {shortDateTime(s.issues.since)}. The text below is
                  what&apos;s on disk, not what the agent is using.
                  <ul className="warning-list">
                    {s.issues.warnings.map((w, i) => (
                      <li key={i}>⚠ {w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <textarea
                className="config-textarea"
                spellCheck={false}
                value={s.draft}
                onChange={(e) => patch(name, { draft: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                    e.preventDefault();
                    if (dirty && !s.saving) void save(name);
                  }
                }}
              />
              {s.error && <div className="page-error">{s.error}</div>}
              {s.warnings.length > 0 && (
                <ul className="warning-list">
                  {s.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
