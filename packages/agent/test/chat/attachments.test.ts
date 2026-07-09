import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { createLlm, makeDecisionRecorder, makeModelResolver } from '../../src/llm/index.js';
import { SdkLlmClient, buildChatPrompt, type QueryFn, type SdkMessageLike, type SdkUserMessageLike } from '../../src/llm/sdk.js';
import { createMemory } from '../../src/memory/index.js';
import { createChat } from '../../src/chat/index.js';
import { parseHeartbeat } from '../../src/config/parse.js';

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-att-test-'));
  tmpDirs.push(attachmentsDir);
  const db = new Db(':memory:');
  const bus = createBus();
  const llm = await createLlm({ env: { mockLlm: true }, db, bus });
  const config = {
    persona: () => '# PERSONA\nYou are botty.',
    heartbeat: () => parseHeartbeat('', 'sim'),
  };
  const memory = createMemory({ db, config });
  const chat = createChat({ db, bus, llm, memory, attachmentsDir });
  return { db, chat, attachmentsDir };
}

describe('chat service: attachments', () => {
  it('persists attachment binaries to disk and small meta refs on the turn row', async () => {
    const { db, chat, attachmentsDir } = await setup();
    const { done } = await chat.handleUserMessage('look at these', {
      attachments: [
        { mimeType: 'image/png', dataBase64: PNG_B64, name: 'pixel.png' },
        { mimeType: 'image/jpeg', dataBase64: PNG_B64 },
      ],
    });
    await done;

    const session = db.activeSession()!;
    const userTurn = db.turnsForSession(session.id).find((t) => t.role === 'user')!;
    expect(userTurn.content).toBe('look at these'); // no base64 in the row
    const meta = userTurn.meta as {
      attachments: { id: string; mimeType: string; name?: string; ref: string }[];
    };
    expect(meta.attachments).toHaveLength(2);
    expect(meta.attachments[0]).toMatchObject({
      mimeType: 'image/png',
      name: 'pixel.png',
      ref: `/api/chat/attachments/${meta.attachments[0]!.id}`,
    });
    expect(meta.attachments[1]!.name).toBeUndefined();
    // meta stays small — the binary never lands in the turn row
    expect(JSON.stringify(meta).length).toBeLessThan(500);

    // files on disk, correct extension per mime type, correct bytes
    const files = fs.readdirSync(attachmentsDir).sort();
    expect(files).toContain(`${meta.attachments[0]!.id}.png`);
    expect(files).toContain(`${meta.attachments[1]!.id}.jpg`);
    const bytes = fs.readFileSync(path.join(attachmentsDir, `${meta.attachments[0]!.id}.png`));
    expect(bytes.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });

  it('mock chatTurn receives attachments and acknowledges them', async () => {
    const { chat } = await setup();
    const { done } = await chat.handleUserMessage('what do you see?', {
      attachments: [
        { mimeType: 'image/png', dataBase64: PNG_B64 },
        { mimeType: 'image/png', dataBase64: PNG_B64 },
      ],
    });
    const turn = await done;
    expect(turn!.content).toBe('[mock] (2 images) what do you see?');
  });

  it('getAttachment resolves stored files and rejects unknown/malformed ids', async () => {
    const { db, chat } = await setup();
    await (
      await chat.handleUserMessage('img', {
        attachments: [{ mimeType: 'image/webp', dataBase64: PNG_B64 }],
      })
    ).done;
    const userTurn = db.chatHistory().find((t) => t.role === 'user')!;
    const { id } = (userTurn.meta as { attachments: { id: string }[] }).attachments[0]!;

    const att = chat.getAttachment(id)!;
    expect(att.mimeType).toBe('image/webp');
    expect(fs.existsSync(att.filePath)).toBe(true);

    expect(chat.getAttachment('does-not-exist')).toBeNull();
    expect(chat.getAttachment('../../etc/passwd')).toBeNull();
  });
});

describe('chat service: quoted replies', () => {
  it('stores quotedTurnId + clipped quotedPreview and prepends the reply block to the prompt', async () => {
    const { db, chat } = await setup();
    const longText = 'quoted message '.repeat(30).trim(); // > 300 chars
    await (await chat.handleUserMessage(longText)).done;
    const quotedTurn = db.chatHistory().find((t) => t.role === 'user')!;

    const { done } = await chat.handleUserMessage('replying to that', {
      quotedTurnId: quotedTurn.id,
    });
    const assistant = await done;

    // Same-millisecond turns tiebreak on random ids in chatHistory — select the
    // reply by content, not position.
    const reply = db.chatHistory().find((t) => t.role === 'user' && t.content === 'replying to that')!;
    const meta = reply.meta as { quotedTurnId: string; quotedPreview: string };
    expect(meta.quotedTurnId).toBe(quotedTurn.id);
    expect(meta.quotedPreview).toBe(longText.slice(0, 160));

    // mock echoes the prompt → we can see exactly what the model was sent
    expect(assistant!.content).toBe(
      `[mock] [Replying to earlier message: "${longText.slice(0, 300)}"]\n\nreplying to that`,
    );
  });

  it('ignores unknown quotedTurnId (no meta, no prompt block)', async () => {
    const { db, chat } = await setup();
    const { done } = await chat.handleUserMessage('hello', { quotedTurnId: 'nope-no-such-turn' });
    const assistant = await done;
    expect(assistant!.content).toBe('[mock] hello');
    const userTurn = db.chatHistory().find((t) => t.role === 'user')!;
    expect(userTurn.meta).toBeNull();
  });
});

describe('SdkLlmClient: image content blocks', () => {
  function stubQueryFn(capture: { prompt: string | AsyncIterable<SdkUserMessageLike> }[]): QueryFn {
    return ({ prompt }) => {
      capture.push({ prompt });
      const messages: SdkMessageLike[] = [
        { type: 'system', subtype: 'init', session_id: 'prov-1' },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'prov-1',
          is_error: false,
          result: 'seen',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          yield* messages;
        },
      };
    };
  }

  it('buildChatPrompt keeps the plain-string path when there are no attachments', () => {
    const prompt = buildChatPrompt({
      sessionKey: 's1',
      prompt: 'no images',
      systemPrompt: 'sys',
      onEvent: () => {},
    });
    expect(prompt).toBe('no images');
  });

  it('sends [image..., text] blocks via an AsyncIterable user message when attachments exist', async () => {
    const capture: { prompt: string | AsyncIterable<SdkUserMessageLike> }[] = [];
    const db = new Db(':memory:');
    const bus = createBus();
    const client = new SdkLlmClient({
      queryFn: stubQueryFn(capture),
      db,
      modelFor: makeModelResolver(db),
      record: makeDecisionRecorder(db, bus),
    });

    const result = await client.chatTurn({
      sessionKey: 's1',
      prompt: 'what is this?',
      attachments: [{ mimeType: 'image/png', dataBase64: PNG_B64 }],
      systemPrompt: 'sys',
      onEvent: () => {},
    });
    expect(result.text).toBe('seen');

    expect(capture).toHaveLength(1);
    const sent = capture[0]!.prompt;
    expect(typeof sent).not.toBe('string');
    const messages: SdkUserMessageLike[] = [];
    for await (const m of sent as AsyncIterable<SdkUserMessageLike>) messages.push(m);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('user');
    expect(messages[0]!.parent_tool_use_id).toBeNull();
    expect(messages[0]!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
      { type: 'text', text: 'what is this?' },
    ]);

    // ai_decisions records mime types, never the base64 payload
    const rows = db.listAiDecisions({ kind: 'chat_turn' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputJson).not.toContain(PNG_B64);
    expect(JSON.parse(rows[0]!.inputJson)).toEqual({
      prompt: 'what is this?',
      attachments: ['image/png'],
    });
  });
});
