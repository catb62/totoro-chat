// Run with: node --test tests/masked-planning.cjs
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
function fixture() {
  const urls = new Map();
  const ctx = vm.createContext({
    Blob, FormData, Map, t: key => key,
    state: { general: {} },
    lastN: messages => messages,
    computeAttachmentAllowSet: messages => new Set(messages.filter(m => m.attachments?.length)),
    effectiveSystemPrompt: chat => chat.systemPrompt,
    attDataUrl: rec => rec.dataUrl || urls.get(rec.blobId) || '',
    blobDataUrl: async id => urls.set(id, 'data:image/png;base64,' + id),
    optNum: () => null, userTemp: () => null,
    IMAGE_TOOL: { name: 'generate_image' }, readSSE: async () => {},
  });
  for (const [start, end] of [
    ['function chatImageIndex(chat){', '/* Tool the chat model'],
    ['function imageNote(', 'function safeJson('],
    ['function buildClaudeMessages(', 'async function callClaude('],
    ['async function callGemini(', '/* Tool results in each protocol'],
    ['function maskedEditPrompt(', 'async function storeGeneratedImage('],
  ]) vm.runInContext(section(start, end), ctx);
  ctx.maskedSelectionPreview = async rec => 'data:image/png;base64,preview-' + rec.maskBlobId;
  const old = { kind: 'image', blobId: 'old', maskBlobId: 'old-mask' };
  const current = { kind: 'image', blobId: 'current', maskBlobId: 'current-mask' };
  const plain = { kind: 'image', blobId: 'plain' };
  const chat = { systemPrompt: '用户设置\n长期记忆', messages: [
    { role: 'user', content: '之前的修改', attachments: [old] },
    { role: 'assistant', content: '已修改', images: [{ kind: 'image', blobId: 'current' }] },
    { role: 'user', content: '改成暹罗猫', attachments: [plain, current] },
    { role: 'assistant', content: '' },
  ] };
  return { ctx, chat, old, current, plain };
}
test('current selection is request-only, paired with its original and keeps its ID', async () => {
  const { ctx, chat, old, current } = fixture();
  const before = JSON.stringify(chat), index = ctx.chatImageIndex(chat);
  await ctx.hydrateRequestImages(chat, index);
  assert.equal(index.previews.size, 1);
  assert(!index.previews.has(old));
  assert.equal(index.byRec.get(current), 'img4');
  assert.equal(index.list.length, 4);
  assert.equal(JSON.stringify(chat), before);
  const parts = ctx.imageParts([current], index);
  assert.deepEqual(Array.from(parts, p => p.b64), ['current', 'preview-current-mask']);
  assert(parts.every(p => p.img === current));
});
test('OpenAI and Claude get the same original/preview pair with explicit guidance', async () => {
  const { ctx, chat } = fixture(), index = ctx.chatImageIndex(chat);
  await ctx.hydrateRequestImages(chat, index);
  const openai = ctx.buildOpenAIMessages(chat, index);
  assert.equal(openai[0].content, chat.systemPrompt);
  const user = openai.at(-1).content;
  assert.match(user[0].text, /改成暹罗猫/);
  assert.match(user[0].text, /当前局部编辑对象：img4/);
  assert.match(user[0].text, /没有独立图片 ID/);
  assert.deepEqual(Array.from(user.slice(1), p => p.image_url.url.split(',')[1]), ['plain', 'current', 'preview-current-mask']);
  const claude = ctx.buildClaudeMessages(chat, index).at(-1).content;
  assert.deepEqual(Array.from(claude.filter(p => p.type === 'image'), p => p.source.data), ['plain', 'current', 'preview-current-mask']);
  assert.match(claude.at(-1).text, /紫色区域表示修改范围/);
});
test('Gemini gets the same pair and preserves the system prompt', async () => {
  const { ctx, chat } = fixture(), index = ctx.chatImageIndex(chat);
  await ctx.hydrateRequestImages(chat, index);
  let sent;
  ctx.postWithDegrade = async (url, headers, body) => { sent = body; return {}; };
  await ctx.callGemini({ base: 'https://example.invalid', key: 'test', model: 'gemini', chat, imgIndex: index });
  assert.equal(sent.systemInstruction.parts[0].text, chat.systemPrompt);
  assert.deepEqual(Array.from(sent.contents.at(-1).parts.filter(p => p.inlineData), p => p.inlineData.data), ['plain', 'current', 'preview-current-mask']);
});
test('ordinary chat without image tools sends originals only', async () => {
  const { ctx, chat } = fixture();
  ctx.maskedSelectionPreview = () => { throw new Error('unexpected preview'); };
  await ctx.hydrateRequestImages(chat);
  const content = ctx.buildOpenAIMessages(chat).at(-1).content;
  assert.equal(content.filter(p => p.type === 'image_url').length, 2);
});
test('an old selection does not become the current edit on a later text turn', async () => {
  const { ctx, chat } = fixture();
  chat.messages.push({ role: 'user', content: '画一座山', attachments: [] });
  const index = ctx.chatImageIndex(chat);
  await ctx.hydrateRequestImages(chat, index);
  assert.equal(index.previews.size, 0);
});
test('a missing mask stops planning instead of claiming a selection was provided', async () => {
  const { ctx, current } = fixture();
  vm.runInContext(section('async function maskedSelectionPreview(', '/* Load the image attachments'), ctx);
  ctx.recordBlob = async () => new Blob(['original']);
  ctx.getBlob = async () => null;
  await assert.rejects(ctx.maskedSelectionPreview(current), /img.err.missing/);
});
test('preview preparation releases its decoded original when mask decoding fails', async () => {
  const { ctx, current } = fixture();
  vm.runInContext(section('async function maskedSelectionPreview(', '/* Load the image attachments'), ctx);
  let closed = false, decoded = 0;
  ctx.recordBlob = ctx.getBlob = async () => new Blob(['png']);
  ctx.createImageBitmap = async () => {
    if(++decoded === 2) throw new Error('invalid mask');
    return { close() { closed = true; } };
  };
  await assert.rejects(ctx.maskedSelectionPreview(current), /invalid mask/);
  assert(closed);
});
test('edited-image request uses original bytes and raw mask, never the preview', async () => {
  const { ctx, current } = fixture();
  const original = new Blob(['original-png'], { type: 'image/png' });
  const mask = new Blob(['raw-mask-png'], { type: 'image/png' });
  let sent;
  Object.assign(ctx, {
    IMAGE_SIZES: ['auto'], IMAGE_QUALITIES: ['auto'], imageExt: () => 'png',
    recordBlob: async rec => { assert.equal(rec, current); return original; },
    getBlob: async id => { assert.equal(id, 'current-mask'); return mask; },
    fetch: async (url, options) => { assert(url.endsWith('/v1/images/edits')); sent = options.body; return { ok: true }; },
    readImagesResponse: async () => [{ blob: original }],
  });
  await ctx.generateImages({ target: { base: 'https://example.invalid', key: 'test', model: 'image' }, prompt: '改成暹罗猫', refs: [{ rec: current }], size: 'auto', quality: 'auto' });
  assert.equal(await sent.get('image').text(), 'original-png');
  assert.equal(await sent.get('mask').text(), 'raw-mask-png');
  assert.match(sent.get('prompt'), /原始遮罩是本次修改范围的依据/);
  assert.match(sent.get('prompt'), /不要为了.*品种/);
  assert(!sent.get('prompt').includes('紫色'));
  assert.equal(sent.has('stream'), false);
});
test('new generation keeps its prompt and English masked edits retain scope', async () => {
  const { ctx } = fixture();
  let sent;
  Object.assign(ctx, {
    IMAGE_SIZES: ['auto'], IMAGE_QUALITIES: ['auto'],
    fetch: async (url, options) => { assert(url.endsWith('/v1/images/generations')); sent = JSON.parse(options.body); return { ok: true }; },
    readImagesResponse: async () => [{ url: 'https://example.invalid/result' }],
  });
  await ctx.generateImages({ target: { base: 'https://example.invalid', key: 'test', model: 'image' }, prompt: 'Draw a mountain', refs: [], size: 'auto', quality: 'auto' });
  assert.equal(sent.prompt, 'Draw a mountain');
  assert.match(ctx.maskedEditPrompt('Make it blue'), /original mask defines the scope/);
  assert.match(ctx.maskedEditPrompt('Make it blue'), /Do not change unmasked areas/);
});
