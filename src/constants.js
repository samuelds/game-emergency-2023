'use strict';
const path = require('path');

const GAME_ID             = 'emergency2023';
const STEAM_APP_ID        = '850170';
const EXECUTABLE          = 'EMERGENCY.exe';
const PROJECT             = 'EMERGENCY';
const BINARIES_WIN64      = path.join('EMERGENCY', 'Binaries', 'Win64');
// Nested layout — experimental build uses ue4ss/ subfolder.
const MOD_PATH            = path.join(BINARIES_WIN64, 'ue4ss', 'Mods');
const UE4SS_INJECTOR_MODTYPE = 'emergency2023-ue4ss-injector';
const UE4SS_SETTINGS_FILE = 'UE4SS-settings.ini';
const UE4SS_GITHUB        = 'https://api.github.com/repos/UE4SS-RE/RE-UE4SS';
// Matches stable (UE4SS_v3.0.1.zip) AND experimental (UE4SS_v3.0.1-953-gb872ad11.zip); rejects z* variants.
const UE4SS_ASSET_PATTERN = /^UE4SS_v[\d.]+(?:-\d+-g[0-9a-f]+)?\.zip$/i;

module.exports = {
  GAME_ID, STEAM_APP_ID, EXECUTABLE, PROJECT,
  BINARIES_WIN64, MOD_PATH, UE4SS_INJECTOR_MODTYPE,
  UE4SS_SETTINGS_FILE, UE4SS_GITHUB, UE4SS_ASSET_PATTERN,
};
