import { describe, expect, it } from 'vitest';
import { PANEL_HTML } from '../src/panel.js';

// PANEL_HTML is a served static page (vanilla JS, no build step) with no DOM test
// harness in this package (no jsdom dependency). These are refactor-free string
// assertions that pin the exact inject-form bugfixes so a regression in the
// template literal is caught even without executing the script in a browser.
describe('inject form (PANEL_HTML client script)', () => {
  it('guards the "— template —" placeholder (value \'\') before treating it as index 0', () => {
    // Must check for the empty placeholder value and bail out *before* computing
    // templates[Number(v)] — otherwise Number('') === 0 silently reloads templates[0].
    expect(PANEL_HTML).toMatch(/const v = \$\('tmplSel'\)\.value;\s*\n\s*\/\/[^\n]*\n\s*if \(v === ''\) \{ tmplExtra = \{\}; return; \}/);
  });

  it('resets tmplExtra and the template select after every inject, so hand-typed follow-ups default clean', () => {
    const injBtn = PANEL_HTML.slice(PANEL_HTML.indexOf("$('injBtn').onclick"));
    // The reset must happen after a successful POST but still inside the try block,
    // before the next inject can read stale tmplExtra state.
    expect(injBtn).toMatch(/await api\('\/control\/inject', body\);[\s\S]*?tmplExtra = \{\};[\s\S]*?\$\('tmplSel'\)\.value = '';/);
  });

  it('carries threadRef, direction and actor displayName from the currently-armed template only', () => {
    const onchange = PANEL_HTML.slice(
      PANEL_HTML.indexOf("$('tmplSel').onchange"),
      PANEL_HTML.indexOf("$('loadBtn').onclick"),
    );
    expect(onchange).toContain('if (t.event.threadRef) tmplExtra.threadRef = t.event.threadRef;');
    expect(onchange).toContain('if (t.event.direction) tmplExtra.direction = t.event.direction;');
    expect(onchange).toContain('if (t.event.actor && t.event.actor.displayName) tmplExtra.displayName = t.event.actor.displayName;');

    const injBtn = PANEL_HTML.slice(PANEL_HTML.indexOf("$('injBtn').onclick"));
    expect(injBtn).toContain('if (tmplExtra.displayName) actor.displayName = tmplExtra.displayName;');
    expect(injBtn).toContain("if (tmplExtra.threadRef) body.threadRef = tmplExtra.threadRef;");
    expect(injBtn).toContain("if (tmplExtra.direction) body.direction = tmplExtra.direction;");
  });
});
