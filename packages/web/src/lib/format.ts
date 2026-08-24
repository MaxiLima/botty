/** "3m" / "2h" / "5d" style relative age from an ISO timestamp. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '–';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '–';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 9) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
}

// `YYYY-MM-DD` (no time part) carries no time zone. `new Date(str)` parses it
// as UTC midnight, which lands on the wrong calendar day for any viewer not
// on UTC — see H2. Treat that shape specially and interpret it in the
// *viewer's* local calendar instead of UTC. Full ISO instants
// (`...T...Z`/offset) already carry an unambiguous moment and are untouched.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local midnight of a `YYYY-MM-DD` string, or null if the shape matched but
 * the value doesn't round-trip (e.g. "2026-02-30") — callers fall back to
 * the plain `new Date(iso)` parse (which yields `Invalid Date`) so garbage
 * input keeps behaving exactly as it did before this fix.
 */
function localMidnightOf(iso: string): Date | null {
  const m = DATE_ONLY_RE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(y, mo - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return d;
}

// Every label in this UI ("until", "loaded", "ago", …) is English, so the
// month/weekday text these produce must be too — `undefined` picks up the
// *viewer's OS/browser* locale, which on an es-* system renders e.g. "22 ago"
// (Spanish "ago[sto]" abbreviation) sitting right next to an English label
// like "until", reading as a typo instead of a date. Pin to 'en-US' rather
// than inheriting whatever locale the host happens to be set to.
const LOCALE = 'en-US';

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = (DATE_ONLY_RE.test(iso) && localMidnightOf(iso)) || new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
}

export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = (DATE_ONLY_RE.test(iso) && localMidnightOf(iso)) || new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Days until a due date; negative = overdue. A date-only due date has no
 * time of day, so it's compared by *local calendar day* (today's date-only
 * due date is 0, never negative, until the viewer's local clock rolls past
 * midnight) rather than against the current instant.
 */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  if (DATE_ONLY_RE.test(iso)) {
    const due = localMidnightOf(iso);
    if (!due) return null;
    const now = new Date();
    const todayLocalMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((due.getTime() - todayLocalMidnight.getTime()) / 86_400_000);
  }
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return null;
  return Math.ceil((d - Date.now()) / 86_400_000);
}

export function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Task priority: 1 = HIGH, 2 = NORMAL, 3 = LOW (docs/specs/data-model.md). */
export function priorityLabel(p: number): string {
  if (!Number.isFinite(p)) return 'P2'; // fall back to NORMAL
  const clamped = Math.min(3, Math.max(1, Math.round(p)));
  return `P${clamped}`;
}

/** Mirrors packages/tui/src/api.ts's ScheduleInfo — optional on GET /api/health
 * (older agents omit it). See scheduleHint below. */
export interface ScheduleInfo {
  withinWorkingHours: boolean;
  quietHours: boolean;
  workingHours: string;
  quietHoursRange: string;
  activeToday: boolean;
}

/**
 * Botty's proactive silence during off-hours/quiet-hours/inactive days is by
 * design, but looks indistinguishable from "broken" without a hint — the TUI
 * shows `◔ quiet 22:00-08:00` in its statusline (packages/tui/src/format.ts's
 * scheduleHint, kept in sync with this one). `schedule` is optional on the
 * health response (older agents omit it) — undefined means "say nothing", not
 * "assume always-on".
 */
export function scheduleHint(schedule: ScheduleInfo | null | undefined): string | null {
  if (!schedule) return null;
  if (!schedule.activeToday) return 'inactive today';
  if (schedule.quietHours) return `quiet ${schedule.quietHoursRange}`;
  if (!schedule.withinWorkingHours) return 'off-hours';
  return null;
}

export function tryParseJson(raw: string | null | undefined): unknown {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
