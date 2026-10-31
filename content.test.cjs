const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup({ wrongRow = false, clickError = false, stays = false } = {}) {
  let now = 0;
  let opened = 0;
  let clicked = 0;
  const timers = [];
  const classes = new Set();
  const button = { title: 'Remove', dataset: {}, setAttribute() {}, getAttribute() {} };
  const row = { data: { setVideoId: 'target' }, isConnected: true,
    querySelector: () => ({ click() { opened++; } }) };
  const item = {
    textContent: 'Remove from Watch later',
    getAttribute() { return ''; },
    getClientRects() { return [1]; },
    data: { serviceEndpoint: { playlistEditEndpoint: { playlistId: 'WL',
      actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: wrongRow ? 'other' : 'target' }] } } },
    click() { clicked++; if (clickError) throw Error('failed'); if (!stays) row.isConnected = false; },
  };
  const context = vm.createContext({
    document: {
      querySelector: () => ({}), // YouTube no longer exposes app.resolveCommand.
      querySelectorAll: selector => selector.includes('service-item') && opened ? [item] : [],
      documentElement: { classList: { add: x => classes.add(x), remove: x => classes.delete(x) } },
      dispatchEvent() {},
    },
    KeyboardEvent: class {}, performance: { now: () => now },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
    location: { pathname: '/playlist', search: '?list=WL' }, URLSearchParams,
  });
  let source = fs.readFileSync(__dirname + '/content.js', 'utf8');
  source = source.slice(0, source.lastIndexOf('  refresh();')) +
    '  globalThis.removeViaYouTube = removeViaYouTube;\n})();';
  vm.runInContext(source, context);
  return { button, row, classes, counts: () => ({ opened, clicked }),
    async remove() {
      const promise = context.removeViaYouTube(row, button);
      for (let i = 0; i < 200; i++) {
        await Promise.resolve();
        const timer = timers.shift();
        if (timer) { now += timer.ms; timer.fn(); }
      }
      await promise;
    },
  };
}

test('removes through the native menu when resolveCommand is absent', async () => {
  const s = setup(); await s.remove();
  assert.deepEqual(s.counts(), { opened: 1, clicked: 1 });
  assert.equal(s.row.isConnected, false);
  assert.equal(s.classes.size, 0);
  assert.equal(s.button.disabled, false);
});

test('does not click a stale menu belonging to another row', async () => {
  const s = setup({ wrongRow: true }); await s.remove();
  assert.equal(s.counts().clicked, 0);
  assert.equal(s.row.isConnected, true);
  assert.equal(s.classes.size, 0);
  assert.equal(s.button.disabled, false);
});

test('restores UI after a native menu error or unconfirmed deletion', async () => {
  for (const options of [{ clickError: true }, { stays: true }]) {
    const s = setup(options); await s.remove();
    assert.equal(s.row.isConnected, true);
    assert.equal(s.classes.size, 0);
    assert.equal(s.button.disabled, false);
  }
});
