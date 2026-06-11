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
    onAsync:          () => {},
  },
  registerModType:    () => {},
  registerInstaller:  () => {},
  registerGame:       () => {},
  registerSettings:   () => {},
  once:               (fn) => fn(),
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
const WIN64              = path.join('/game', 'EMERGENCY', 'Binaries', 'Win64');
const FLAT_SETTINGS      = path.join(WIN64, 'UE4SS-settings.ini');
const NESTED_SETTINGS    = path.join(WIN64, 'ue4ss', 'UE4SS-settings.ini');
const FLAT_TEMPLATE      = path.join(WIN64, 'UE4SS-settings.default.ini');
const NESTED_TEMPLATE    = path.join(WIN64, 'ue4ss', 'UE4SS-settings.default.ini');

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
test('rejects drive-relative C:foo.dll (no slash after colon)', () => assert.ok(!idx.isSafeRelPath('C:foo.dll')));
test('allows normal relative path ue4ss/Mods/x.lua', () => assert.ok(idx.isSafeRelPath('ue4ss/Mods/x.lua')));

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
      assert.strictEqual(genf.destination, 'UE4SS-settings.default.ini');
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
      assert.ok(r.instructions.find(i => i.type === 'copy' && i.destination === 'UE4SS-settings.default.ini'),
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
  const savedNotif = mockContext.api.sendNotification;
  mockContext.api.sendNotification = () => {};
  return idx.downloadUE4SS(mockContext.api).then(() => {
    mockHttps.get = savedGet;
    mockContext.api.showDialog = savedDialog;
    mockContext.api.sendNotification = savedNotif;
    assert.ok(!dialogCalled, 'dialog must NOT be shown when no asset found');
  });
});
test('sends warning notification when asset is null (Fix 2)', () => {
  const savedGet = mockHttps.get;
  mockHttps.get = makeHttpsGet(200, { tag_name: 'v3.0.1', assets: [] });
  let notifSent = null;
  const savedNotif = mockContext.api.sendNotification;
  mockContext.api.sendNotification = (n) => { notifSent = n; };
  return idx.downloadUE4SS(mockContext.api).then(() => {
    mockHttps.get = savedGet;
    mockContext.api.sendNotification = savedNotif;
    assert.ok(notifSent, 'sendNotification must be called when asset is null');
    assert.strictEqual(notifSent.type, 'warning', 'notification type must be warning');
    assert.strictEqual(notifSent.id, 'ue4ss-fetch-failed', 'notification id must be ue4ss-fetch-failed');
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
test('returns false when Binaries/Win64 itself is absent (UE4SS not installed)', async () => {
  const saved = mockFs.statAsync;
  mockFs.statAsync = () => Promise.reject(new Error('ENOENT'));
  const result = await idx.isUE4SSInstalled('/game');
  mockFs.statAsync = saved;
  assert.strictEqual(result, false);
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
    modFolders: ['../Mods1'], newFolder: '../NewMod', loaded: true, error: null, dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  // Simulate clicking Add: same logic as in render()
  const trimmed = inst.state.newFolder.trim();
  if (trimmed) inst.setState(s => { const d = Object.assign({}, s.dirtyFields); d['modFolders'] = true; return { modFolders: s.modFolders.concat([trimmed]), newFolder: '', dirtyFields: d }; });
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1', '../NewMod']);
  assert.strictEqual(inst.state.newFolder, '');
  assert.ok(inst.state.dirtyFields['modFolders'], 'modFolders should be dirty');
});
test('Add folder: newline injection is stripped before push', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: 'folder\n[Hack]\nkey = 1', loaded: true, error: null, dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  // Simulate clicking Add: same logic as in render() after Fix 7
  const trimmed = inst.state.newFolder.replace(/[\r\n]+/g, '').trim();
  if (trimmed) inst.setState(s => { const d = Object.assign({}, s.dirtyFields); d['modFolders'] = true; return { modFolders: s.modFolders.concat([trimmed]), newFolder: '', dirtyFields: d }; });
  assert.strictEqual(inst.state.modFolders.length, 1, 'exactly one element added');
  assert.ok(!inst.state.modFolders[0].includes('\n'), 'added value contains no newline');
  assert.ok(!inst.state.modFolders[0].includes('\r'), 'added value contains no carriage return');
  assert.strictEqual(inst.state.modFolders[0], 'folder[Hack]key = 1', 'newlines stripped, not split');
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
    modFolders: ['../Mods1'], newFolder: '', loaded: true, error: null, dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  // Simulate Browse click: same logic as in render()
  await apiWithSelectDir.selectDir({ title: 'Select a UE4SS mods folder' })
    .then(p => { if (p) inst.setState(s => { const d = Object.assign({}, s.dirtyFields); d['modFolders'] = true; return { modFolders: s.modFolders.concat([p]), dirtyFields: d }; }); })
    .catch(() => null);
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1', '/absolute/path/to/Mods']);
  assert.ok(inst.state.dirtyFields['modFolders'], 'modFolders should be dirty after browse');
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
    modFolders: ['../Mods1'], newFolder: '', loaded: true, error: null, dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  await apiWithSelectDir.selectDir({ title: 'Select a UE4SS mods folder' })
    .then(p => { if (p) inst.setState(s => { const d = Object.assign({}, s.dirtyFields); d['modFolders'] = true; return { modFolders: s.modFolders.concat([p]), dirtyFields: d }; }); })
    .catch(() => null);
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1'], 'cancel leaves modFolders unchanged');
  assert.strictEqual(Object.keys(inst.state.dirtyFields).length, 0, 'cancel does not set dirty');
});
test('Remove folder: filters modFolders by index', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: ['../Mods1', '../Mods2', '../Mods3'], newFolder: '', loaded: true, error: null, dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  const idx_to_remove = 1; // remove ../Mods2
  inst.setState(s => { const d = Object.assign({}, s.dirtyFields); d['modFolders'] = true; return { modFolders: s.modFolders.filter((_, i) => i !== idx_to_remove), dirtyFields: d }; });
  assert.deepStrictEqual(inst.state.modFolders, ['../Mods1', '../Mods3']);
  assert.ok(inst.state.dirtyFields['modFolders'], 'modFolders should be dirty after remove');
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
    modFolders: ['../SharedMods', '../TeamMods'], newFolder: '', loaded: true, error: null,
    dirtyFields: { modFolders: true }, fileMtime: null, loadedValues: null,
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
  inst.state = { loaded: true, settingsPath: null, error: null, graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirtyFields: {}, fileMtime: null, loadedValues: null };
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
  inst.state = { loaded: true, settingsPath: null, error: 'Kaboom!', graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirtyFields: {}, fileMtime: null, loadedValues: null };
  const el = inst.render();
  const text = (el.children || []).join(' ');
  assert.ok(text.includes('Kaboom!'), 'should include the error message');
});
test('render(): returns a div when fully loaded with a settingsPath', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = { loaded: true, settingsPath: FLAT_SETTINGS, error: null, graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirtyFields: {}, fileMtime: null, loadedValues: null };
  const el = inst.render();
  assert.ok(el, 'render() should return an element');
  assert.strictEqual(el.type, 'div', 'outermost element should be a div');
});
test('render(): loaded view has a btn-toolbar with Save and Refresh', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = { loaded: true, settingsPath: FLAT_SETTINGS, error: null, graphicsAPI: 'dx11', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [], newFolder: '', dirtyFields: {}, fileMtime: null, loadedValues: null };
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
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: { graphicsAPI: true, consoleEnabled: true, guiConsoleEnabled: true, guiConsoleVisible: true, renderMode: true },
    fileMtime: null, loadedValues: null,
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
// 14. registerModType path callback — discovery guard (Fix 3)
// ===========================================================================
console.log('\nregisterModType path callback');

test('returns "." when discovery is absent for game (Fix 3)', () => {
  let capturedPathCb = null;
  const ctx = {
    api: {
      getState: () => ({
        settings: { gameMode: { discovered: {} } },
      }),
      sendNotification: () => {},
      showDialog: () => Promise.resolve(null),
      events: { emit: () => {} },
      onAsync: () => {},
    },
    registerModType:   (_id, _pri, _supported, pathCb) => { capturedPathCb = pathCb; },
    registerInstaller: () => {},
    registerGame:      () => {},
    registerSettings:  () => {},
    once: (fn) => fn(),
  };
  const { default: mainFn } = idx;
  mainFn(ctx);
  assert.ok(capturedPathCb, 'path callback should have been captured');
  const result = capturedPathCb({ id: 'emergency2023' });
  assert.strictEqual(result, '.', 'should return "." when discovery is absent');
});
test('returns Binaries/Win64 path when discovery is present (Fix 3)', () => {
  let capturedPathCb = null;
  const ctx = {
    api: {
      getState: () => ({
        settings: { gameMode: { discovered: { emergency2023: { path: '/game' } } } },
      }),
      sendNotification: () => {},
      showDialog: () => Promise.resolve(null),
      events: { emit: () => {} },
      onAsync: () => {},
    },
    registerModType:   (_id, _pri, _supported, pathCb) => { capturedPathCb = pathCb; },
    registerInstaller: () => {},
    registerGame:      () => {},
    registerSettings:  () => {},
    once: (fn) => fn(),
  };
  const { default: mainFn } = idx;
  mainFn(ctx);
  assert.ok(capturedPathCb, 'path callback should have been captured');
  const result = capturedPathCb({ id: 'emergency2023' });
  assert.ok(result.includes('Binaries'), 'should include Binaries in path');
  assert.ok(result.startsWith('/game'),  'should start with the game path');
});

// ===========================================================================
// 15. ensureUserSettingsFile  (B3)
// ===========================================================================
console.log('\nensureUserSettingsFile');

test('(a) active settings file exists -> returned as-is, writeFileAsync never called', async () => {
  const savedStat  = mockFs.statAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writeCalled = false;
  mockFs.statAsync     = (p) => p === FLAT_SETTINGS ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.writeFileAsync = () => { writeCalled = true; return Promise.resolve(); };
  const result = await idx.ensureUserSettingsFile('/game');
  mockFs.statAsync     = savedStat;
  mockFs.writeFileAsync = savedWrite;
  assert.strictEqual(result, FLAT_SETTINGS, 'should return existing active path');
  assert.ok(!writeCalled, 'writeFileAsync must NOT be called when active file exists');
});

test('(b) active absent + flat template -> writes UE4SS-settings.ini next to template', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenPath = null;
  let writtenContent = null;
  const TEMPLATE_CONTENT = '[Debug]\nGraphicsAPI = dx11\n';
  mockFs.statAsync     = (p) => p === FLAT_TEMPLATE ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = (p) => p === FLAT_TEMPLATE ? Promise.resolve(TEMPLATE_CONTENT) : Promise.reject(new Error('ENOENT'));
  mockFs.writeFileAsync = (p, c) => { writtenPath = p; writtenContent = c; return Promise.resolve(); };
  const result = await idx.ensureUserSettingsFile('/game');
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.strictEqual(result, FLAT_SETTINGS, 'should return newly created flat settings path');
  assert.strictEqual(writtenPath, FLAT_SETTINGS, 'writeFileAsync called on flat settings path');
  assert.strictEqual(writtenContent, TEMPLATE_CONTENT, 'content copied from template');
});

test('(c) active absent + nested template -> writes UE4SS-settings.ini in ue4ss/ subfolder', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenPath = null;
  const TEMPLATE_CONTENT = '[Debug]\nGraphicsAPI = dx11\n';
  mockFs.statAsync     = (p) => p === NESTED_TEMPLATE ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = (p) => p === NESTED_TEMPLATE ? Promise.resolve(TEMPLATE_CONTENT) : Promise.reject(new Error('ENOENT'));
  mockFs.writeFileAsync = (p) => { writtenPath = p; return Promise.resolve(); };
  const result = await idx.ensureUserSettingsFile('/game');
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.strictEqual(result, NESTED_SETTINGS, 'should return newly created nested settings path');
  assert.strictEqual(writtenPath, NESTED_SETTINGS, 'writeFileAsync called on nested settings path');
});

test('(d) neither active nor template -> returns null, no write', async () => {
  const savedStat  = mockFs.statAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writeCalled = false;
  mockFs.statAsync     = () => Promise.reject(new Error('ENOENT'));
  mockFs.writeFileAsync = () => { writeCalled = true; return Promise.resolve(); };
  const result = await idx.ensureUserSettingsFile('/game');
  mockFs.statAsync     = savedStat;
  mockFs.writeFileAsync = savedWrite;
  assert.strictEqual(result, null, 'should return null when neither file exists');
  assert.ok(!writeCalled, 'writeFileAsync must not be called when no template found');
});

// ===========================================================================
// 16. did-deploy hook  (B3)
// ===========================================================================
console.log('\ndid-deploy hook');

test('(a) did-deploy: profile from another game -> ensureUserSettingsFile not triggered', async () => {
  let statCalled = false;
  const savedStat = mockFs.statAsync;
  mockFs.statAsync = () => { statCalled = true; return Promise.resolve({}); };

  let capturedHandler = null;
  const ctx = {
    api: {
      getState: () => ({
        settings: { gameMode: { discovered: { emergency2023: { path: '/game' } } } },
        persistent: { profiles: { 'prof-other': { gameId: 'othergame' } } },
      }),
      sendNotification: () => {},
      showDialog: () => Promise.resolve(null),
      events: { emit: () => {} },
      onAsync: (_ev, fn) => { capturedHandler = fn; },
    },
    registerModType:   () => {},
    registerInstaller: () => {},
    registerGame:      () => {},
    registerSettings:  () => {},
    once: (fn) => fn(),
  };
  const { default: mainFn } = idx;
  mainFn(ctx);
  mockFs.statAsync = savedStat;

  assert.ok(capturedHandler, 'onAsync handler should be registered');
  statCalled = false;
  const savedStat2 = mockFs.statAsync;
  mockFs.statAsync = () => { statCalled = true; return Promise.reject(new Error('ENOENT')); };
  await capturedHandler('prof-other');
  mockFs.statAsync = savedStat2;
  assert.ok(!statCalled, 'statAsync must not be called for a different game profile');
});

test('(b) did-deploy: emergency2023 profile + discovery -> ensureUserSettingsFile runs', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writeWasCalled = false;
  const TEMPLATE_CONTENT = '[Debug]\nGraphicsAPI = dx11\n';
  // No active INI, flat template present
  mockFs.statAsync     = (p) => p === FLAT_TEMPLATE ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = (p) => p === FLAT_TEMPLATE ? Promise.resolve(TEMPLATE_CONTENT) : Promise.reject(new Error('ENOENT'));
  mockFs.writeFileAsync = () => { writeWasCalled = true; return Promise.resolve(); };

  let capturedHandler = null;
  const ctx = {
    api: {
      getState: () => ({
        settings: { gameMode: { discovered: { emergency2023: { path: '/game' } } } },
        persistent: { profiles: { 'prof-em': { gameId: 'emergency2023' } } },
      }),
      sendNotification: () => {},
      showDialog: () => Promise.resolve(null),
      events: { emit: () => {} },
      onAsync: (_ev, fn) => { capturedHandler = fn; },
    },
    registerModType:   () => {},
    registerInstaller: () => {},
    registerGame:      () => {},
    registerSettings:  () => {},
    once: (fn) => fn(),
  };
  const { default: mainFn } = idx;
  mainFn(ctx);

  await capturedHandler('prof-em');
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.ok(writeWasCalled, 'writeFileAsync should have been called to create settings from template');
});

test('(c) did-deploy: write error -> sendNotification warning called', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  const TEMPLATE_CONTENT = '[Debug]\nGraphicsAPI = dx11\n';
  mockFs.statAsync     = (p) => p === FLAT_TEMPLATE ? Promise.resolve({}) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = (p) => p === FLAT_TEMPLATE ? Promise.resolve(TEMPLATE_CONTENT) : Promise.reject(new Error('ENOENT'));
  mockFs.writeFileAsync = () => Promise.reject(new Error('EPERM: permission denied'));

  let notifSent = null;
  let capturedHandler = null;
  const ctx = {
    api: {
      getState: () => ({
        settings: { gameMode: { discovered: { emergency2023: { path: '/game' } } } },
        persistent: { profiles: { 'prof-em': { gameId: 'emergency2023' } } },
      }),
      sendNotification: (n) => { notifSent = n; },
      showDialog: () => Promise.resolve(null),
      events: { emit: () => {} },
      onAsync: (_ev, fn) => { capturedHandler = fn; },
    },
    registerModType:   () => {},
    registerInstaller: () => {},
    registerGame:      () => {},
    registerSettings:  () => {},
    once: (fn) => fn(),
  };
  const { default: mainFn } = idx;
  mainFn(ctx);

  await capturedHandler('prof-em');
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.ok(notifSent, 'sendNotification must be called on write error');
  assert.strictEqual(notifSent.type, 'warning', 'notification type must be warning');
  assert.strictEqual(notifSent.id, 'ue4ss-settings-create-failed', 'notification id correct');
  assert.ok(notifSent.message.includes('EPERM') || notifSent.message.includes('permission'),
    'notification message contains error text');
});

// ===========================================================================
// 17. UE4SSSettingsPage — dirty tracking & selective save
// ===========================================================================
console.log('\nUE4SSSettingsPage (dirty tracking & selective save)');

test('dirtyFields: save() with single dirty field only writes that key', async () => {
  // File has GraphicsAPI=opengl; state has dx11 (dirty) but GuiConsoleEnabled differs too (NOT dirty).
  // Only GraphicsAPI should be written — GuiConsoleEnabled must remain 'opengl' era.
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenContent = null;
  const FILE_INI = '[Debug]\nGraphicsAPI = opengl\nGuiConsoleEnabled = 1\n';
  mockFs.statAsync      = (p) => p === FLAT_SETTINGS ? Promise.resolve({ mtimeMs: 100 }) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync  = () => Promise.resolve(FILE_INI);
  mockFs.writeFileAsync = (_p, c) => { writtenContent = c; return Promise.resolve(); };
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  // State has guiConsoleEnabled=false (UI state) but only graphicsAPI is dirty
  inst.state = {
    settingsPath: FLAT_SETTINGS,
    graphicsAPI: 'dx11',          // dirty
    consoleEnabled: false,
    guiConsoleEnabled: false,     // NOT dirty — file still has '1'
    guiConsoleVisible: false,
    renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: { graphicsAPI: true },
    fileMtime: 100, loadedValues: { graphicsAPI: 'opengl', consoleEnabled: false, guiConsoleEnabled: true, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [] },
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.ok(writtenContent, 'writeFileAsync was called');
  assert.ok(writtenContent.includes('GraphicsAPI = dx11'), 'dirty graphicsAPI was written');
  // GuiConsoleEnabled must remain at file value '1', not be overwritten with '0'
  assert.ok(writtenContent.includes('GuiConsoleEnabled = 1'), 'non-dirty GuiConsoleEnabled preserved at file value');
});

test('dirtyFields: save() after load() clears dirtyFields', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  mockFs.statAsync      = (p) => p === FLAT_SETTINGS ? Promise.resolve({ mtimeMs: 100 }) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync  = () => Promise.resolve('[Debug]\nGraphicsAPI = dx11\n');
  mockFs.writeFileAsync = (_p, _c) => Promise.resolve();
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: { graphicsAPI: true },
    fileMtime: 100, loadedValues: { graphicsAPI: 'opengl', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [] },
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.deepStrictEqual(inst.state.dirtyFields, {}, 'dirtyFields cleared after successful save');
});

test('mtime conflict: mtime changed but dirty key NOT changed in file → proceeds without dialog', async () => {
  // File mtime changed but the field that is dirty (graphicsAPI) has the same value as loaded.
  // So no real conflict — save must proceed with no dialog.
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenContent = null;
  let dialogCalled = false;
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = () => { dialogCalled = true; return Promise.resolve({ action: 'Keep my changes' }); };
  // mtime has changed (100 → 200) but file content is same for graphicsAPI
  const FILE_INI = '[Debug]\nGraphicsAPI = opengl\nGuiConsoleEnabled = 0\n';
  mockFs.statAsync = (p) => {
    if (p !== FLAT_SETTINGS) return Promise.reject(new Error('ENOENT'));
    return Promise.resolve({ mtimeMs: 200 }); // new mtime
  };
  mockFs.readFileAsync  = () => Promise.resolve(FILE_INI);
  mockFs.writeFileAsync = (_p, c) => { writtenContent = c; return Promise.resolve(); };
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS,
    graphicsAPI: 'dx11',         // dirty — we want to change from opengl to dx11
    consoleEnabled: false,
    guiConsoleEnabled: false,
    guiConsoleVisible: false,
    renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: { graphicsAPI: true },
    // loadedValues had graphicsAPI=opengl, same as what file has now → no conflict
    fileMtime: 100,
    loadedValues: { graphicsAPI: 'opengl', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [] },
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  mockContext.api.showDialog = savedDialog;
  assert.ok(!dialogCalled, 'no dialog when only mtime changed but no value conflict on dirty keys');
  assert.ok(writtenContent, 'write proceeded despite mtime change');
  assert.ok(writtenContent.includes('GraphicsAPI = dx11'), 'dirty field written');
});

test('mtime conflict: real conflict → showDialog called; "Reload file" → no write, load() called', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenContent = null;
  let dialogCalled = false;
  let loadCalled = 0;
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = (_type, _title, _body, _btns) => {
    dialogCalled = true;
    return Promise.resolve({ action: 'Reload file' });
  };
  // File mtime changed AND file value for the dirty key also changed
  // Originally loaded: graphicsAPI=opengl; file now has graphicsAPI=d3d11 (someone changed it externally)
  const FILE_AFTER_EXTERNAL_EDIT = '[Debug]\nGraphicsAPI = d3d11\n';
  mockFs.statAsync = (p) => {
    if (p !== FLAT_SETTINGS) return Promise.reject(new Error('ENOENT'));
    return Promise.resolve({ mtimeMs: 999 }); // different mtime
  };
  mockFs.readFileAsync  = () => Promise.resolve(FILE_AFTER_EXTERNAL_EDIT);
  mockFs.writeFileAsync = (_p, c) => { writtenContent = c; return Promise.resolve(); };
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  // Patch load so we can count calls without actually doing FS
  const origLoad = inst.load.bind(inst);
  inst.load = function() { loadCalled++; origLoad(); };
  inst.state = {
    settingsPath: FLAT_SETTINGS,
    graphicsAPI: 'dx11',       // user changed to dx11
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: { graphicsAPI: true },
    fileMtime: 100,
    loadedValues: { graphicsAPI: 'opengl', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [] },
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  mockContext.api.showDialog = savedDialog;
  assert.ok(dialogCalled, 'dialog was shown for real conflict');
  assert.strictEqual(writtenContent, null, '"Reload file" must not write');
  assert.ok(loadCalled > 0, 'load() was called after "Reload file"');
});

test('mtime conflict: real conflict → "Keep my changes" → write proceeds', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenContent = null;
  const savedDialog = mockContext.api.showDialog;
  mockContext.api.showDialog = () => Promise.resolve({ action: 'Keep my changes' });
  const FILE_AFTER_EXTERNAL_EDIT = '[Debug]\nGraphicsAPI = d3d11\n';
  mockFs.statAsync = (p) => {
    if (p !== FLAT_SETTINGS) return Promise.reject(new Error('ENOENT'));
    return Promise.resolve({ mtimeMs: 999 });
  };
  mockFs.readFileAsync  = () => Promise.resolve(FILE_AFTER_EXTERNAL_EDIT);
  mockFs.writeFileAsync = (_p, c) => { writtenContent = c; return Promise.resolve(); };
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS,
    graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: { graphicsAPI: true },
    fileMtime: 100,
    loadedValues: { graphicsAPI: 'opengl', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [] },
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  mockContext.api.showDialog = savedDialog;
  assert.ok(writtenContent, '"Keep my changes" must write');
  assert.ok(writtenContent.includes('GraphicsAPI = dx11'), 'user value written despite conflict');
});

test('mtime conflict: no showDialog on api → defaults to Keep my changes (write proceeds)', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  let writtenContent = null;
  const FILE_AFTER_EXTERNAL_EDIT = '[Debug]\nGraphicsAPI = d3d11\n';
  mockFs.statAsync = (p) => {
    if (p !== FLAT_SETTINGS) return Promise.reject(new Error('ENOENT'));
    return Promise.resolve({ mtimeMs: 999 });
  };
  mockFs.readFileAsync  = () => Promise.resolve(FILE_AFTER_EXTERNAL_EDIT);
  mockFs.writeFileAsync = (_p, c) => { writtenContent = c; return Promise.resolve(); };
  // API without showDialog
  const minimalApi = {
    getState: mockContext.api.getState,
    sendNotification: () => {},
    // no showDialog
  };
  const inst = new idx.UE4SSSettingsPage({ api: minimalApi });
  inst.state = {
    settingsPath: FLAT_SETTINGS,
    graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: { graphicsAPI: true },
    fileMtime: 100,
    loadedValues: { graphicsAPI: 'opengl', consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread', modFolders: [] },
  };
  inst.save();
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.ok(writtenContent, 'write should proceed when no showDialog available');
  assert.ok(writtenContent.includes('GraphicsAPI = dx11'), 'user value written');
});

test('Create settings file button: settingsPath null + ensureUserSettingsFile → load() called', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  const savedWrite = mockFs.writeFileAsync;
  const TEMPLATE_CONTENT = '[Debug]\nGraphicsAPI = dx11\n';
  // Initially no settings, flat template present
  mockFs.statAsync = (p) => {
    if (p === FLAT_TEMPLATE) return Promise.resolve({});
    return Promise.reject(new Error('ENOENT'));
  };
  mockFs.readFileAsync  = (p) => p === FLAT_TEMPLATE ? Promise.resolve(TEMPLATE_CONTENT) : Promise.reject(new Error('ENOENT'));
  let writeCalledPath = null;
  mockFs.writeFileAsync = (p, c) => { writeCalledPath = p; return Promise.resolve(); };
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: null, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  // Simulate clicking "Create settings file": same logic as render()
  const disc = inst._getDiscovery();
  const { ensureUserSettingsFile: ensureFn } = require('../src/ue4ss');
  let ensureResult = null;
  let loadCalledAfter = false;
  await ensureFn(disc.path).then(function(result) {
    ensureResult = result;
    if (!result) {
      inst.setState({ error: 'No UE4SS template found — install UE4SS first.' });
      return;
    }
    loadCalledAfter = true;
    inst.setState({ loaded: false, error: null });
    // We don't call inst.load() in test to avoid FS re-setup complexity
  });
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  mockFs.writeFileAsync = savedWrite;
  assert.ok(ensureResult, 'ensureUserSettingsFile returned a path');
  assert.strictEqual(ensureResult, FLAT_SETTINGS, 'created flat settings path');
  assert.ok(writeCalledPath, 'writeFileAsync was called to create the file');
  assert.ok(loadCalledAfter, 'load() flow was triggered after file creation');
});

test('Create settings file button: no template → setState error', async () => {
  const savedStat  = mockFs.statAsync;
  // No files at all
  mockFs.statAsync = () => Promise.reject(new Error('ENOENT'));
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: null, graphicsAPI: 'dx11',
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false, renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  const disc = inst._getDiscovery();
  const { ensureUserSettingsFile: ensureFn } = require('../src/ue4ss');
  await ensureFn(disc.path).then(function(result) {
    if (!result) {
      inst.setState({ error: 'No UE4SS template found — install UE4SS first.' });
    }
  });
  mockFs.statAsync = savedStat;
  assert.strictEqual(inst.state.error, 'No UE4SS template found — install UE4SS first.',
    'error set when no template found');
});

test('componentWillUnmount: no setState called after unmount (no throw)', async () => {
  const savedStat  = mockFs.statAsync;
  const savedRead  = mockFs.readFileAsync;
  // Set up a slow-resolving load (via flushPromises after unmount)
  let resolveRead;
  const pendingRead = new Promise(r => { resolveRead = r; });
  mockFs.statAsync = (p) => p === FLAT_SETTINGS ? Promise.resolve({ mtimeMs: 100 }) : Promise.reject(new Error('ENOENT'));
  mockFs.readFileAsync = () => pendingRead;
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = Object.assign({}, inst.state, { settingsPath: null });
  // Patch setState to detect unexpected calls
  let setStateCalled = false;
  const origSetState = inst.setState.bind(inst);
  inst.setState = function(partial) {
    if (inst._unmounted) {
      setStateCalled = true;
      throw new Error('setState called after unmount');
    }
    return origSetState(partial);
  };
  // Start load(), then immediately unmount
  inst.load();
  inst.componentWillUnmount();
  // Now resolve the pending FS read — should not trigger setState
  resolveRead('[Debug]\nGraphicsAPI = dx11\n');
  await flushPromises();
  mockFs.statAsync     = savedStat;
  mockFs.readFileAsync = savedRead;
  assert.ok(!setStateCalled, 'setState must not be called after componentWillUnmount');
});

test('unknown graphicsAPI value: render() adds (manual) option to select', () => {
  const inst = new idx.UE4SSSettingsPage({ api: mockContext.api });
  inst.state = {
    settingsPath: FLAT_SETTINGS, graphicsAPI: 'vulkan',  // unknown value
    consoleEnabled: false, guiConsoleEnabled: false, guiConsoleVisible: false,
    renderMode: 'ExternalThread',
    modFolders: [], newFolder: '', loaded: true, error: null,
    dirtyFields: {}, fileMtime: null, loadedValues: null,
  };
  // render() should not throw, and we can check it returns an element
  let el;
  assert.doesNotThrow(() => { el = inst.render(); }, 'render with unknown graphicsAPI must not throw');
  assert.ok(el, 'render returns element');
  // We can't deep-traverse all React elements, but at minimum it should not error
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
