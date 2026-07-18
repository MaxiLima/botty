import { useCallback, useEffect, useState } from 'react';
import { ONBOARDING_STEPS } from '@botty/shared';
import type {
  DirectivesAnswers,
  McpAnswers,
  OnboardingApplyRequest,
  OnboardingState,
  OnboardingStepName,
  PersonaAnswers,
  ScheduleAnswers,
  SourcesAnswers,
  TeamAnswers,
} from '@botty/shared';
import { api } from '../../lib/api.js';
import { navigate } from '../../lib/router.js';
import { markOnboarded } from '../../lib/stores.js';
import { WelcomeStep } from './WelcomeStep.js';
import { PersonaStep, emptyPersonaFields } from './PersonaStep.js';
import { TeamStep } from './TeamStep.js';
import { SourcesStep } from './SourcesStep.js';
import { McpStep } from './McpStep.js';
import { ScheduleStep } from './ScheduleStep.js';
import { DirectivesStep } from './DirectivesStep.js';
import { ReviewStep } from './ReviewStep.js';
import '../../styles/onboarding.css';

type Screen = 'welcome' | OnboardingStepName | 'review';
const SCREENS: Screen[] = ['welcome', ...ONBOARDING_STEPS, 'review'];
const SCREEN_LABELS: Record<Screen, string> = {
  welcome: 'Welcome',
  persona: 'Persona',
  team: 'Team',
  sources: 'Sources',
  mcp: 'MCP tools',
  schedule: 'Schedule',
  directives: 'Directives',
  review: 'Review & apply',
};

interface Answers {
  persona: PersonaAnswers;
  team: TeamAnswers;
  sources: SourcesAnswers;
  mcp: McpAnswers;
  schedule: ScheduleAnswers;
  directives: DirectivesAnswers;
}

/** Prefill always carries every section (answersFromConfig), but the schema keeps
 * them optional — fall back defensively so a partial server can't crash the page. */
function answersFromPrefill(state: OnboardingState): Answers {
  const p = state.prefill;
  return {
    // First run: guided composition fields. Re-run: current file text per section.
    persona: state.onboarded ? (p.persona ?? emptyPersonaFields()) : emptyPersonaFields(),
    team: p.team ?? { people: [] },
    sources:
      p.sources ??
      ({
        slack: { enabled: true },
        gmail: { enabled: true },
        gcal: { enabled: true },
        jira: { enabled: true },
        github: { enabled: true },
      } satisfies SourcesAnswers),
    mcp: p.mcp ?? { servers: {} },
    schedule:
      p.schedule ??
      ({
        workingHours: { start: '08:00', end: '19:00' },
        quietHours: { start: '22:00', end: '08:00' },
        activeDays: [1, 2, 3, 4, 5],
        tickIntervalMin: 20,
        morningBriefAt: '08:45',
        eveningBriefAt: '18:00',
      } satisfies ScheduleAnswers),
    directives: p.directives ?? { instructions: '', thisWeek: '', checklist: [], advanced: {} },
  };
}

export function OnboardingPage() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [confirmed, setConfirmed] = useState<Set<OnboardingStepName>>(new Set());
  const [screenIdx, setScreenIdx] = useState(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const s = await api.onboarding();
      setState(s);
      setAnswers(answersFromPrefill(s));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = 'botty · setup';
  }, []);

  const screen = SCREENS[screenIdx] ?? 'welcome';
  const isWritable = screen !== 'welcome' && screen !== 'review';

  /** Editing a step is an implicit confirm — an edited value the user then
   * navigates away from must not be silently dropped at apply. */
  const edit = <K extends OnboardingStepName>(step: K, value: Answers[K]) => {
    setAnswers((prev) => (prev ? { ...prev, [step]: value } : prev));
    setConfirmed((prev) => (prev.has(step) ? prev : new Set(prev).add(step)));
  };

  const goto = (idx: number) => setScreenIdx(Math.max(0, Math.min(SCREENS.length - 1, idx)));
  const next = () => {
    if (isWritable) {
      setConfirmed((prev) => (prev.has(screen) ? prev : new Set(prev).add(screen)));
    }
    goto(screenIdx + 1);
  };
  /** Skip = leave this step out of the apply, even if it was confirmed before. */
  const skip = () => {
    if (isWritable) {
      setConfirmed((prev) => {
        if (!prev.has(screen)) return prev;
        const nextSet = new Set(prev);
        nextSet.delete(screen);
        return nextSet;
      });
    }
    goto(screenIdx + 1);
  };

  const buildRequest = (): OnboardingApplyRequest | null => {
    if (!state || !answers) return null;
    const steps = ONBOARDING_STEPS.filter((s) => confirmed.has(s));
    if (steps.length === 0) return null;
    return {
      answers: {
        persona: answers.persona,
        team: answers.team,
        sources: answers.sources,
        mcp: answers.mcp,
        schedule: answers.schedule,
        directives: answers.directives,
      },
      steps,
      mtimes: state.mtimes,
    };
  };

  return (
    <div className="ob-page">
      <header className="ob-head">
        <span className="brand-mark">
          bo<span className="brand-tty">tty</span>
        </span>
        <span className="ob-head-title">setup</span>
        <span className="ob-footer-spacer" />
        <button className="btn btn-ghost btn-mini" onClick={() => navigate('chat')}>
          exit setup
        </button>
      </header>

      {loadError && (
        <div className="ob-load-error">
          <div className="page-error">
            Can&apos;t reach the agent: {loadError}{' '}
            <button className="btn btn-mini" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {!state && !loadError && <div className="ob-loading muted">loading current config…</div>}

      {state && answers && (
        <div className="ob-body">
          <nav className="ob-rail">
            {SCREENS.map((s, i) => (
              <button
                key={s}
                className={`ob-rail-item ${i === screenIdx ? 'active' : ''} ${
                  s !== 'welcome' && s !== 'review' && confirmed.has(s) ? 'confirmed' : ''
                }`}
                onClick={() => goto(i)}
              >
                <span className="ob-rail-num">
                  {s !== 'welcome' && s !== 'review' && confirmed.has(s) ? '✓' : i + 1}
                </span>
                {SCREEN_LABELS[s]}
              </button>
            ))}
          </nav>

          <main className="ob-main">
            {screen === 'welcome' && <WelcomeStep state={state} />}
            {screen === 'persona' && (
              <PersonaStep
                value={answers.persona}
                prefill={state.prefill.persona}
                onChange={(v) => edit('persona', v)}
              />
            )}
            {screen === 'team' && <TeamStep value={answers.team} onChange={(v) => edit('team', v)} />}
            {screen === 'sources' && (
              <SourcesStep
                value={answers.sources}
                mode={state.checks.mode}
                onChange={(v) => edit('sources', v)}
              />
            )}
            {screen === 'mcp' && <McpStep value={answers.mcp} onChange={(v) => edit('mcp', v)} />}
            {screen === 'schedule' && (
              <ScheduleStep value={answers.schedule} onChange={(v) => edit('schedule', v)} />
            )}
            {screen === 'directives' && (
              <DirectivesStep value={answers.directives} onChange={(v) => edit('directives', v)} />
            )}
            {screen === 'review' && (
              <ReviewStep
                request={buildRequest()}
                onApplied={markOnboarded}
                onBack={() => goto(screenIdx - 1)}
              />
            )}

            {screen !== 'review' && (
              <div className="ob-footer">
                <button className="btn" disabled={screenIdx === 0} onClick={() => goto(screenIdx - 1)}>
                  ← Back
                </button>
                <span className="ob-footer-spacer" />
                {isWritable && (
                  <button className="btn btn-ghost" onClick={skip} title="Advance without writing this step's file">
                    Skip
                  </button>
                )}
                <button className="btn btn-send" onClick={next}>
                  {screen === 'welcome' ? 'Start →' : 'Next →'}
                </button>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
