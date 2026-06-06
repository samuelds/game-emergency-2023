/*
 * Vortex game extension — EMERGENCY 2023
 * ----------------------------------------------------------------------------
 * Makes EMERGENCY 2023 a Vortex-managed game so any UE4SS mod installs in one click. Registers the game, finds it via Steam, and deploys mods
 * into the UE4SS Mods folder.
 *
 * Grounded on the official Vortex docs (package/test/develop/submit wiki):
 *   - files info.json + gameart.png + index.js + src/ at archive top-level
 *   - paths MUST be relative (no absolute drive letters)
 *   - create referenced dirs via fs.ensureDirWritableAsync
 *
 * LIVE-RESOLVED via the in-game MCP (KismetSystemLibrary path query, 2026-06-06):
 *   - Steam install root  : .../steamapps/common/EMERGENCY/   (what findByAppId returns)
 *   - UE project folder   : EMERGENCY  (so the project lives at <root>/EMERGENCY/)
 *   - UE4SS layout        : experimental build uses ue4ss/ SUBFOLDER (dwmapi.dll at Win64 root,
 *                           UE4SS.dll + UE4SS-settings.ini + Mods/ inside ue4ss/). 3.0.1 stable crashes.
 *   - UE4SS mod path      : EMERGENCY/Binaries/Win64/ue4ss/Mods  (relative to root)
 *   - executable          : EMERGENCY.exe  (root launcher Steam runs; live-listed) ✓ G1 resolved
 *     (the UE shipping binary EMERGENCY/Binaries/Win64/EMERGENCY-Win64-Shipping.exe also exists)
 *
 * UE4SS AUTO-INSTALL (Palworld pattern, adapted for plain JS — added 2026-06-06):
 *   - Injector modType 'emergency2023-ue4ss-injector' deploys to EMERGENCY/Binaries/Win64.
 *   - Installer requires dwmapi.dll AND UE4SS-settings.ini (basename, flat or nested);
 *     rejects archives with path traversal or absolute paths.
 *   - At install time the UE4SS-settings.ini is patched to [Debug] GraphicsAPI=dx11
 *     (default is opengl which breaks EMERGENCY 2023 on Windows).
 *   - setup uses a robust fail-safe guard (isUE4SSInstalled) that checks multiple markers
 *     (flat + nested) so it NEVER clobbers an existing install.
 *   - Download URL is host-allowlisted (github.com / objects.githubusercontent.com),
 *     https-only, and the asset name is re-validated before the URL is trusted.
 *   - An explicit consent dialog names the release version and destination folder before
 *     any download is started; user can cancel without side effects.
 *   - Grounded: repo UE4SS-RE/RE-UE4SS, tag experimental-latest (rolling), dest Binaries/Win64.
 *   - NOTE: 3.0.1 stable crashes EMERGENCY 2023 (UE5.3.2); experimental build required.
 *   - A Vortex settings page (src/settings-page.js) lets users edit all [Debug] keys.
 *
 * ALL paths live-resolved via the in-game MCP (KismetSystemLibrary + io.popen dir, 2026-06-06).
 * Only remaining step = a real Vortex install/deploy/purge test on Windows.
 * Steam App ID 850170 is confirmed (KB / store).
 */
'use strict';
const path = require('path');
const { fs, util } = require('vortex-api');
let reactBootstrap = null;
try { reactBootstrap = require('react-bootstrap'); } catch (_) {}

const {
  GAME_ID, STEAM_APP_ID, EXECUTABLE, BINARIES_WIN64, MOD_PATH, UE4SS_INJECTOR_MODTYPE, UE4SS_ASSET_PATTERN,
} = require('./src/constants');
const { getIniValue, setIniValue, getIniListValues, setIniListValues } = require('./src/ini');
const {
  isSafeRelPath, isTrustedUE4SSAsset,
  testUE4SSInjector, installUE4SSInjector,
  fetchLatestUE4SS, downloadUE4SS,
  isUE4SSInstalled, findSettingsFile, findGame,
} = require('./src/ue4ss');
const UE4SSSettingsPage = require('./src/settings-page');

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

  // Installer: recognises UE4SS archives (dwmapi.dll + UE4SS-settings.ini, flat or nested).
  context.registerInstaller('emergency2023-ue4ss', 25, testUE4SSInjector, installUE4SSInjector);

  // B2 — setup: ensure Mods dir, then use robust multi-marker guard before auto-installing.
  const prepareForModding = (discovery) =>
    fs.ensureDirWritableAsync(path.join(discovery.path, MOD_PATH))
      .then(() => isUE4SSInstalled(discovery.path))
      .then((installed) => { if (!installed) return downloadUE4SS(context.api); });

  context.registerGame({
    id: GAME_ID,
    name: 'EMERGENCY 2023',
    mergeMods: true,
    logo: 'gameart.png',
    queryPath: findGame,
    queryModPath: () => MOD_PATH,
    executable: () => EXECUTABLE,
    requiredFiles: [EXECUTABLE],
    setup: prepareForModding,
    environment: { SteamAPPId: STEAM_APP_ID },
    details: {
      steamAppId: parseInt(STEAM_APP_ID, 10),
      nexusPageId: 'emergency2023',
    },
  });

  // E4 — settings page: only register if react-bootstrap is available and game is discovered.
  if (reactBootstrap) {
    context.registerSettings(
      'UE4SS',
      UE4SSSettingsPage,
      () => ({ api: context.api }),
      () => {
        const st   = context.api.getState();
        const disc = st && st.settings && st.settings.gameMode &&
                     st.settings.gameMode.discovered && st.settings.gameMode.discovered[GAME_ID];
        return !!(disc && disc.path);
      },
      100,
    );
  }

  return true;
}

module.exports = {
  default: main,
  testUE4SSInjector,
  installUE4SSInjector,
  UE4SS_ASSET_PATTERN,
  fetchLatestUE4SS,
  downloadUE4SS,
  isTrustedUE4SSAsset,
  isSafeRelPath,
  getIniValue,
  setIniValue,
  getIniListValues,
  setIniListValues,
  isUE4SSInstalled,
  findSettingsFile,
  UE4SSSettingsPage,
};
