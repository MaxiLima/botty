import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Drawer({
  title,
  onClose,
  children,
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const asideRef = useRef<HTMLElement>(null);

  // Focus trap: move focus into the drawer on open, cycle Tab/Shift+Tab
  // within it while open, and restore focus to whatever had it before —
  // without this, Tab walks straight through into the page behind the scrim.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const el = asideRef.current;
    const first = el?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? el)?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const el = asideRef.current;
      if (!el) return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        ref={asideRef}
        className="drawer"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="drawer-head">
          <div className="drawer-title">{title}</div>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}
