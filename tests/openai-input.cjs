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

test('OpenAI compatibility requests reject empty message bodies locally', () => {
  const ctx = vm.createContext({ String, Array });
  vm.runInContext(section('function hasUsableOpenAIMessage(messages){', 'async function callOpenAICompat'), ctx);
  assert.equal(ctx.hasUsableOpenAIMessage([]), false);
  assert.equal(ctx.hasUsableOpenAIMessage([{ role: 'system', content: 'rules' }]), false);
  assert.equal(ctx.hasUsableOpenAIMessage([{ role: 'user', content: 'draw a cat' }]), true);
  assert.equal(ctx.hasUsableOpenAIMessage([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }]), true);
});
