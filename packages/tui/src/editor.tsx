import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * Multiline editor for wizard text questions. ink-text-input is single-line —
 * feeding it a persona section full of newlines breaks rendering and leaves
 * ↑↓ dead, so the wizard gets its own buffer: a real (row, col) cursor,
 * arrow-key navigation across lines, and multi-line paste support.
 *
 * Keys: ←→↑↓ move · ctrl+a/ctrl+e line start/end · backspace deletes ·
 * ctrl+n inserts a newline (terminals can't distinguish shift+enter) ·
 * enter submits the buffer. Esc is deliberately NOT handled here — App's
 * useInput owns it (backs the wizard up one question).
 */
export function WizardEditor({
  initial,
  onSubmit,
}: {
  initial: string;
  onSubmit: (text: string) => void;
}) {
  const [lines, setLines] = useState<string[]>(() => initial.split('\n'));
  const [cursor, setCursor] = useState<{ row: number; col: number }>(() => {
    const ls = initial.split('\n');
    const row = ls.length - 1;
    return { row, col: ls[row]?.length ?? 0 };
  });

  const clampCol = (row: number, col: number): number =>
    Math.max(0, Math.min(col, lines[row]?.length ?? 0));

  const insert = (text: string) => {
    // Pastes arrive as one chunk, possibly with \r\n / \r newlines; tabs would
    // render unpredictably, so they become spaces.
    const parts = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
    const line = lines[cursor.row] ?? '';
    const before = line.slice(0, cursor.col);
    const after = line.slice(cursor.col);
    const next = [...lines];
    if (parts.length === 1) {
      next[cursor.row] = before + parts[0] + after;
      setLines(next);
      setCursor({ row: cursor.row, col: cursor.col + (parts[0]?.length ?? 0) });
      return;
    }
    const middle = parts.slice(1, -1);
    const last = parts[parts.length - 1] ?? '';
    next.splice(cursor.row, 1, before + (parts[0] ?? ''), ...middle, last + after);
    setLines(next);
    setCursor({ row: cursor.row + parts.length - 1, col: last.length });
  };

  const backspace = () => {
    const line = lines[cursor.row] ?? '';
    if (cursor.col > 0) {
      const next = [...lines];
      next[cursor.row] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
      setLines(next);
      setCursor({ row: cursor.row, col: cursor.col - 1 });
      return;
    }
    if (cursor.row === 0) return;
    const prev = lines[cursor.row - 1] ?? '';
    const next = [...lines];
    next.splice(cursor.row - 1, 2, prev + line);
    setLines(next);
    setCursor({ row: cursor.row - 1, col: prev.length });
  };

  useInput((input, key) => {
    if (key.escape || key.tab) return; // esc belongs to the wizard shell
    if (key.return) {
      onSubmit(lines.join('\n'));
      return;
    }
    if (key.ctrl && input === 'n') {
      insert('\n');
      return;
    }
    if (key.ctrl && input === 'a') {
      setCursor((c) => ({ ...c, col: 0 }));
      return;
    }
    if (key.ctrl && input === 'e') {
      setCursor((c) => ({ ...c, col: lines[c.row]?.length ?? 0 }));
      return;
    }
    if (key.leftArrow) {
      setCursor((c) =>
        c.col > 0
          ? { ...c, col: c.col - 1 }
          : c.row > 0
            ? { row: c.row - 1, col: lines[c.row - 1]?.length ?? 0 }
            : c,
      );
      return;
    }
    if (key.rightArrow) {
      setCursor((c) =>
        c.col < (lines[c.row]?.length ?? 0)
          ? { ...c, col: c.col + 1 }
          : c.row < lines.length - 1
            ? { row: c.row + 1, col: 0 }
            : c,
      );
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c.row > 0 ? { row: c.row - 1, col: clampCol(c.row - 1, c.col) } : c));
      return;
    }
    if (key.downArrow) {
      setCursor((c) =>
        c.row < lines.length - 1 ? { row: c.row + 1, col: clampCol(c.row + 1, c.col) } : c,
      );
      return;
    }
    if (key.backspace || key.delete) {
      backspace();
      return;
    }
    if (input && !key.ctrl && !key.meta) insert(input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      {lines.map((line, i) => {
        if (i !== cursor.row) {
          return <Text key={i}>{line.length === 0 ? ' ' : line}</Text>;
        }
        const at = line[cursor.col] ?? ' ';
        return (
          <Text key={i}>
            {line.slice(0, cursor.col)}
            <Text inverse>{at}</Text>
            {line.slice(cursor.col + 1)}
          </Text>
        );
      })}
      <Text dimColor>enter saves · ctrl+n new line · ←→↑↓ move · esc backs up</Text>
    </Box>
  );
}
