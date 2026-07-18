import type { OnboardingState } from '@botty/shared';

/** Step 1 — read-only environment checks. Writes nothing. */
export function WelcomeStep({ state }: { state: OnboardingState }) {
  const { checks } = state;
  const modeLine =
    checks.mode === 'sim'
      ? 'Sim mode — events come from the simulator; safe to explore, nothing real is polled.'
      : 'Real mode — botty polls live sources on the configured cadence.';
  return (
    <div className="ob-step">
      <h2>Welcome to botty</h2>
      <p className="ob-lead">
        This wizard personalizes your install: persona, team roster, sources, external tools,
        schedule and standing directives. Every step is skippable — nothing is written until you
        confirm on the final Review step.
      </p>
      <ul className="ob-checks">
        <li className={`ob-check ${checks.llmAuth ? 'ok' : 'fail'}`}>
          <span className="ob-check-mark">{checks.llmAuth ? '✓' : '✕'}</span>
          <span>
            {checks.llmAuth ? (
              'LLM auth is visible to the agent.'
            ) : (
              <>
                No LLM auth — the agent can&apos;t see <code>ANTHROPIC_API_KEY</code> or{' '}
                <code>ANTHROPIC_AUTH_TOKEN</code>, so everything downstream is dead until you fix
                this. See README § LLM auth.
              </>
            )}
          </span>
        </li>
        <li className="ob-check ok">
          <span className="ob-check-mark">·</span>
          <span>{modeLine}</span>
        </li>
        {checks.mockLlm && (
          <li className="ob-check warn">
            <span className="ob-check-mark">!</span>
            <span>
              Mock LLM is active (<code>BOTTY_MOCK_LLM</code>) — responses are deterministic stubs
              and tick judgment always skips.
            </span>
          </li>
        )}
        {checks.notifier !== null && (
          <li className={`ob-check ${checks.notifier ? 'ok' : 'warn'}`}>
            <span className="ob-check-mark">{checks.notifier ? '✓' : '!'}</span>
            <span>
              {checks.notifier ? (
                'macOS notifier app is installed.'
              ) : (
                <>
                  macOS notifier not installed — run <code>npm run setup:notifier</code> for branded
                  notifications.
                </>
              )}
            </span>
          </li>
        )}
        <li className="ob-check ok">
          <span className="ob-check-mark">·</span>
          <span>
            Your data lives in <code>{checks.dataDir}</code>.
          </span>
        </li>
      </ul>
      {state.onboarded && state.completedAt && (
        <p className="ob-note">
          Setup was last completed {new Date(state.completedAt).toLocaleString()}. This re-run is
          prefilled from your current config — only steps you confirm get rewritten.
        </p>
      )}
      {state.prefillWarnings.length > 0 && (
        <ul className="warning-list ob-prefill-warnings">
          {state.prefillWarnings.map((warning, i) => (
            <li key={i}>⚠ {warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
