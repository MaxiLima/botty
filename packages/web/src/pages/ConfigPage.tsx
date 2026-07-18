import { useCallback, useEffect, useState } from 'react';
import { CONFIG_FILE_NAMES, type ConfigFileName } from '@botty/shared';
import { api } from '../lib/api.js';
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
}

type AllState = Record<ConfigFileName, EditorState>;

const empty = (): EditorState => ({
  loaded: '',
  draft: '',
  loadedAt: '',
  warnings: [],
  saving: false,
  error: null,
});

export function ConfigPage() {
  const [state, setState] = useState<AllState>({ persona: empty(), team: empty(), heartbeat: empty() });
  const [pageError, setPageError] = useState<string | null>(null);

  const patch = (name: ConfigFileName, p: Partial<EditorState>) =>
    setState((prev) => ({ ...prev, [name]: { ...prev[name], ...p } }));

  const refetch = useCallback(async (only?: ConfigFileName) => {
    try {
      setPageError(null);
      const { files } = await api.config();
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
    void refetch(CONFIG_FILE_NAMES.includes(name) ? name : undefined);
  });

  const save = async (name: ConfigFileName) => {
    patch(name, { saving: true, error: null });
    try {
      const res = await api.saveConfig(name, state[name].draft);
      patch(name, { saving: false, warnings: res.warnings, loaded: state[name].draft, loadedAt: new Date().toISOString() });
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
          return (
            <section key={name} className={`config-editor ${dirty ? 'dirty' : ''}`}>
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
