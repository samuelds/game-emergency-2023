'use strict';
const path  = require('path');
const https = require('https');
const { fs, util, log } = require('vortex-api');
const {
  GAME_ID, STEAM_APP_ID, BINARIES_WIN64, MOD_PATH,
  UE4SS_INJECTOR_MODTYPE, UE4SS_SETTINGS_FILE, UE4SS_SETTINGS_TEMPLATE,
  UE4SS_GITHUB, UE4SS_ASSET_PATTERN,
} = require('./constants');
const { setIniValue } = require('./ini');

// ---------------------------------------------------------------------------
// H3 — Path safety guard
// ---------------------------------------------------------------------------

function isSafeRelPath(f) {
  if (/^([a-zA-Z]:|[\\/])/.test(f)) return false;
  return !f.replace(/\\/g, '/').split('/').some(seg => seg === '..');
}

// ---------------------------------------------------------------------------
// H1 — Download URL trust check
// ---------------------------------------------------------------------------

function isTrustedUE4SSAsset(asset) {
  if (!asset || !asset.browser_download_url || !UE4SS_ASSET_PATTERN.test(asset.name)) return false;
  let u;
  try { u = new URL(asset.browser_download_url); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  const ALLOWED = ['github.com', 'objects.githubusercontent.com'];
  return ALLOWED.includes(u.hostname);
}

// ---------------------------------------------------------------------------
// A2 — UE4SS installer
// The archive INI is installed as UE4SS-settings.default.ini (template, patched
// to dx11 + GuiConsoleEnabled=0); the live UE4SS-settings.ini is an UNMANAGED
// user file created from the template after deploy only if missing — user edits
// are never overwritten.
// ---------------------------------------------------------------------------

function testUE4SSInjector(files, gameId) {
  if (gameId !== GAME_ID) return Promise.resolve({ supported: false, requiredFiles: [] });
  const norm        = files.map(f => f.replace(/\\/g, '/').toLowerCase());
  const hasDwmapi   = norm.some(f => f === 'dwmapi.dll' || f.endsWith('/dwmapi.dll'));
  const hasSettings = norm.some(f => f === 'ue4ss-settings.ini' || f.endsWith('/ue4ss-settings.ini'));
  const allSafe     = files.every(isSafeRelPath);
  return Promise.resolve({ supported: hasDwmapi && hasSettings && allSafe, requiredFiles: [] });
}

function installUE4SSInjector(files, destinationPath) {
  const filtered = files.filter(f => !f.endsWith(path.sep) && isSafeRelPath(f));
  return Promise.all(filtered.map(f => {
    const base = path.basename(f).toLowerCase();
    if (base === 'ue4ss-settings.ini') {
      const dir = path.dirname(f);
      const templateDest = (dir === '.') ? UE4SS_SETTINGS_TEMPLATE : path.join(dir, UE4SS_SETTINGS_TEMPLATE);
      return fs.readFileAsync(path.join(destinationPath, f), 'utf8')
        .then(content => {
          let patched = setIniValue(content, 'Debug', 'GraphicsAPI', 'dx11');
          patched = setIniValue(patched, 'Debug', 'GuiConsoleEnabled', '0');
          return { type: 'generatefile', data: Buffer.from(patched, 'utf8'), destination: templateDest };
        })
        .catch(() => ({ type: 'copy', source: f, destination: templateDest }));
    }
    return Promise.resolve({ type: 'copy', source: f, destination: f });
  })).then(instructions => {
    instructions.push({ type: 'setmodtype', value: UE4SS_INJECTOR_MODTYPE });
    return { instructions };
  });
}

// ---------------------------------------------------------------------------
// GitHub release lookup
// ---------------------------------------------------------------------------

function fetchLatestUE4SS() {
  return new Promise((resolve) => {
    const opts = {
      headers: {
        'User-Agent': 'Vortex-EMERGENCY2023',
        'Accept': 'application/vnd.github+json',
      },
    };
    const req = https.get(UE4SS_GITHUB + '/releases/tags/experimental-latest', opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          log('warn', 'UE4SS release lookup failed', { status: res.statusCode });
          return resolve(null);
        }
        try {
          const rel   = JSON.parse(body);
          const asset = (rel.assets || []).find(a => UE4SS_ASSET_PATTERN.test(a.name));
          if (asset && !isTrustedUE4SSAsset(asset)) {
            log('warn', 'UE4SS asset rejected (untrusted url/name)', { name: asset.name });
            return resolve(null);
          }
          resolve(asset ? { name: asset.name, url: asset.browser_download_url, tag: rel.tag_name } : null);
        } catch (e) {
          log('warn', 'UE4SS release parse failed', { error: e.message });
          resolve(null);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); });
    req.on('error', (e) => {
      log('warn', 'UE4SS release request error', { error: e.message });
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// H2 — Download + install with consent dialog
// ---------------------------------------------------------------------------

async function downloadUE4SS(api) {
  const asset = await fetchLatestUE4SS();
  if (!asset) {
    api.sendNotification({
      id: 'ue4ss-fetch-failed',
      type: 'warning',
      title: 'Could not reach GitHub to download UE4SS',
      message: 'Check your connection, or install UE4SS manually (github.com/UE4SS-RE/RE-UE4SS, experimental build) into EMERGENCY/Binaries/Win64.',
    });
    return;
  }

  const dlgResult = await api.showDialog(
    'question',
    'Install UE4SS?',
    {
      text: 'EMERGENCY 2023 mods require UE4SS (' + asset.tag + ', experimental build — required for UE5.3.2; the 3.0.1 stable crashes this game). Vortex will download the official release from github.com/UE4SS-RE/RE-UE4SS and install it into Binaries/Win64. Continue?',
    },
    [{ label: 'Cancel' }, { label: 'Download UE4SS' }],
  );

  if (!dlgResult || dlgResult.action !== 'Download UE4SS') return;

  try {
    const dlId = await util.toPromise(cb =>
      api.events.emit('start-download', [asset.url], { game: GAME_ID }, asset.name, cb, 'never', { allowInstall: false }));
    await util.toPromise(cb =>
      api.events.emit('start-install-download', dlId, { allowAutoEnable: true }, cb));
  } catch (err) {
    log('warn', 'UE4SS auto-install failed', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// B1 — Multi-marker guard: returns false when Binaries/Win64 is absent
// ---------------------------------------------------------------------------

async function isUE4SSInstalled(root) {
  const win64 = path.join(root, BINARIES_WIN64);
  try { await fs.statAsync(win64); }
  catch (e) { return false; }
  const markers = [
    'dwmapi.dll',
    'UE4SS.dll',
    'UE4SS-settings.ini',
    UE4SS_SETTINGS_TEMPLATE,
    path.join('ue4ss', 'UE4SS-settings.ini'),
    path.join('ue4ss', UE4SS_SETTINGS_TEMPLATE),
    path.join('ue4ss', 'UE4SS.dll'),
  ];
  for (const m of markers) {
    try { await fs.statAsync(path.join(win64, m)); return true; } catch (e) {}
  }
  return false;
}

// ---------------------------------------------------------------------------
// E2 — Find settings file (flat first, then nested)
// ---------------------------------------------------------------------------

async function findSettingsFile(root) {
  const flat = path.join(root, BINARIES_WIN64, UE4SS_SETTINGS_FILE);
  try { await fs.statAsync(flat); return flat; } catch (_) {}
  const nested = path.join(root, BINARIES_WIN64, 'ue4ss', UE4SS_SETTINGS_FILE);
  try { await fs.statAsync(nested); return nested; } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// B3 — Find template file (flat first, then nested)
// ---------------------------------------------------------------------------

async function findTemplateFile(root) {
  const flat = path.join(root, BINARIES_WIN64, UE4SS_SETTINGS_TEMPLATE);
  try { await fs.statAsync(flat); return flat; } catch (_) {}
  const nested = path.join(root, BINARIES_WIN64, 'ue4ss', UE4SS_SETTINGS_TEMPLATE);
  try { await fs.statAsync(nested); return nested; } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// B3 — Ensure user settings file exists (create from template if absent)
// ---------------------------------------------------------------------------

async function ensureUserSettingsFile(root) {
  const existing = await findSettingsFile(root);
  if (existing) return existing;
  const templatePath = await findTemplateFile(root);
  if (!templatePath) return null;
  const content = await fs.readFileAsync(templatePath, 'utf8');
  const destPath = path.join(path.dirname(templatePath), UE4SS_SETTINGS_FILE);
  await fs.writeFileAsync(destPath, content, 'utf8');
  return destPath;
}

// ---------------------------------------------------------------------------
// Game path finder
// ---------------------------------------------------------------------------

function findGame() {
  return util.GameStoreHelper.findByAppId([STEAM_APP_ID])
    .then((game) => game.gamePath);
}

module.exports = {
  isSafeRelPath, isTrustedUE4SSAsset,
  testUE4SSInjector, installUE4SSInjector,
  fetchLatestUE4SS, downloadUE4SS,
  isUE4SSInstalled, findSettingsFile,
  findTemplateFile, ensureUserSettingsFile,
  findGame,
};
