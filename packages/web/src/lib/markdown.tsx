import { useMemo } from 'react';
import { Marked, type Tokens } from 'marked';

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Only http(s), mailto, and relative URLs survive — javascript:, data:, and
 * every other scheme are dropped. Marked's own cleanUrl merely encodeURIs,
 * which lets `javascript:` through, and this HTML is injected via
 * dangerouslySetInnerHTML into an origin with full agent-API access.
 */
export function sanitizeUrl(href: string): string | null {
  // Strip control chars and whitespace first — browsers ignore them when
  // parsing URLs, so `java\tscript:` would otherwise slip past a scheme check.
  const cleaned = href.replace(/[\u0000-\u0020]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)?.[1];
  if (scheme && !/^(?:https?|mailto)$/i.test(scheme)) return null;
  return href;
}

// Raw HTML in the source is escaped, never passed through — the only tags in the
// output are the ones marked itself generates from markdown syntax. Links and
// images additionally get their URLs protocol-filtered (see sanitizeUrl).
const md = new Marked({
  gfm: true,
  breaks: true,
  // marked 13 wraps custom renderers in an old-positional-args compat shim
  // unless this flag is set; our overrides take token objects.
  useNewRenderer: true,
  renderer: {
    html(token) {
      return escapeHtml(token.raw);
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = sanitizeUrl(token.href);
      if (href === null) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(token: Tokens.Image) {
      const src = sanitizeUrl(token.href);
      if (src === null) return escapeHtml(token.text);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}"${title} />`;
    },
  },
});

export function renderMarkdown(source: string): string {
  try {
    return md.parse(source, { async: false }) as string;
  } catch {
    // Never let a rendering edge case eat the message — show it as plain text.
    return `<p>${escapeHtml(source).replaceAll('\n', '<br />')}</p>`;
  }
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
