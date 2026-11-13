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

test('later duplicate key wins model routing while menu order stays stable', () => {
  const ctx = vm.createContext({
    Map, Set,
    state: {},
    modelFamily: () => 'gpt',
    prettyModelName: id => id,
    isImageModel: id => /image/i.test(id),
  });
  vm.runInContext(section('function getAllModels(cfg){', 'function setChatModel'), ctx);
  const models = ctx.getAllModels({ keys: [
    { id: 'top', key: 'top-key', models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-4.1' }] },
    { id: 'bottom', key: 'bottom-key', models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-image-2' }] },
  ] });
  assert.deepEqual(Array.from(models, m => m.model), ['gpt-6.1-sol', 'gpt-4.1', 'gpt-image-2']);
  assert.equal(models[0].keyId, 'bottom');
  assert.equal(models[1].keyId, 'top');
  assert.equal(ctx.findModel('top::gpt-6.1-sol', models).keyId, 'bottom');
});
