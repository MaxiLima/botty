const GLYPHS: Record<string, { glyph: string; label: string; className: string }> = {
  slack: { glyph: '#', label: 'Slack', className: 'src-slack' },
  gmail: { glyph: '@', label: 'Gmail', className: 'src-gmail' },
  gcal: { glyph: '▦', label: 'Calendar', className: 'src-gcal' },
  jira: { glyph: '◆', label: 'Jira', className: 'src-jira' },
  github: { glyph: '⑂', label: 'GitHub', className: 'src-github' },
};

export function SourceIcon({ source }: { source: string }) {
  const g = GLYPHS[source] ?? { glyph: '·', label: source, className: 'src-other' };
  return (
    <span className={`source-icon ${g.className}`} title={g.label} aria-label={g.label}>
      {g.glyph}
    </span>
  );
}
