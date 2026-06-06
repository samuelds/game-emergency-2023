/**
 * Offline unit tests for the EMERGENCY 2023 Vortex extension.
 * Run with: node test/index.test.js
 * No external dependencies — uses Module._load override to mock 'vortex-api'.
 */
'use strict';

const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------------------
// Mock vortex-api before requiring index.js
// ---------------------------------------------------------------------------

const mockLog = () => {};

const mockFs = {
  ensureDirWritableAsync: () => Promise.resolve(),
  statAsync: () => Promise.resolve(),
};

const mockUtil = {
  GameStoreHelper: {
    findByAppId: () => Promise.resolve({ gamePath: '/game' }),
  },
  toPromise: (fn) => new Promise((resolve, reject) => fn((err, val) => err ? reject(err) : resolve(val))),
};

const originalLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  if (request === 'vortex-api') {
    return { fs: mockFs, util: mockUtil, log: mockLog };
  }
  return originalLoad(request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Load the extension
// ---------------------------------------------------------------------------

const ext = require('../index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log('  ✓', msg);
    passed++;
  } else {
    console.error('  ✗', msg);
    failed++;
  }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    console.log('  ✓', msg);
    passed++;
  } else {
    console.error('  ✗', msg, '— expected', JSON.stringify(expected), 'got', JSON.stringify(actual));
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Build a mock context and invoke main()
// ---------------------------------------------------------------------------

let capturedGame = null;
let capturedModTypes = [];
let capturedInstallers = [];

// Shared mock state used by injector modType getPath
const mockState = {
  settings: {
    gameMode: {
      discovered: {
        emergency2023: { path: '/game' },
      },
    },
  },
};

const mockContext = {
  api: {
    getState: () => mockState,
    sendNotification: () => {},
    events: { emit: () => {} },
  },
  registerGame(opts) { capturedGame = opts; },
  registerModType(id, priority, isSupported, getPath, test, opts) {
    capturedModTypes.push({ id, priority, isSupported, getPath, test, opts });
  },
  registerInstaller(id, priority, tester, installer) {
    capturedInstallers.push({ id, priority, tester, installer });
  },
};

const result = ext.default(mockContext);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

console.log('\n=== registerGame ===');
assert(capturedGame !== null, 'registerGame was called');
assertEq(capturedGame.id, 'emergency2023', 'id === emergency2023');
assertEq(capturedGame.executable(), 'EMERGENCY.exe', 'executable() === EMERGENCY.exe');
assert(capturedGame.requiredFiles.includes('EMERGENCY.exe'), 'requiredFiles includes EMERGENCY.exe');
assertEq(capturedGame.mergeMods, true, 'mergeMods === true');
assertEq(capturedGame.details.steamAppId, 850170, 'details.steamAppId === 850170');

console.log('\n=== registerModType ===');
const injectorModType = capturedModTypes.find(m => m.id === UE4SS_INJECTOR_MODTYPE_ID());
assert(injectorModType !== undefined, 'registerModType called with id emergency2023-ue4ss-injector');
assert(injectorModType.isSupported('emergency2023'), 'isSupported(emergency2023) === true');
assert(!injectorModType.isSupported('otherwgame'), 'isSupported(othergame) === false');
const expectedBinPath = path.join('/game', 'EMERGENCY', 'Binaries', 'Win64');
const actualBinPath = injectorModType.getPath({ id: 'emergency2023' });
assertEq(actualBinPath, expectedBinPath, 'getPath returns <root>/EMERGENCY/Binaries/Win64');

console.log('\n=== registerInstaller ===');
const installer = capturedInstallers.find(i => i.id === 'emergency2023-ue4ss');
assert(installer !== undefined, 'registerInstaller called with id emergency2023-ue4ss');

console.log('\n=== testUE4SSInjector ===');
const { testUE4SSInjector, installUE4SSInjector, UE4SS_ASSET_PATTERN } = ext;

// Use the captured tester (should be the same function, but test both)
const tester = installer.tester;

Promise.all([
  tester(['foo/ue4ss/UE4SS-settings.ini', 'dwmapi.dll'], 'emergency2023')
    .then(r => {
      assert(r.supported === true, 'tester: correct files + gameId → supported:true');
    }),
  tester(['foo/ue4ss/UE4SS-settings.ini', 'dwmapi.dll'], 'wronggame')
    .then(r => {
      assert(r.supported === false, 'tester: correct files + wrong gameId → supported:false');
    }),
  tester(['dwmapi.dll', 'ue4ss/Mods/'], 'emergency2023')
    .then(r => {
      assert(r.supported === false, 'tester: missing UE4SS-settings.ini → supported:false');
    }),
]).then(() => {
  console.log('\n=== installUE4SSInjector ===');
  return installer.installer(['dwmapi.dll', 'ue4ss/UE4SS-settings.ini', 'ue4ss/Mods/']);
}).then(res => {
  const copies = res.instructions.filter(i => i.type === 'copy');
  const setmodtype = res.instructions.filter(i => i.type === 'setmodtype');

  // 'ue4ss/Mods/' ends with path.sep (or '/') — should be dropped
  const dirEntry = 'ue4ss/Mods/';
  const hasDirEntry = copies.some(i => i.source === dirEntry);
  assert(!hasDirEntry, 'installUE4SSInjector: directory entries dropped');
  assertEq(copies.length, 2, 'installUE4SSInjector: 2 copy instructions (dwmapi.dll + UE4SS-settings.ini)');
  assertEq(setmodtype.length, 1, 'installUE4SSInjector: 1 setmodtype instruction');
  assertEq(setmodtype[0].value, 'emergency2023-ue4ss-injector', 'setmodtype.value === emergency2023-ue4ss-injector');

  console.log('\n=== UE4SS_ASSET_PATTERN ===');
  assert(UE4SS_ASSET_PATTERN.test('UE4SS_v3.0.1.zip'), 'matches UE4SS_v3.0.1.zip');
  assert(UE4SS_ASSET_PATTERN.test('UE4SS_v3.0.1.ZIP'), 'matches case-insensitive UE4SS_v3.0.1.ZIP');
  assert(!UE4SS_ASSET_PATTERN.test('zDEV-UE4SS_v3.0.1.zip'), 'rejects zDEV-UE4SS_v3.0.1.zip');
  assert(!UE4SS_ASSET_PATTERN.test('zCustomGameConfigs.zip'), 'rejects zCustomGameConfigs.zip');
  assert(!UE4SS_ASSET_PATTERN.test('zMapGenBP.zip'), 'rejects zMapGenBP.zip');

  // Verify the literal pattern is present in the source file text
  const fs_node = require('fs');
  const src = fs_node.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert(src.includes('/^UE4SS_v[\\d.]+\\.zip$/i'), 'index.js source contains the literal regex /^UE4SS_v[\\d.]+\\.zip$/i');

  // main() return value
  console.log('\n=== main() return value ===');
  assertEq(result, true, 'main() returns true');

}).then(() => {
  console.log('\n-----------------------------');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch(err => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Helper: re-derive the modType id from the source to keep test DRY
// ---------------------------------------------------------------------------
function UE4SS_INJECTOR_MODTYPE_ID() {
  return 'emergency2023-ue4ss-injector';
}
