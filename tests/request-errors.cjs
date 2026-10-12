// Run with: node --test tests/request-errors.cjs
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
const ctx = vm.createContext({ t: (key) => key });
vm.runInContext(section('function isRetryableLLM(', 'async function streamResponse('), ctx);
vm.runInContext(section('/* A safety check refused the request', '/* Wording endpoints use'), ctx);
// What httpError builds from a non-2xx response.
const http = (status, error) => Object.assign(new Error(`${status} · ${error.message}`), { status, detail: error.message, body: JSON.stringify({ error }) });
const BIO = 'This content was flagged for possible biological risk. If this seems wrong, try rephrasing your request. We are continuously refining our work in detecting biological risk, and you can read more about our approach in our blog post: https://openai.com/index/preparing-for-future-ai-capabilities-in-biology';

test("the gateway's own content review: its message plus a rephrase hint, no retry", () => {
  for (const err of [
    http(403, { type: 'content_policy_violation', message: '内容审计命中风险规则，请调整输入后重试' }),
    http(403, { type: 'content_policy_violation', message: 'custom admin text' }),
    http(403, { type: 'prompt_guard_blocked', message: '提示词安全审计拒绝了该请求，请调整输入后重试' }),
  ]) {
    assert.equal(ctx.contentBlockKind(err), 'gateway', err.message);
    assert.equal(ctx.errorHint(err), 'msg.error.moderated');
    assert.equal(ctx.isRetryableLLM(err), false);
  }
});

test("the provider's safety filter: shown as is, explained, never retried", () => {
  for (const err of [
    http(502, { type: 'upstream_error', message: BIO }),                       // after a long think (gpt-6.1-sol)
    new Error(BIO),                                                            // the same, inside a started stream
    http(400, { type: 'invalid_request_error', code: 'invalid_prompt', message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.' }),
    http(400, { type: 'invalid_request_error', code: 'content_policy_violation', message: 'Your request was rejected as a result of our safety system.' }),
    new Error('Request blocked by upstream cyber-security policy'),
  ]) {
    assert.equal(ctx.contentBlockKind(err), 'provider', err.message);
    assert.equal(ctx.errorHint(err), 'msg.error.safety');
    assert.equal(ctx.isRetryableLLM(err), false);
  }
});

test('ordinary errors are not mistaken for a block', () => {
  const busy = http(502, { type: 'upstream_error', message: 'Upstream request failed' });
  assert.equal(ctx.contentBlockKind(busy), '');
  assert.equal(ctx.isRetryableLLM(busy), true);
  const guardDown = http(503, { type: 'api_error', code: 'prompt_guard_unavailable', message: '提示词安全审计暂时不可用，请稍后重试' });
  assert.equal(ctx.contentBlockKind(guardDown), '');
  assert.equal(ctx.isRetryableLLM(guardDown), true);
  const group = http(403, { type: 'permission_error', message: 'This group does not allow this model' });
  assert.equal(ctx.contentBlockKind(group), '');
  assert.equal(ctx.errorHint(group), 'msg.error.forbidden');
  const auth = http(401, { type: 'invalid_request_error', message: 'Your account was flagged and deactivated' });
  assert.equal(ctx.contentBlockKind(auth), '');
  assert.equal(ctx.errorHint(auth), 'msg.error.auth');
});

test('no first token for minutes is reported, not retried; a stalled stream is retried', () => {
  const connect = Object.assign(new Error('x'), { name: 'TimeoutError', phase: 'connect' });
  const stall = Object.assign(new Error('x'), { name: 'TimeoutError', phase: 'stall' });
  assert.equal(ctx.isRetryableLLM(connect), false);
  assert.equal(ctx.errorHint(connect), 'msg.error.timeoutConnectHint');
  assert.equal(ctx.isRetryableLLM(stall), true);
  assert.equal(ctx.errorHint(stall), 'msg.error.timeoutHint');
});
