// Pure request-building logic for the onboarding wizard's final POST, kept
// separate from the page component so it's unit-testable without a DOM
// harness (see docs/reports/2026-08-21-full-test-run.md §3 MEDIUM "Clients":
// "onboarding (web) sends blank team/checklist rows → preview/apply 400 even
// for steps the user skipped").
//
// Repeating-group steps (Team, the Directives checklist) let the user click
// "+ add" and then leave a row blank — walk to the next step, or skip
// straight to Review. TeamStep's own comment already promises "rows with a
// blank name are dropped at apply"; this is where that promise is kept.
// Both fields the server validates with `.min(1)` (TeamMemberAnswerSchema's
// `name`, ChecklistItemAnswerSchema's `text`) get stripped here so a blank
// row never reaches PUT /api/onboarding/{preview,apply} — the server-side
// tolerance for the same rows is a separate (agent-side) fix.
import type { DirectivesAnswers, OnboardingApplyRequest, OnboardingStepName, TeamAnswers } from '@botty/shared';

export function stripBlankTeamRows(team: TeamAnswers): TeamAnswers {
  return { people: team.people.filter((p) => p.name.trim() !== '') };
}

export function stripBlankChecklistRows(directives: DirectivesAnswers): DirectivesAnswers {
  return { ...directives, checklist: directives.checklist.filter((c) => c.text.trim() !== '') };
}

export interface OnboardingRequestAnswers {
  persona: OnboardingApplyRequest['answers']['persona'];
  team: TeamAnswers;
  sources: OnboardingApplyRequest['answers']['sources'];
  mcp: OnboardingApplyRequest['answers']['mcp'];
  schedule: OnboardingApplyRequest['answers']['schedule'];
  directives: DirectivesAnswers;
}

/**
 * Builds the request `POST /api/onboarding/{preview,apply}` expects: only the
 * confirmed steps are sent, and blank repeating-group rows are stripped so a
 * step the user opened-then-skipped (leaving one empty "+ add" row behind)
 * can't 400 a preview/apply that doesn't even touch that step's file.
 */
export function buildOnboardingRequest(
  answers: OnboardingRequestAnswers,
  confirmedSteps: ReadonlySet<OnboardingStepName>,
  allSteps: readonly OnboardingStepName[],
  mtimes: OnboardingApplyRequest['mtimes'],
): OnboardingApplyRequest | null {
  const steps = allSteps.filter((s) => confirmedSteps.has(s));
  if (steps.length === 0) return null;
  return {
    answers: {
      persona: answers.persona,
      team: stripBlankTeamRows(answers.team),
      sources: answers.sources,
      mcp: answers.mcp,
      schedule: answers.schedule,
      directives: stripBlankChecklistRows(answers.directives),
    },
    steps,
    mtimes,
  };
}
