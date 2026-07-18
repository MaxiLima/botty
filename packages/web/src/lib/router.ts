import { useSyncExternalStore } from 'react';

export const PAGES = ['chat', 'tasks', 'people', 'inspector', 'costs', 'config', 'onboarding'] as const;
export type Page = (typeof PAGES)[number];

function parseHash(): Page {
  const raw = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (PAGES as readonly string[]).includes(raw) ? (raw as Page) : 'chat';
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** Current page from the location hash (`#/tasks` → 'tasks'). Defaults to 'chat'. */
export function useRoute(): Page {
  return useSyncExternalStore(subscribe, parseHash);
}

export function navigate(page: Page): void {
  window.location.hash = `#/${page}`;
}
