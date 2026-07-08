import { useMemo, useState } from 'react';
import { tryParseJson } from '../lib/format.js';

/**
 * Collapsible pretty-printed JSON block. Accepts an object or a (possibly
 * invalid) JSON string — invalid strings render verbatim.
 */
export function JsonViewer({
  data,
  label,
  startOpen = false,
  maxHeight = 420,
}: {
  data: unknown;
  label?: string;
  startOpen?: boolean;
  maxHeight?: number;
}) {
  const [open, setOpen] = useState(startOpen);
  const text = useMemo(() => {
    const value = typeof data === 'string' ? tryParseJson(data) : data;
    if (value === null || value === undefined) return '∅';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [data]);

  return (
    <div className={`json-viewer ${open ? 'open' : ''}`}>
      <button className="json-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="json-caret">{open ? '▾' : '▸'}</span>
        {label ?? 'JSON'}
        <span className="json-size">{text.length.toLocaleString()} chars</span>
      </button>
      {open && (
        <pre className="json-body" style={{ maxHeight }}>
          {text}
        </pre>
      )}
    </div>
  );
}
