/*
 * Vortex game extension — EMERGENCY 2023
 * ----------------------------------------------------------------------------
 * Makes EMERGENCY 2023 a Vortex-managed game so any UE4SS mod (e.g. em-fast-boot)
 * installs in one click. Registers the game, finds it via Steam, and deploys mods
 * into the UE4SS Mods folder.
 *
 * Grounded on the official Vortex docs (package/test/develop/submit wiki):
 *   - files info.json + gameart.png + index.js at archive top-level
 *   - paths MUST be relative (no absolute drive letters)
 *   - create referenced dirs via fs.ensureDirWritableAsync
 *
 * LIVE-RESOLVED via the in-game MCP (KismetSystemLibrary path query, 2026-06-06):
 *   - Steam install root  : .../steamapps/common/EMERGENCY/   (what findByAppId returns)
 *   - UE project folder   : EMERGENCY  (so the project lives at <root>/EMERGENCY/)
 *   - UE4SS mod path       : EMERGENCY/Binaries/Win64/ue4ss/Mods  (relative to root) ✓ G2 resolved
 *   - executable          : EMERGENCY.exe  (root launcher Steam runs; live-listed) ✓ G1 resolved
 *     (the UE shipping binary EMERGENCY/Binaries/Win64/EMERGENCY-Win64-Shipping.exe also exists)
 *
 * UE4SS AUTO-INSTALL (Palworld pattern, adapted for plain JS — added 2026-06-06):
 *   - Injector modType 'emergency2023-ue4ss-injector' deploys to EMERGENCY/Binaries/Win64
 *     (where dwmapi.dll + ue4ss/ land after extraction).
 *   - Installer detects any archive containing UE4SS-settings.ini and sets the injector modType.
 *   - setup (prepareForModding) checks the guard file
 *     EMERGENCY/Binaries/Win64/ue4ss/UE4SS-settings.ini; if absent, fetches the latest
 *     UE4SS release from https://api.github.com/repos/UE4SS-RE/RE-UE4SS and triggers
 *     a Vortex download+install of the main asset (UE4SS_v*.zip, excludes z* variants).
 *   - Grounded: repo UE4SS-RE/RE-UE4SS, asset UE4SS_v3.0.1.zip, dest Binaries/Win64,
 *     guard UE4SS-settings.ini.
 *
 * ALL paths live-resolved via the in-game MCP (KismetSystemLibrary + io.popen dir, 2026-06-06).
 * Only remaining step = a real Vortex install/deploy/purge test on Windows.
 * Steam App ID 850170 is confirmed (KB / store).
 */
const path = require('path');
const https = require('https');
const { fs, util, log } = require('vortex-api');

const GAME_ID = 'emergency2023';
const STEAM_APP_ID = '850170';

// ✓ live-resolved: the Steam launcher exe at the install root.
const EXECUTABLE = 'EMERGENCY.exe';

// UE project subfolder inside the Steam install root.
const PROJECT = 'EMERGENCY';

// ✓ live-resolved: Binaries/Win64 relative to install root — injector destination.
const BINARIES_WIN64 = path.join('EMERGENCY', 'Binaries', 'Win64');

// ✓ live-resolved: UE4SS script mods deploy here (relative to the Steam install root).
const MOD_PATH = path.join(BINARIES_WIN64, 'ue4ss', 'Mods');

// UE4SS injector modType id — deploys dwmapi.dll + ue4ss/ to Binaries/Win64.
const UE4SS_INJECTOR_MODTYPE = 'emergency2023-ue4ss-injector';

// Guard file: if present, UE4SS is already installed — skip the download.
const UE4SS_SETTINGS_FILE = 'UE4SS-settings.ini';

// GitHub API base for UE4SS releases.
const UE4SS_GITHUB = 'https://api.github.com/repos/UE4SS-RE/RE-UE4SS';

// Matches the main release zip (e.g. UE4SS_v3.0.1.zip) but NOT the z* variants.
const UE4SS_ASSET_PATTERN = /^UE4SS_v[\d.]+\.zip$/i;

// ---------------------------------------------------------------------------
// UE4SS installer: detects archives containing UE4SS-settings.ini
// ---------------------------------------------------------------------------

function testUE4SSInjector(files, gameId) {
  const supported = gameId === GAME_ID
    && files.some(f => path.basename(f).toLowerCase() === UE4SS_SETTINGS_FILE.toLowerCase());
  return Promise.resolve({ supported, requiredFiles: [] });
}

function installUE4SSInjector(files) {
  const filtered = files.filter(f => !f.endsWith(path.sep)); // drop directory entries
  const instructions = filtered.map(f => ({ type: 'copy', source: f, destination: f }));
  instructions.push({ type: 'setmodtype', value: UE4SS_INJECTOR_MODTYPE });
  return Promise.resolve({ instructions });
}

// ---------------------------------------------------------------------------
// GitHub release lookup (plain Node https, no redirects needed)
// ---------------------------------------------------------------------------

function fetchLatestUE4SS() {
  return new Promise((resolve) => {
    const opts = {
      headers: {
        'User-Agent': 'Vortex-EMERGENCY2023',
        'Accept': 'application/vnd.github+json',
      },
    };
    https.get(UE4SS_GITHUB + '/releases/latest', opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          log('warn', 'UE4SS release lookup failed', { status: res.statusCode });
          return resolve(null);
        }
        try {
          const rel = JSON.parse(body);
          const asset = (rel.assets || []).find(a => UE4SS_ASSET_PATTERN.test(a.name));
          resolve(asset ? { name: asset.name, url: asset.browser_download_url, tag: rel.tag_name } : null);
        } catch (e) {
          log('warn', 'UE4SS release parse failed', { error: e.message });
          resolve(null);
        }
      });
    }).on('error', (e) => {
      log('warn', 'UE4SS release request error', { error: e.message });
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Download + install trigger (Vortex events, like Palworld's downloadNexus
// but for a direct URL)
// ---------------------------------------------------------------------------

function downloadUE4SS(api) {
  return fetchLatestUE4SS().then((asset) => {
    if (!asset) return Promise.resolve();
    api.sendNotification({
      id: 'emergency2023-ue4ss-install',
      type: 'info',
      title: 'Installing UE4SS',
      message: asset.name + ' (' + asset.tag + ')',
    });
    return util.toPromise(cb =>
      api.events.emit('start-download', [asset.url], { game: GAME_ID }, asset.name, cb, 'never', { allowInstall: false }))
      .then(dlId => util.toPromise(cb =>
        api.events.emit('start-install-download', dlId, { allowAutoEnable: true }, cb)))
      .catch(err => { log('warn', 'UE4SS auto-install failed', { error: err.message }); });
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function main(context) {
  // Injector modType: deploys UE4SS itself (dwmapi.dll + ue4ss/) to Binaries/Win64.
  context.registerModType(
    UE4SS_INJECTOR_MODTYPE,
    25,
    (gameId) => gameId === GAME_ID,
    (game) => {
      const state = context.api.getState();
      const discovery = state.settings.gameMode.discovered[game.id];
      return path.join(discovery.path, BINARIES_WIN64);
    },
    () => Promise.resolve(false),
    { name: 'UE4SS Injector', mergeMods: true },
  );

  // Installer: recognises any archive containing UE4SS-settings.ini.
  context.registerInstaller('emergency2023-ue4ss', 25, testUE4SSInjector, installUE4SSInjector);

  // setup: ensure Lua Mods dir exists, then auto-install UE4SS if missing.
  const prepareForModding = (discovery) =>
    fs.ensureDirWritableAsync(path.join(discovery.path, MOD_PATH))
      .then(() =>
        fs.statAsync(path.join(discovery.path, BINARIES_WIN64, 'ue4ss', UE4SS_SETTINGS_FILE))
          .then(() => undefined)               // already installed → nothing to do
          .catch(() => downloadUE4SS(context.api)) // missing → auto-install
      );

  context.registerGame({
    id: GAME_ID,
    name: 'EMERGENCY 2023',
    mergeMods: true,
    logo: 'gameart.png',
    queryPath: findGame,
    queryModPath: (gamePath) => MOD_PATH,
    executable: () => EXECUTABLE,
    requiredFiles: [EXECUTABLE],
    setup: prepareForModding,
    environment: { SteamAPPId: STEAM_APP_ID },
    details: {
      steamAppId: parseInt(STEAM_APP_ID, 10),
      // nexusPageId: the Nexus game domain — used to link the game to its mod page.
      nexusPageId: 'emergency2023',
    },
  });

  return true;
}

function findGame() {
  // Steam-only detection (App ID 850170). Add other stores here if it ships elsewhere.
  return util.GameStoreHelper.findByAppId([STEAM_APP_ID])
    .then((game) => game.gamePath);
}

module.exports = { default: main, testUE4SSInjector, installUE4SSInjector, UE4SS_ASSET_PATTERN };
