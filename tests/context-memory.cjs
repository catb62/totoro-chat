// Run with: node --test tests/context-memory.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function section(start, end) {
  const i = source.indexOf(start), j = source.indexOf(end, i + start.length);
  assert(i >= 0 && j > i, start);
  return source.slice(i, j);
}
function fixture(general = {}) {
  const ctx = vm.createContext({
    Map, WeakMap, Set, console, t: (key, ...a) => [key, ...a].join('|'),
    state: { general: { contextTokenBudget: '250000', ...general }, chats: [] },
    lastN: messages => messages.filter(m => m.role !== 'divider'),
    imageToolAvailable: () => false, IMAGE_TOOL: { name: 'generate_image' },
  });
  for (const [start, end] of [
    ['function optNum(', '/* Temperature: empty'],
    ['function effectiveSystemPrompt(', '/* -------- Memory viewer'],
    ['/* Token estimate, fitted on the o200k tokenizer', '/* Attachments in a request.'],
    ['/* Attachments in a request.', '/* ------------------------- UI wiring'],
    ['/* -------- Context accounting --------', '/* -------- Context ring (composer) --------'],
  ]) vm.runInContext(section(start, end), ctx);
  return ctx;
}
const text = (n, tag = 'x') => `${tag}: The parser reads each log line, splits fields by spaces and aggregates latency per endpoint. `.repeat(n);

test('the estimate stays within 15% of the real tokenizer on code-like and prose text', () => {
  const ctx = fixture();
  // Reference counts from the o200k tokenizer (what gpt-5.x / gpt-6 report).
  const json = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, path: '/v1/chat/completions', status: 200, latency_ms: 120 + i * 7, model: 'gpt-6-luna', ok: true })));
  const log = Array.from({ length: 80 }, (_, i) => `2026-10-12T09:42:${String(i % 60).padStart(2, '0')}.${String(i * 37 % 1000).padStart(3, '0')}Z INFO req_id=9f${i.toString(16).padStart(4, '0')} status=200 latency_ms=${i * 13 % 900} tokens_in=${i * 1234} path=/v1/chat/completions`).join('\n');
  const zh = '对话接近上下文上限时，较早的部分会自动整理成记忆，最近的内容保留原文。这样模型既记得之前的要点，又不会因为上下文太长而变慢或出错。'.repeat(20);
  const en = 'When the conversation gets close to the limit, earlier turns are summarized into memory, so the model keeps the key facts without re-reading every message. '.repeat(20);
  for (const [name, s, real] of [['json', json, 2821], ['log', log, 3518], ['zh', zh, 1040], ['en', en, 581]]) {
    const est = ctx.estimateTokens(s);
    assert(Math.abs(est / real - 1) < 0.15, `${name}: ${est} vs ${real}`);
  }
});

test('the window skips error / empty replies and anything before the last divider', () => {
  const ctx = fixture();
  const chat = { messages: [
    { role: 'user', content: 'old' }, { role: 'divider', memory: true },
    { role: 'user', content: '', attachments: [{ kind: 'image', blobId: 'a' }] },
    { role: 'assistant', content: 'failed', error: true },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'ok' },
  ] };
  assert.deepEqual(Array.from(ctx.windowMessages(chat), m => m.content), ['', 'ok']);
});

test('real usage calibrates the ratio; small requests and outliers do not', () => {
  const ctx = fixture(), chat = {};
  ctx.recordUsage(chat, { input: 1500, est: 1000 }, 'm');
  assert.equal(ctx.tokenRatio(chat), 1);
  assert.equal(chat.tokenCal.input, 1500);
  ctx.recordUsage(chat, { input: 6000, cached: 5000, est: 4000 }, 'm');
  assert.equal(ctx.tokenRatio(chat), 1.5);
  assert.equal(chat.tokenCal.cached, 5000);
  ctx.recordUsage(chat, { input: 90000, est: 4000 }, 'm');
  assert.equal(ctx.tokenRatio(chat), 2.5);
  const c2 = { messages: [{ role: 'user', content: text(40) }], tokenCal: { ratio: 1.5 } };
  assert.equal(ctx.contextTokens(c2), Math.round((ctx.estimateTokens(text(40)) + 8) * 1.5));
  // The image tool's schema is part of every request that offers it.
  ctx.imageToolAvailable = () => true;
  assert.equal(ctx.contextTokens(c2), Math.round((ctx.estimateTokens(text(40)) + 8 + ctx.estimateTokens(JSON.stringify(ctx.IMAGE_TOOL))) * 1.5));
});

test('compression folds the oldest part and keeps the newest ~20%, starting at a user turn', () => {
  const ctx = fixture();
  const messages = [];
  for (let i = 0; i < 10; i++) messages.push({ role: 'user', content: text(20, 'u' + i) }, { role: 'assistant', content: text(10, 'a' + i) });
  const chat = { messages };
  const plan = ctx.compressionPlan(chat, 20);
  assert(plan.keptTokens <= plan.total * 0.2 + 1, `${plan.keptTokens} / ${plan.total}`);
  assert(plan.keptTokens >= plan.total * 0.1);
  assert.equal(plan.win[plan.start].role, 'user');
  assert.equal(plan.fold.length + (plan.win.length - plan.start), plan.win.length);
  assert(plan.fold.includes(messages[0]) && !plan.fold.includes(messages.at(-2)));
});

test('the current turn is always kept, so a huge last message leaves little to fold', () => {
  const ctx = fixture();
  const chat = { messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
    { role: 'user', content: text(400, 'paste') }, { role: 'assistant', content: 'ok' },
  ] };
  const plan = ctx.compressionPlan(chat, 20);
  assert.equal(plan.start, 2);
  assert(plan.foldTokens < plan.total * 0.1);
  // One turn later the paste is no longer the current turn: it is folded, its end carried.
  chat.messages.push({ role: 'user', content: 'what is slow?' }, { role: 'assistant', content: 'regex' });
  const next = ctx.compressionPlan(chat, 20);
  assert.equal(next.fold.length, 3);
  assert.equal(next.carry.role, 'user');
});

test('a long message right before the kept part is folded, but its end stays word for word', () => {
  const ctx = fixture();
  const paste = 'HEAD\n' + text(400, 'paste') + '\nTAIL-LINE';
  const chat = { messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
    { role: 'user', content: paste }, { role: 'assistant', content: 'ok, the regex is slow' },
    { role: 'user', content: 'what is slow?' }, { role: 'assistant', content: 'regex' },
  ] };
  const plan = ctx.compressionPlan(chat, 20);
  assert.equal(plan.start, 3);                        // the reply to the paste stays
  assert.equal(plan.fold.length, 3);                  // the paste itself goes to memory
  assert.equal(plan.carry.role, 'user');
  assert(paste.endsWith(plan.carry.text) && plan.carry.text.endsWith('TAIL-LINE') && !plan.carry.text.includes('HEAD'));
  assert(plan.keptTokens <= plan.total * 0.2 + 1 && plan.keptTokens >= plan.total * 0.15, `${plan.keptTokens} / ${plan.total}`);
  // After the fold the window opens with the carried end, then the kept turns.
  chat.messages.splice(3, 0, { role: 'divider', memory: true, carry: plan.carry });
  const win = ctx.windowMessages(chat);
  assert.deepEqual(Array.from(win, m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert(win[0].carried && win[0].content.startsWith('[The beginning of this message') && win[0].content.endsWith('TAIL-LINE'));
  assert.equal(ctx.windowMessages(chat)[0], win[0]);  // built once per divider (token counts stay cached)
  // A plain ✂ divider carries nothing.
  chat.messages[3] = { role: 'divider', carry: plan.carry };
  assert.equal(ctx.windowMessages(chat).length, 3);
});

test('a long reply is carried after a short note, so the window still opens with a user turn', () => {
  const ctx = fixture();
  const chat = { messages: [
    { role: 'user', content: 'explain the parser' }, { role: 'assistant', content: text(400, 'reply') + ' END' },
    { role: 'user', content: 'and the cache?' }, { role: 'assistant', content: 'it is cold' },
  ] };
  const plan = ctx.compressionPlan(chat, 20);
  assert.equal(plan.start, 2);
  assert.equal(plan.carry.role, 'assistant');
  chat.messages.splice(2, 0, { role: 'divider', memory: true, carry: plan.carry });
  const win = ctx.windowMessages(chat);
  assert.deepEqual(Array.from(win, m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert(win[0].content.startsWith('[Earlier turns') && win[1].content.endsWith('END'));
});

test('little room left: no carry, and the kept part still starts at a user turn', () => {
  const ctx = fixture();
  const chat = { messages: [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: text(400, 'long') },
    { role: 'user', content: text(60, 'q2') }, { role: 'assistant', content: text(40, 'a2') },
  ] };
  const plan = ctx.compressionPlan(chat, 20);
  assert.equal(plan.carry, null);
  assert.equal(plan.win[plan.start].role, 'user');
});

test('the old carry is folded whole with newer turns, never summarized on its own', () => {
  const ctx = fixture();
  const chat = { messages: [
    { role: 'user', content: 'old' }, { role: 'divider', memory: true, carry: { role: 'user', text: text(60, 'carried') } },
    { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
  ] };
  assert.equal(ctx.compressionPlan(chat, 20).fold.length, 0);
  for (let i = 0; i < 6; i++) chat.messages.push({ role: 'user', content: text(20, 'u' + i) }, { role: 'assistant', content: text(10, 'a' + i) });
  const plan = ctx.compressionPlan(chat, 20);
  assert(plan.fold[0].carried && plan.fold.some(m => !m.carried) && !plan.win[plan.start].carried);
});

test('the summarizer input is capped: long turns keep head and tail, short turns stay whole', () => {
  const ctx = fixture();
  const msgs = [
    { role: 'user', content: 'short question' },
    { role: 'user', content: 'HEAD ' + text(800, 'mid') + ' TAIL' },
    { role: 'assistant', content: 'short answer' },
  ];
  const dump = ctx.memoryDump(msgs, 1, 5000);
  assert(dump.includes('User: short question') && dump.includes('Assistant: short answer'));
  assert(dump.includes('HEAD') && dump.includes('TAIL') && dump.includes('tokens omitted'));
  assert(ctx.estimateTokens(dump) < 5600, String(ctx.estimateTokens(dump)));
});

test('documents attached to the folded turns go to the summarizer, images as a marker', () => {
  const ctx = fixture();
  const m = { role: 'user', content: 'see file', attachments: [{ kind: 'file', name: 'a.log', text: 'ERROR x' }, { kind: 'image', blobId: 'i' }] };
  assert.equal(ctx.memoryDumpText(m), 'see file\n\n[file: a.log]\nERROR x\n\n[image]');
});

test('documents always go with their message; only the newest images (max 50) are sent', () => {
  const ctx = fixture();
  const img = (i) => ({ kind: 'image', blobId: 'b' + i });
  const messages = [];
  for (let i = 0; i < 30; i++) messages.push({ role: 'user', content: 'q' + i, attachments: [{ kind: 'file', name: i + '.txt', text: text(5, 'doc' + i) }, img(2 * i), img(2 * i + 1)] }, { role: 'assistant', content: 'a' + i });
  const images = ctx.sentImageSet(messages);
  assert.equal(images.size, 50);
  assert(images.has(messages[58].attachments[2]) && !images.has(messages[0].attachments[1]) && !images.has(messages[8].attachments[2]) && images.has(messages[10].attachments[1]));
  // The oldest message still sends its document, just not its images.
  assert.deepEqual(Array.from(ctx.sentAttachments(messages[0], images), a => a.kind), ['file']);
  assert.equal(ctx.sentAttachments(messages[58], images).length, 3);
  // Token accounting follows: every document, 50 images.
  const docs = messages.filter(m => m.role === 'user').reduce((n, m) => n + ctx.estimateTokens(m.attachments[0].text), 0);
  const body = messages.reduce((n, m) => n + ctx.estimateTokens(m.content) + 8, 0);
  assert.equal(ctx.contextTokens({ messages }), body + docs + 50 * 1200);
  // A lower setting sends fewer; the cap stays at 50; nonsense falls back to 50.
  assert.equal(fixture({ imageKeepRecent: 5 }).sentImageSet(messages).size, 5);
  for (const v of [80, 0, -3, 'x', undefined]) assert.equal(fixture({ imageKeepRecent: v }).imageKeepRecent(), 50, String(v));
});

test('settings stay in range and "keep" stays 10 points under "summarize at"', () => {
  assert.equal(fixture({}).memoryTriggerPct(), 80);
  assert.equal(fixture({}).memoryKeepPct(), 20);
  assert.equal(fixture({ memoryTriggerPct: 99 }).memoryTriggerPct(), 95);
  assert.equal(fixture({ memoryTriggerPct: 10 }).memoryTriggerPct(), 50);
  assert.equal(fixture({ memoryTriggerPct: 60, memoryKeepPct: 55 }).memoryKeepPct(), 50);
  assert.equal(fixture({ memoryTriggerPct: 55, memoryKeepPct: 50 }).memoryKeepPct(), 45);
  assert.equal(fixture({ contextTokenBudget: '' }).contextBudget(), 250000);
});

test('token counts read like the ring shows them', () => {
  const ctx = fixture();
  assert.deepEqual([999, 1500, 9999, 77000, 828000, 1250000].map(ctx.fmtTokens), ['999', '1.5k', '10k', '77k', '828k', '1.25M']);
});
