/** Local-time helpers for the loop (quiet hours, active days, briefing cron). */

/** "HH:MM" → minutes since midnight. Returns null on malformed input. */
export function parseHHMM(value: string): number | null {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since local midnight for an ISO timestamp. */
export function localMinutes(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** True when `nowIso` (local time) falls inside the quiet window. Wraps midnight. */
export function isQuietHours(nowIso: string, quiet: { start: string; end: string }): boolean {
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null || start === end) return false;
  const now = localMinutes(nowIso);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** True when `nowIso`'s local weekday (0=Sun) is in `activeDays`. */
export function isActiveDay(nowIso: string, activeDays: number[]): boolean {
  return activeDays.includes(new Date(nowIso).getDay());
}

/**
 * HARD on/off gate: true only when `nowIso` is on an active day AND inside the
 * working-hours window. Outside it botty does nothing at all (no polls, no
 * ticks, no briefings, no LLM calls) — see docs/specs/loop.md "Working hours".
 *
 * Semantics:
 * - Windows that cross midnight (e.g. 22:00-06:00) wrap; the active-day check
 *   always applies to the calendar day of `nowIso` itself.
 * - Malformed or degenerate (start === end) windows disable the gate (always
 *   within), so a config typo can never silently switch botty off.
 *
 * Used by the tick scheduler, briefings, and the ingest source scheduler.
 */
export function isWithinWorkingHours(
  nowIso: string,
  opts: { workingHours: { start: string; end: string }; activeDays: number[] },
): boolean {
  if (!isActiveDay(nowIso, opts.activeDays)) return false;
  const start = parseHHMM(opts.workingHours.start);
  const end = parseHHMM(opts.workingHours.end);
  if (start === null || end === null || start === end) return true;
  const now = localMinutes(nowIso);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Milliseconds until the next local occurrence of "HH:MM" strictly after `from`.
 * Returns null when `hhmm` is unparseable — callers must treat that as "don't
 * arm a timer" rather than falling back to midnight (an unparseable time used
 * to silently arm for 00:00 via `?? 0`, which is not "no-op", it's a real fire
 * time that the caller would then race against its working-hours gate).
 */
export function msUntilNextTime(from: Date, hhmm: string): number | null {
  const minutes = parseHHMM(hhmm);
  if (minutes === null) return null;
  const next = new Date(from);
  next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - from.getTime();
}
