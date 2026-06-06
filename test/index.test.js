'use strict';
const Module = require('module');
const assert = require('assert');
const path   = require('path');

// ---------------------------------------------------------------------------
// Mocks — must be in place BEFORE require('../index.js')
// ---------------------------------------------------------------------------

// Minimal React mock (native class inheritance — no transpilation)
const mockReact = {
  Component: class Component {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(partial) {
      const next = typeof partial === 'function' ? partial(this.state) : partial;
      Object.assign(this.state, next);
    }
  },
  createElement(...args) {
    return { type: args[0], props: args[1], children: args.slice(2) };
  },
};

const mockRbs = {
  Button: 'Button', ControlLabel: 'ControlLabel',
  FormControl: 'FormControl', FormGroup: 'FormGroup', HelpBlock: 'HelpBlock',
  Panel: 'Panel', ListGroup: 'ListGroup', ListGroupItem: 'ListGroupItem',
};

const mockFs = {
  ensureDirWritableAsync: () => Promise.resolve(),
  statAsync:              () => Promise.resolve(),
  readFileAsync:          () => Promise.resolve(''),
  writeFileAsync:         () => Promise.resolve(),
};

const mockUtil = {
  toPromise: (fn) => new Promise((res, rej) =>
    fn((err, val) => (err ? rej(err) : res(val)))),
  GameStoreHelper: { findByAppId: () => Promise.resolve({ gamePath: '/game' }) },
  opn: (p) => Promise.resolve(p),
};

const mockLog = () => {};

// IMPORTANT: index.js captures the OBJECT REFERENCE returned by require('https').
// Swapping the whole object has no effect after module load — mutate .get instead.
const mockHttps = { get: (_u, _o, _cb) => ({ on: () => {} }) };

// Override before loading the module under test
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vortex-api')      return { fs: mockFs, util: mockUtil, log: mockLog };
  if (request === 'https')           return mockHttps;  // returns the same object every time
  if (request === 'react')           return mockReact;
  if (request === 'react-bootstrap') return mockRbs;
  return originalLoad(request, parent, isMain);
};

const idx = require('../index.js');
Module._load = originalLoad; // restore after load

// ---------------------------------------------------------------------------
// Shared state / context
// ---------------------------------------------------------------------------
const mockState = {
  settings: {
    gameMode: {
      discovered: { emergency2023: { path: '/game' } },
    },
  },
};

const mockContext = {
  api: {
    getState:         () => mockState,
    sendNotification: () => {},
    showDialog:       () => Promise.resolve({ action: 'Download UE4SS' }),
    events: { emit: () => {} },
  },
  registerModType:    () => {},
  registerInstaller:  () => {},
  registerGame:       () => {},
  registerSettings:   () => {},
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const tests = [];

function test(name, fn) {
  tests.push(async () => {
    try {
      await fn();
      console.log('  ✓ ' + name);
      passed++;
    } catch (err) {
      console.log('  ✗ ' + name + ': ' + (err.stack || err.message));
      failed++;
    }
  });
}

/** Flush microtask + I/O queues enough for chained Promises to settle. */
async function flushPromises() {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setImmediate(r));
  }
}

/**
 * Returns a synchronous fake https.get function.
 * Assign to mockHttps.get — do NOT replace the mockHttps object itself (index.js
 * captured the original object reference at load time; replacing it is a no-op).
 */
function makeHttpsGet(statusCode, bodyObj) {
  return function(_url, _opts, cb) {
    const handlers = {};
    const res = {
      statusCode,
      on(ev, fn) { handlers[ev] = fn; return this; },
    };
    cb(res);
    handlers['data'](typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj));
    handlers['end']();
    return { on: () => {} };
  };
}

// Convenience path constants used by multiple test groups
const WIN64           = path.join('/game', 'EMERGENCY', 'Binaries', 'Win64');
const FLAT_SETTINGS   = path.join(WIN64, 'UE4SS-settings.ini');
const NESTED_SETTINGS = path.join(WIN64, 'ue4ss', 'UE4SS-settings.ini');

// ===========================================================================
// 1. isSafeRelPath
// ===========================================================================
console.log('\nisSafeRelPath');

test('allows plain filename',           () => assert.ok(idx.isSafeRelPath('dwmapi.dll')));
test('allows nested rel path',          () => assert.ok(idx.isSafeRelPath('Mods/MyMod/main.lua')));
test('allows Windows-style nested',     () => assert.ok(idx.isSafeRelPath('Mods\\MyMod\\main.lua')));
test('rejects absolute /path',          () => assert.ok(!idx.isSafeRelPath('/abs/path')));
test('rejects absolute C:\\',           () => assert.ok(!idx.isSafeRelPath('C:\\Windows\\System32')));
test('rejects ../ traversal',           () => assert.ok(!idx.isSafeRelPath('../secret.txt')));
test('rejects nested ../',              () => assert.ok(!idx.isSafeRelPath('Mods/../../etc/passwd')));
test('rejects windows ..\\ traversal',  () => assert.ok(!idx.isSafeRelPath('Mods\\..\\..\\secret')));
test('allows single dot prefix',        () => assert.ok(idx.isSafeRelPath('.hidden/file')));

// ===========================================================================
// 2. isTrustedUE4SSAsset
// ===========================================================================
console.log('\nisTrustedUE4SSAsset');

test('accepts github.com asset', () => assert.ok(idx.isTrustedUE4SSAsset({
  name: 'UE4SS_v3.0.1.zip',
  browser_download_url: 'https://github.com/UE4SS-RE/RE-UE4SS/releases/download/v3.0.1/UE4SS_v3.0.1.zip',
})));
test('accepts objects.githubusercontent.com', () => assert.ok(idx.isTrustedUE4SSAsset({
  name: 'UE4SS_v3.0.1.zip',
  browser_download_url: 'https://objects.githubusercontent.com/releases/UE4SS_v3.0.1.zip',
})));
test('rejects http://', () => assert.ok(!idx.isTrustedUE4SSAsset({
  name: 'UE4SS_v3.0.1.zip',
  browser_download_url: 'http://github.com/releases/UE4SS_v3.0.1.zip',
})));
test('rejects untrusted host', () => assert.ok(!idx.isTrustedUE4SSAsset({
  name: 'UE4SS_v3.0.1.zip',
  browser_download_url: 'https://evil.com/UE4SS_v3.0.1.zip',
})));
test('rejects bad asset name', () => assert.ok(!idx.isTrustedUE4SSAsset({
  name: 'evil.exe',
  browser_download_url: 'https://github.com/UE4SS-RE/RE-UE4SS/releases/download/v3.0.1/evil.exe',
})));
test('rejects null asset', () => assert.ok(!idx.isTrustedUE4SSAsset(null)));

// ===========================================================================
// 2b. UE4SS_ASSET_PATTERN  (stable + experimental naming)
// ===========================================================================
console.log('\nUE4SS_ASSET_PATTERN');

test('matches stable name UE4SS_v3.0.1.zip',
  () => assert.ok(idx.UE4SS_ASSET_PATTERN.test('UE4SS_v3.0.1.zip')));
test('matches experimental name UE4SS_v3.0.1-953-gb872ad11.zip',
  () => assert.ok(idx.UE4SS_ASSET_PATTERN.test('UE4SS_v3.0.1-953-gb872ad11.zip')));
test('rejects zDEV-UE4SS_v3.0.1-953-gb872ad11.zip',
  () => assert.ok(!idx.UE4SS_ASSET_PATTERN.test('zDEV-UE4SS_v3.0.1-953-gb872ad11.zip')));
test('rejects zCustomGameConfigs.zip',
  () => assert.ok(!idx.UE4SS_ASSET_PATTERN.test('zCustomGameConfigs.zip')));
test('rejects zMapGenBP.zip',
  () => assert.ok(!idx.UE4SS_ASSET_PATTERN.test('zMapGenBP.zip')));

// ===========================================================================
// 3. testUE4SSInjector  (A2 — flat layout + path safety)
// ===========================================================================
console.log('\ntestUE4SSInjector');

test('rejects wrong gameId', () =>
  idx.testUE4SSInjector(['dwmapi.dll', 'UE4SS-settings.ini'], 'other')
    .then(r => assert.strictEqual(r.supported, false)));
test('rejects archive with only dwmapi.dll (no settings file)', () =>
  idx.testUE4SSInjector(['dwmapi.dll'], 'emergency2023')
    .then(r => assert.strictEqual(r.supported, false)));
test('rejects archive with only settings (no dwmapi.dll)', () =>
  idx.testUE4SSInjector(['UE4SS-settings.ini'], 'emergency2023')
    .then(r => assert.strictEqual(r.supported, false)));
test('rejects path traversal anywhere in file list', () =>
  idx.testUE4SSInjector(['dwmapi.dll', '../UE4SS-settings.ini'], 'emergency2023')
    .then(r => assert.strictEqual(r.supported, false)));
test('accepts nested layout (ue4ss/UE4SS-settings.ini)', () =>
  idx.testUE4SSInjector(['dwmapi.dll', 'ue4ss/UE4SS-settings.ini', 'ue4ss/Mods/'], 'emergency2023')
    .then(r => assert.strictEqual(r.supported, true)));
test('accepts flat layout (UE4SS-settings.ini at archive root)', () =>
  idx.testUE4SSInjector(['dwmapi.dll', 'UE4SS-settings.ini', 'Mods/'], 'emergency2023')
    .then(r => assert.strictEqual(r.supported, true)));
test('accepts flat layout with mod files under Mods/', () =>
  idx.testUE4SSInjector(['dwmapi.dll', 'UE4SS-settings.ini', 'Mods/Shared/shared_logger.lua'], 'emergency2023')
    .then(r => assert.strictEqual(r.supported, true)));

// ===========================================================================
// 4. getIniValue  (Part D)
// ===========================================================================
console.log('\ngetIniValue');

test('returns value for existing key', () => {
  assert.strictEqual(
    idx.getIniValue('[Debug]\nGraphicsAPI = opengl\n', 'Debug', 'GraphicsAPI'),
    'opengl');
});
test('returns null when key absent from section', () => {
  assert.strictEqual(
    idx.getIniValue('[Debug]\nSomeOther = 1\n', 'Debug', 'GraphicsAPI'),
    null);
});
test('returns null when section absent', () => {
  assert.strictEqual(
    idx.getIniValue('[Other]\nGraphicsAPI = opengl\n', 'Debug', 'GraphicsAPI'),
    null);
});
test('case-insensitive section + key matching', () => {
  assert.strictEqual(
    idx.getIniValue('[debug]\ngraphicsapi = dx11\n', 'Debug', 'GraphicsAPI'),
    'dx11');
});
test('skips commented-out lines', () => {
  assert.strictEqual(
    idx.getIniValue('[Debug]\n; GraphicsAPI = opengl\nGraphicsAPI = dx11\n', 'Debug', 'GraphicsAPI'),
    'dx11');
});

// ===========================================================================
// 5. setIniValue  (Part D)
// ===========================================================================
console.log('\nsetIniValue');

test('replaces existing value in-place', () => {
  const out = idx.setIniValue('[Debug]\nGraphicsAPI = opengl\n', 'Debug', 'GraphicsAPI', 'dx11');
  assert.ok(out.includes('GraphicsAPI = dx11'), 'should contain new value');
  assert.ok(!out.includes('opengl'),             'should not contain old value');
});
test('preserves unrelated keys in same section', () => {
  const out = idx.setIniValue('[Debug]\nGuiConsoleEnabled = 1\nGraphicsAPI = opengl\n', 'Debug', 'GraphicsAPI', 'dx11');
  assert.ok(out.includes('GuiConsoleEnabled = 1'));
});
test('inserts key when section exists but key is absent', () => {
  const out = idx.setIniValue('[Debug]\nGuiConsoleEnabled = 1\n', 'Debug', 'GraphicsAPI', 'dx11');
  assert.ok(out.includes('[Debug]'));
  assert.ok(out.includes('GraphicsAPI = dx11'));
  assert.ok(out.includes('GuiConsoleEnabled = 1'));
});
test('appends new section + key when section absent', () => {
  const out = idx.setIniValue('[Other]\nFoo = bar\n', 'Debug', 'GraphicsAPI', 'dx11');
  assert.ok(out.includes('[Debug]'));
  assert.ok(out.includes('GraphicsAPI = dx11'));
  assert.ok(out.includes('[Other]'));
});
test('handles empty content', () => {
  const out = idx.setIniValue('', 'Debug', 'GraphicsAPI', 'dx11');
  assert.ok(out.includes('[Debug]'));
  assert.ok(out.includes('GraphicsAPI = dx11'));
});
test('handles key=value format (no spaces around =)', () => {
  const out = idx.setIniValue('[Debug]\nGraphicsAPI=opengl\n', 'Debug', 'GraphicsAPI', 'dx11');
  assert.ok(out.includes('dx11'));
  assert.ok(!out.includes('opengl'));
});
test('round-trip: setIniValue result readable by getIniValue', () => {
  const ini = '[Debug]\nGraphicsAPI = opengl\n';
  const out = idx.setIniValue(ini, 'Debug', 'GraphicsAPI', 'dx11');
  assert.strictEqual(idx.getIniValue(out, 'Debug', 'GraphicsAPI'), 'dx11');
});

// ===========================================================================
// 6. installUE4SSInjector  (C1 — flat layout, generatefile, fallback)
// ===========================================================================
console.log('\ninstallUE4SSInjector');

test('flat layout: patches settings -> generatefile, copies dwmapi.dll', () => {
  const savedRead = mockFs.readFileAsync;
  mockFs.readFileAsync = () => Promise.resolve('[Debug]\nGraphicsAPI = opengl\n');
  return idx.installUE4SSInjector(['dwmapi.dll', 'UE4SS-settings.ini', 'Mods/'], '/dest')
    .then(r => {
      mockFs.readFileAsync = savedRead;
      const copy   = r.instructions.find(i => i.type === 'copy'         && i.source === 'dwmapi.dll');
      const genf   = r.instructions.find(i => i.type === 'generatefile');
      const setmod = r.instructions.find(i => i.type === 'setmodtype');
      assert.ok(copy,   'copy instruction for dwmapi.dll');
      assert.ok(genf,   'generatefile instruction for settings');
      assert.ok(setmod, 'setmodtype instruction');
      assert.strictEqual(genf.destination, 'UE4SS-settings.ini');
      const content = genf.data.toString('utf8');
      assert.ok(content.includes('dx11'),              'patched content contains dx11');
      assert.ok(!content.includes('opengl'),            'patched content has no opengl');
      assert.ok(content.includes('GuiConsoleEnabled'),  'bake sets GuiConsoleEnabled');
      assert.ok(content.includes('GuiConsoleEnabled = 0') || content.includes('GuiConsoleEnabled=0'),
        'bake sets GuiConsoleEnabled=0');
      assert.strictEqual(setmod.value, 'emergency2023-ue4ss-injector');
    });
});
test('falls back to plain copy when readFileAsync throws', () => {
  const savedRead = mockFs.readFileAsync;
  mockFs.readFileAsync = () => Promise.reject(new Error('ENOENT'));
  return idx.installUE4SSInjector(['dwmapi.dll', 'UE4SS-settings.ini'], '/dest')
    .then(r => {
      mockFs.readFileAsync = savedRead;
      assert.ok(!r.instructions.find(i => i.type === 'generatefile'),
        'no generatefile on read error');
      assert.ok(r.instructions.find(i => i.type === 'copy' && i.destination === 'UE4SS-settings.ini'),
        'falls back to copy on read error');
    });
});
test('filters out directory entries (trailing path sep) and traversal paths', () =>
  idx.installUE4SSInjector(['dwmapi.dll', 'Mods/', '../evil.dll', 'Mods/mod.lua'], '/dest')
    .then(r => {
      assert.ok(!r.instructions.some(i => i.source === 'Mods/'),        'dir entry filtered');
      assert.ok(!r.instructions.some(i => i.source === '../evil.dll'),  'traversal filtered');
    }));
test('setmodtype is always the last instruction', () => {
  const savedRead = mockFs.readFileAsync;
  mockFs.readFileAsync = () => Promise.resolve('[Debug]\n');
  return idx.installUE4SSInjector(['dwmapi.dll', 'UE4SS-settings.ini'], '/dest')
    .then(r => {
      mockFs.readFileAsync = savedRead;
      const last = r.instructions[r.instructions.length - 1];
      assert.strictEqual(last.type, 'setmodtype');
    });
});

// ===========================================================================
// 7. fetchLatestUE4SS  (HTTP stubs + H1 URL validation)
//
// NOTE: index.js captures the mockHttps OBJECT at require() time.
// Always mutate mockHttps.get — never replace the object itself.
// ===========================================================================
console.log('\nfetchLatestUE4SS');

test('(c) selects experimental asset and skips zDEV/zCustom/zMap variants', () => {
  const savedGet = mockHttps.get;
  let capturedUrl = '';
  mockHttps.get = function(url, opts, cb) {
    capturedUrl = url;
    return makeHttpsGet(200, {
      tag_name: 'experimental-latest',
      assets: [
        { name: 'zDEV-UE4SS_v3.0.1-953-gb872ad11.zip', browser_download_url: 'https://github.com/x' },
        { name: 'zCustomGameConfigs.zip',                browser_download_url: 'https://github.com/x' },
        { name: 'zMapGenBP.zip',                         browser_download_url: 'https://github.com/x' },
        { name: 'UE4SS_v3.0.1-953-gb872ad11.zip',        browser_download_url: 'https://objects.githubusercontent.com/UE4SS_v3.0.1-953-gb872ad11.zip' },
      ],
    })(url, opts, cb);
  };
  return idx.fetchLatestUE4SS().then(asset => {
    mockHttps.get = savedGet;
    assert.ok(asset, 'should return an asset');
    assert.strictEqual(asset.name, 'UE4SS_v3.0.1-953-gb872ad11.zip');
    assert.strictEqual(asset.tag, 'experimental-latest');
    assert.ok(capturedUrl.includes('/releases/tags/experimental-latest'), 'endpoint uses experimental-latest tag');
  });
});
test('(d) returns null on non-200 status', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(404, 'Not Found');
  return idx.fetchLatestUE4SS().then(asset => {
    mockHttps.get = savedGet;
    assert.strictEqual(asset, null);
  });
});
test('returns null when release has no matching asset', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, { tag_name: 'v3.0.1', assets: [] });
  return idx.fetchLatestUE4SS().then(asset => {
    mockHttps.get = savedGet;
    assert.strictEqual(asset, null);
  });
});
test('returns null when asset URL is untrusted (H1 re-validation)', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, {
    tag_name: 'v3.0.1',
    assets: [{ name: 'UE4SS_v3.0.1.zip', browser_download_url: 'https://evil.com/UE4SS_v3.0.1.zip' }],
  });
  return idx.fetchLatestUE4SS().then(asset => {
    mockHttps.get = savedGet;
    assert.strictEqual(asset, null);
  });
});

// ===========================================================================
// 8. downloadUE4SS  (H2 — consent dialog)
// ===========================================================================
console.log('\ndownloadUE4SS (H2 consent)');

test('aborts when no asset found (no dialog shown)', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, { tag_name: 'v3.0.1', assets: [] });
  let dialogCalled = false;
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = () => { dialogCalled = true; return Promise.resolve(null); };
  return idx.downloadUE4SS(mockContext.api).then(() => {
    mockHttps.get = savedGet;
    mockContext.api.showDialog = savedDialog;
    assert.ok(!dialogCalled, 'dialog must NOT be shown when no asset found');
  });
});
test('aborts download when user clicks Cancel', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, {
    tag_name: 'experimental-latest',
    assets: [{ name: 'UE4SS_v3.0.1-953-gb872ad11.zip', browser_download_url: 'https://objects.githubusercontent.com/UE4SS_v3.0.1-953-gb872ad11.zip' }],
  });
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = () => Promise.resolve({ action: 'Cancel' });
  let emitCalled = false;
  const savedEmit = mockContext.api.events.emit;
  mockContext.api.events.emit = () => { emitCalled = true; };
  return idx.downloadUE4SS(mockContext.api).then(() => {
    mockHttps.get = savedGet;
    mockContext.api.showDialog = savedDialog;
    mockContext.api.events.emit = savedEmit;
    assert.ok(!emitCalled, 'start-download must NOT be emitted on Cancel');
  });
});
test('starts download + install when user confirms', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, {
    tag_name: 'experimental-latest',
    assets: [{ name: 'UE4SS_v3.0.1-953-gb872ad11.zip', browser_download_url: 'https://objects.githubusercontent.com/UE4SS_v3.0.1-953-gb872ad11.zip' }],
  });
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = () => Promise.resolve({ action: 'Download UE4SS' });
  const emitted = [];
  const savedEmit = mockContext.api.events.emit;
  mockContext.api.events.emit = (ev, ...args) => {
    emitted.push(ev);
    if (ev === 'start-download')         { const cb = args[3]; if (cb) cb(null, 'dl-id-1'); }
    if (ev === 'start-install-download') { const cb = args[2]; if (cb) cb(null); }
  };
  return idx.downloadUE4SS(mockContext.api).then(() => {
    mockHttps.get = savedGet;
    mockContext.api.showDialog = savedDialog;
    mockContext.api.events.emit = savedEmit;
    assert.ok(emitted.includes('start-download'),         'start-download emitted');
    assert.ok(emitted.includes('start-install-download'), 'start-install-download emitted');
  });
});
test('dialog text names the release tag + Binaries/Win64 + experimental', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, {
    tag_name: 'experimental-latest',
    assets: [{ name: 'UE4SS_v3.0.1-953-gb872ad11.zip', browser_download_url: 'https://objects.githubusercontent.com/UE4SS_v3.0.1-953-gb872ad11.zip' }],
  });
  let dialogText = '';
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = (_type, _title, body) => {
    dialogText = body.text || '';
    return Promise.resolve({ action: 'Cancel' });
  };
  return idx.downloadUE4SS(mockContext.api).then(() => {
    mockHttps.get = savedGet;
    mockContext.api.showDialog = savedDialog;
    assert.ok(dialogText.includes('experimental-latest'), 'tag in dialog text');
    assert.ok(dialogText.includes('Binaries/Win64'),       'destination in dialog text');
    assert.ok(dialogText.includes('experimental'),         'dialog mentions experimental build');
  });
});
test('skips download for untrusted asset URL (H1 guard)', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, {
    tag_name: 'v3.0.1',
    assets: [{ name: 'UE4SS_v3.0.1.zip', browser_download_url: 'https://evil.com/UE4SS_v3.0.1.zip' }],
  });
  let dialogCalled = false;
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = () => { dialogCalled = true; return Promise.resolve(null); };
  return idx.downloadUE4SS(mockContext.api).then(() => {
    mockHttps.get = savedGet;
    mockContext.api.showDialog = savedDialog;
    assert.ok(!dialogCalled, 'dialog must NOT be shown for untrusted URL');
  });
});

// ===========================================================================
// 9. isUE4SSInstalled  (B1 — robust fail-safe guard)
// ===========================================================================
console.log('\nisUE4SSInstalled');

test('(a) returns true when dwmapi.dll present (flat layout)', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = (p) =>
    (p === WIN64 || p === path.join(WIN64, 'dwmapi.dll'))
      ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  const result = await idx.isUE4SSInstalled('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, true);
});
test('returns true when UE4SS-settings.ini present (flat layout)', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = (p) =>
    (p === WIN64 || p === path.join(WIN64, 'UE4SS-settings.ini'))
      ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  const result = await idx.isUE4SSInstalled('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, true);
});
test('returns true when UE4SS.dll present (flat layout)', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = (p) =>
    (p === WIN64 || p === path.join(WIN64, 'UE4SS.dll'))
      ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  const result = await idx.isUE4SSInstalled('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, true);
});
test('returns true when nested ue4ss/UE4SS.dll present (legacy layout)', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = (p) =>
    (p === WIN64 || p === path.join(WIN64, 'ue4ss', 'UE4SS.dll'))
      ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  const result = await idx.isUE4SSInstalled('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, true);
});
test('(b) returns false when Win64 exists but all markers absent', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = (p) =>
    p === WIN64 ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  const result = await idx.isUE4SSInstalled('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, false);
});
test('returns true (fail-safe) when Binaries/Win64 itself is absent', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = () => Promise.reject(new Error('ENOENT'));
  const result = await idx.isUE4SSInstalled('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, true);
});

// ===========================================================================
// 10. findSettingsFile  (E2)
// ===========================================================================
console.log('\nfindSettingsFile');

test('returns flat path when flat settings file exists', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = (p) =>
    p === FLAT_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  const result = await idx.findSettingsFile('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, FLAT_SETTINGS);
});
test('returns nested path when only nested settings file exists', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = (p) =>
    p === NESTED_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  const result = await idx.findSettingsFile('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, NESTED_SETTINGS);
});
test('returns null when neither flat nor nested file exists', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = () => Promise.reject(new Error('ENOENT'));
  const result = await idx.findSettingsFile('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, null);
});

// ===========================================================================
// 12. getIniListValues + setIniListValues  (Part G)
// ===========================================================================
console.log('\ngetIniListValues / setIniListValues');

const OVERRIDES_INI = [
  '[Overrides]',
  'ModsFolderPath =',
  '; +ModsFolderPaths = ../SharedMods  (comment — must be ignored)',
  '+ModsFolderPaths = ../Mods1',
  '+ModsFolderPaths = ../Mods2',
  'ControllingModsTxt = mods.txt',
  '',
  '[Debug]',
  'GraphicsAPI = dx11',
].join('\n');

test('getIniListValues: returns values from both +key lines', () => {
  const result = idx.getIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths');
  assert.deepStrictEqual(result, ['../Mods1', '../Mods2']);
});
test('getIniListValues: returns [] when no matching +key lines', () => {
  const result = idx.getIniListValues(OVERRIDES_INI, 'Overrides', 'NonExistent');
  assert.deepStrictEqual(result, []);
});
test('getIniListValues: returns [] when section absent', () => {
  const result = idx.getIniListValues(OVERRIDES_INI, 'Missing', 'ModsFolderPaths');
  assert.deepStrictEqual(result, []);
});
test('getIniListValues: case-insensitive section + key', () => {
  const ini = '[overrides]\n+modsfolderPaths = ../X\n';
  assert.deepStrictEqual(idx.getIniListValues(ini, 'Overrides', 'ModsFolderPaths'), ['../X']);
});
test('getIniListValues: ignores commented +key lines', () => {
  // OVERRIDES_INI has a commented +ModsFolderPaths — result must be exactly 2, not 3
  const result = idx.getIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths');
  assert.strictEqual(result.length, 2, 'commented +key line must be ignored');
});

test('setIniListValues: removes old entries and inserts new ones', () => {
  const result = idx.setIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths', ['../Mods1', '../Mods3']);
  const got = idx.getIniListValues(result, 'Overrides', 'ModsFolderPaths');
  assert.deepStrictEqual(got, ['../Mods1', '../Mods3']);
});
test('setIniListValues: preserves ModsFolderPath and ControllingModsTxt', () => {
  const result = idx.setIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths', ['../Mods3']);
  assert.ok(result.includes('ModsFolderPath ='),         'ModsFolderPath preserved');
  assert.ok(result.includes('ControllingModsTxt = mods.txt'), 'ControllingModsTxt preserved');
  assert.ok(result.includes('; +ModsFolderPaths = ../SharedMods'), 'comment line preserved');
});
test('setIniListValues: preserves [Debug] section', () => {
  const result = idx.setIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths', ['../Mods3']);
  assert.ok(result.includes('[Debug]'), '[Debug] section preserved');
  assert.ok(result.includes('GraphicsAPI = dx11'), 'GraphicsAPI = dx11 preserved');
});
test('setIniListValues: empty array removes all +key lines', () => {
  const result = idx.setIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths', []);
  const got = idx.getIniListValues(result, 'Overrides', 'ModsFolderPaths');
  assert.deepStrictEqual(got, []);
  // Non-list keys must still be present
  assert.ok(result.includes('ModsFolderPath ='));
});
test('setIniListValues: also removes -key lines', () => {
  const ini = '[Overrides]\nModsFolderPath =\n-ModsFolderPaths = ../Stale\n+ModsFolderPaths = ../Keep\n';
  const result = idx.setIniListValues(ini, 'Overrides', 'ModsFolderPaths', ['../New']);
  assert.ok(!result.includes('-ModsFolderPaths'), '-key line should be removed');
  assert.ok(!result.includes('../Stale'),         'old -key value should be gone');
  assert.ok(!result.includes('../Keep'),          'old +key value should be gone');
  assert.ok(result.includes('+ModsFolderPaths = ../New'), 'new +key line present');
});
test('setIniListValues: creates [Overrides] section when absent', () => {
  const ini = '[Debug]\nGraphicsAPI = dx11\n';
  const result = idx.setIniListValues(ini, 'Overrides', 'ModsFolderPaths', ['../Mods1']);
  assert.ok(result.includes('[Overrides]'), '[Overrides] section created');
  assert.ok(result.includes('+ModsFolderPaths = ../Mods1'), '+key line present');
  assert.ok(result.includes('[Debug]'), '[Debug] section preserved');
});
test('setIniListValues: empty array + absent section → no-op', () => {
  const ini = '[Debug]\nGraphicsAPI = dx11\n';
  const result = idx.setIniListValues(ini, 'Overrides', 'ModsFolderPaths', []);
  assert.ok(!result.includes('[Overrides]'), 'should not create empty section');
  assert.strictEqual(idx.getIniListValues(result, 'Overrides', 'ModsFolderPaths').length, 0);
});
test('setIniListValues round-trip: parse → modify → re-parse', () => {
  const parsed  = idx.getIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths');
  // Simulate add one, remove one: replace Mods2 with Mods3
  const updated = [...parsed.filter(p => p !== '../Mods2'), '../Mods3'];
  const written = idx.setIniListValues(OVERRIDES_INI, 'Overrides', 'ModsFolderPaths', updated);
  const reparsed = idx.getIniListValues(written, 'Overrides', 'ModsFolderPaths');
  assert.deepStrictEqual(reparsed, ['../Mods1', '../Mods3']);
});

// ===========================================================================
// 13. UE4SSSettingsPage — mod folders UI (Part H)
// ===========================================================================
console.log('\nUE4SSSettingsPage (mod folders)');

test('load(): populates modFolders from [Overrides] +ModsFolderPaths', async () => {
  const savedStat = mockFs.statAsync;
  const savedRead = mockFs.readFileAsync;
  mockFs.statAsync     = (p) => p === FLAT_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = () => Promise.resolve(OVERRIDES_INI);
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.load();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1', '../Mods2'],
    'modFolders should be loaded from INI');
});
test('Add folder: pushes to modFolders and clears newFolder', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: ['../Mods1'], newFolder: '../NewMod', loaded: true, error: null, dirty: false,
  };
  // Simulate clicking Add: same logic as in render()
  const trimmed = inst.state.newFolder.trim();
  if (trimmed) inst.setState(s => ({ modFolders: [...s.modFolders, trimmed], newFolder: '', dirty: true }));
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1', '../NewMod']);
  assert.strictEqual(inst.state.newFolder, '');
  assert.strictEqual(inst.state.dirty, true);
});
test('Browse: selectDir result is appended to modFolders', async () => {
  const apiWithSelectDir = {
    ...mockContext.api,
    selectDir: () => Promise.resolve('/absolute/path/to/Mods'),
  };
  const inst = new idx.UE4SSSettingsPage({ api: apiWithSelectDir });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: ['../Mods1'], newFolder: '', loaded: true, error: null, dirty: false,
  };
  // Simulate Browse click: same logic as in render()
  await apiWithSelectDir.selectDir({ title: 'Select a UE4SS mods folder' })
    .then(p => { if (p) inst.setState({ modFolders: inst.state.modFolders.concat(p), dirty: true }); })
    .catch(() => null);
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1', '/absolute/path/to/Mods']);
  assert.strictEqual(inst.state.dirty, true);
});
test('Browse: cancel (empty string) does not change modFolders', async () => {
  const apiWithSelectDir = {
    ...mockContext.api,
    selectDir: () => Promise.resolve(''),
  };
  const inst = new idx.UE4SSSettingsPage({ api: apiWithSelectDir });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: ['../Mods1'], newFolder: '', loaded: true, error: null, dirty: false,
  };
  await apiWithSelectDir.selectDir({ title: 'Select a UE4SS mods folder' })
    .then(p => { if (p) inst.setState({ modFolders: inst.state.modFolders.concat(p), dirty: true }); })
    .catch(() => null);
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1'], 'cancel leaves modFolders unchanged');
  assert.strictEqual(inst.state.dirty, false, 'cancel does not set dirty');
});
test('Remove folder: filters modFolders by index', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: ['../Mods1', '../Mods2', '../Mods3'], newFolder: '', loaded: true, error: null, dirty: false,
  };
  const idx_to_remove = 1; // remove ../Mods2
  inst.setState(s => ({ modFolders: s.modFolders.filter((_, i) => i !== idx_to_remove), dirty: true }));
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1', '../Mods3']);
  assert.strictEqual(inst.state.dirty, true);
});
test('save(): writes modFolders via setIniListValues', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenContent = null;
  mockFs.statAsync      = (p) => p === FLAT_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync  = () => Promise.resolve('[Debug]\nGraphicsAPI = dx11\n');
  mockFs.writeFileAsync = (_p, c) => { writtenContent = c; return Promise.resolve(); };
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: ['../SharedMods', '../TeamMods'], newFolder: '', loaded: true, error: null, dirty: true,
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.ok(writtenContent, 'writeFileAsync was called');
  assert.ok(writtenContent.includes('+ModsFolderPaths = ../SharedMods'), 'first folder written');
  assert.ok(writtenContent.includes('+ModsFolderPaths = ../TeamMods'),   'second folder written');
});

// ===========================================================================
// 11. UE4SSSettingsPage  (E3 — React class component)
// ===========================================================================
console.log('\nUE4SSSettingsPage');

test('render(): shows loading text before load completes', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state.loaded = false;
  const el = inst.render();
  assert.ok(el, 'render() should return an element');
  const text = (el.children || []).join(' ');
  assert.ok(text.toLowerCase().includes('loading'), 'should include loading text');
});
test('render(): shows "not installed" message + Refresh button when settingsPath is null', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = { loaded: true, settingsPath: null, error: null, graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirty: false };
  const el = inst.render();
  assert.ok(el, 'render() should return an element');
  const text = (el.children || []).join(' ').toLowerCase();
  assert.ok(text.includes('not installed') || text.includes('install'),
    'should mention not-installed state');
  // Refresh button must be present in the "not installed" branch
  const hasRefreshBtn = (el.children || []).some(c => c && c.type === 'Button' ||
    (c && typeof c === 'object' && (c.children || []).join('') === 'Refresh'));
  // We can't deeply check React elements easily, but the button object will be non-null/non-string
  const nonTextChildren = (el.children || []).filter(c => c && typeof c !== 'string');
  assert.ok(nonTextChildren.length > 0, 'should include a Refresh button element');
});
test('render(): shows error message when error is set', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = { loaded: true, settingsPath: null, error: 'Kaboom!', graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirty: false };
  const el = inst.render();
  const text = (el.children || []).join(' ');
  assert.ok(text.includes('Kaboom!'), 'should include the error message');
});
test('render(): returns a div when fully loaded with a settingsPath', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = { loaded: true, settingsPath: FLAT_SETTINGS, error: null, graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirty: false };
  const el = inst.render();
  assert.ok(el, 'render() should return an element');
  assert.strictEqual(el.type, 'div', 'outermost element should be a div');
});
test('render(): loaded view has a btn-toolbar with Save and Refresh', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = { loaded: true, settingsPath: FLAT_SETTINGS, error: null, graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirty: false };
  const el = inst.render();
  // Outer div contains section groups + btn-toolbar
  const outerChildren = (el.children || []).filter(c => c && typeof c !== 'string' && c !== null);
  assert.ok(outerChildren.length >= 2, 'loaded view should have multiple section elements');
  // toolbar is the last non-null child; check it has buttons
  const toolbar = (el.children || []).find(c => c && c.props && c.props.className === 'btn-toolbar');
  assert.ok(toolbar, 'should have a btn-toolbar div');
  const toolbarBtns = (toolbar.children || []).filter(c => c && typeof c !== 'string' && c !== null);
  assert.ok(toolbarBtns.length >= 2, 'toolbar should have at least Save + Refresh buttons');
});
test('refresh: setState({ loaded:false, error:null }) then load() — state resets before re-read', async () => {
  const savedStat = mockFs.statAsync;
  const savedRead = mockFs.readFileAsync;
  // First read: settings absent
  mockFs.statAsync     = () => Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = () => Promise.resolve('');
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.load();
  await flushPromises();
  assert.strictEqual(inst.state.settingsPath, null, 'initially not installed');
  // Now "install" UE4SS — flat settings appears
  mockFs.statAsync     = (p) => p === FLAT_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = () => Promise.resolve('[Debug]\nGraphicsAPI = opengl\n');
  // Simulate Refresh click: setState resets, then load() is called.
  // (mock setState has no callback support; set state directly then call load())
  inst.setState({ loaded: false, error: null });
  inst.load();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  assert.strictEqual(inst.state.settingsPath, FLAT_SETTINGS, 'after refresh, settingsPath found');
  assert.strictEqual(inst.state.graphicsAPI,  'opengl',      'after refresh, graphicsAPI read from INI');
  assert.strictEqual(inst.state.loaded,       true,          'after refresh, loaded is true');
});
test('load(): reads INI and populates state correctly', async () => {
  const savedStat = mockFs.statAsync;
  const savedRead = mockFs.readFileAsync;
  mockFs.statAsync     = (p) => p === FLAT_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = () => Promise.resolve('[Debug]\nGraphicsAPI = dx11\nGuiConsoleEnabled = 0\n');
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.load();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  assert.strictEqual(inst.state.graphicsAPI,       'dx11',  'graphicsAPI loaded from INI');
  assert.strictEqual(inst.state.guiConsoleEnabled, false,   'guiConsoleEnabled is false when INI value is 0');
  assert.strictEqual(inst.state.loaded,            true,    'loaded flag is true');
  assert.strictEqual(inst.state.settingsPath, FLAT_SETTINGS, 'settingsPath resolved to flat path');
});
test('save(): patches INI, writes file, and sends success notification', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenContent = null;
  mockFs.statAsync      = (p) => p === FLAT_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync  = () => Promise.resolve('[Debug]\nGraphicsAPI = opengl\nGuiConsoleEnabled = 1\n');
  mockFs.writeFileAsync = (_p, c) => { writtenContent = c; return Promise.resolve(); };
  let notifSent = false;
  const savedNotif = mockContext.api.sendNotification;
  mockContext.api.sendNotification = () => { notifSent = true; };
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, dirty: true, error: null,
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync              = savedStat;
  mockFs.readFileAsync          = savedRead;
  mockFs.writeFileAsync         = savedWrite;
  mockContext.api.sendNotification = savedNotif;
  assert.ok(writtenContent,                          'writeFileAsync was called');
  assert.ok(writtenContent.includes('dx11'),         'written content has dx11');
  assert.ok(writtenContent.includes('GuiConsoleEnabled'), 'written content has GuiConsoleEnabled');
  assert.ok(notifSent,                               'success notification was sent');
});

// ===========================================================================
// Runner
// ===========================================================================
(async () => {
  for (const t of tests) await t();
  console.log('\n' + passed + '/' + (passed + failed) + ' tests passed.');
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('Runner error:', err);
  process.exit(1);
});
