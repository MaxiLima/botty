import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { WizardEditor } from '../src/editor.js';

const ESC = '\u001B';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const ENTER = '\r';
const CTRL_N = '\u000E';
const BACKSPACE = '\u007F';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** useInput subscribes in an effect — flush a macrotask after mount and after
 * each write so every keystroke lands on an attached listener. */
async function mount(initial: string) {
  const onSubmit = vi.fn();
  const r = render(<WizardEditor initial={initial} onSubmit={onSubmit} />);
  await tick();
  return {
    ...r,
    onSubmit,
    type: async (s: string) => {
      r.stdin.write(s);
      await tick();
    },
  };
}

describe('WizardEditor', () => {
  it('renders a multiline prefill as separate lines with the hint', async () => {
    const { lastFrame } = await mount('- Direct, warm but terse.\n- Short paragraphs.');
    const frame = lastFrame()!;
    expect(frame).toContain('- Direct, warm but terse.');
    expect(frame).toContain('- Short paragraphs.');
    expect(frame).toContain('enter saves');
  });

  it('Enter with the prefill untouched submits it verbatim (keep semantics)', async () => {
    const { type, onSubmit } = await mount('line one\nline two');
    await type(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
  });

  it('typing inserts at the cursor (initially at the end)', async () => {
    const { type, onSubmit } = await mount('hello');
    await type('!');
    await type(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('hello!');
  });

  it('ctrl+n inserts a newline; arrows navigate across lines for mid-line edits', async () => {
    const { type, onSubmit } = await mount('first');
    await type(CTRL_N);
    await type('second');
    // up to line 1 (col clamps to end of "first"), append " edited"
    await type(UP);
    await type(' edited');
    await type(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('first edited\nsecond');
  });

  it('backspace at column 0 joins with the previous line', async () => {
    const { type, onSubmit } = await mount('ab\ncd');
    await type(DOWN); // cursor already on last line; no-op guard
    await type(LEFT);
    await type(LEFT); // to col 0 of "cd"
    await type(BACKSPACE);
    await type(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('abcd');
  });

  it('multi-line paste lands as multiple lines', async () => {
    const { type, onSubmit } = await mount('');
    await type('one\ntwo\nthree');
    await type(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('one\ntwo\nthree');
  });

  it('esc does nothing here (the wizard shell owns back-navigation)', async () => {
    const { type, onSubmit } = await mount('keep me');
    await type(ESC);
    await type(ENTER);
    expect(onSubmit).toHaveBeenCalledWith('keep me');
  });
});
