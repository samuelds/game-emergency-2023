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
 *   - UE4SS FLAT layout   : UE4SS_v3.0.1.zip extracts dwmapi.dll + UE4SS-settings.ini +
 *                           Mods/ DIRECTLY into Binaries/Win64 (no ue4ss/ subfolder) ✓ live-verified
 *   - UE4SS mod path      : EMERGENCY/Binaries/Win64/Mods  (relative to root) ✓ A1 flat
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
 *   - Grounded: repo UE4SS-RE/RE-UE4SS, asset UE4SS_v3.0.1.zip, dest Binaries/Win64.
 *   - A Vortex settings page lets users change GraphicsAPI and GuiConsoleEnabled post-install.
 *
 * ALL paths live-resolved via the in-game MCP (KismetSystemLibrary + io.popen dir, 2026-06-06).
 * Only remaining step = a real Vortex install/deploy/purge test on Windows.
 * Steam App ID 850170 is confirmed (KB / store).
 */
const path = require('path');
const https = require('https');
const { fs, util, log } = require('vortex-api');
const React = require('react');
let reactBootstrap = null;
try { reactBootstrap = require('react-bootstrap'); } catch (_) {}

const GAME_ID = 'emergency2023';
const STEAM_APP_ID = '850170';

// ✓ live-resolved: the Steam launcher exe at the install root.
const EXECUTABLE = 'EMERGENCY.exe';

// UE project subfolder inside the Steam install root.
const PROJECT = 'EMERGENCY';

// ✓ live-resolved: Binaries/Win64 relative to install root — injector destination.
const BINARIES_WIN64 = path.join('EMERGENCY', 'Binaries', 'Win64');

// A1: FLAT layout — UE4SS_v3.0.1.zip puts Mods/ directly in Binaries/Win64, no ue4ss/ subfolder.
const MOD_PATH = path.join(BINARIES_WIN64, 'Mods');

// UE4SS injector modType id — deploys dwmapi.dll + Mods/ + settings to Binaries/Win64.
const UE4SS_INJECTOR_MODTYPE = 'emergency2023-ue4ss-injector';

// The UE4SS settings filename (present in both flat and legacy nested layouts).
const UE4SS_SETTINGS_FILE = 'UE4SS-settings.ini';

// GitHub API base for UE4SS releases.
const UE4SS_GITHUB = 'https://api.github.com/repos/UE4SS-RE/RE-UE4SS';

// Matches the main release zip (e.g. UE4SS_v3.0.1.zip) but NOT the z* variants.
const UE4SS_ASSET_PATTERN = /^UE4SS_v[\d.]+\.zip$/i;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Escapes a string for use inside a RegExp. */
function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Part D — Pure INI read/write helpers (TDD-tested; used by installer + settings page)
// ---------------------------------------------------------------------------

/**
 * Returns the value of `key` under `[section]`, or null.
 * Matching is case-insensitive. Commented lines (starting with ; or #) are ignored.
 */
function getIniValue(content, section, key) {
  const lines   = content.split(/\r?\n/);
  const secPat  = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const keyPat  = new RegExp('^\\s*' + escRegex(key) + '\\s*=', 'i');
  let inSection = false;
  for (const line of lines) {
    if (/^\s*[;#]/.test(line)) continue; // skip comment lines
    if (/^\s*\[/.test(line) && !/^\s*[;#]/.test(line)) {
      inSection = secPat.test(line);
      continue;
    }
    if (inSection && keyPat.test(line)) {
      return line.slice(line.indexOf('=') + 1).trim();
    }
  }
  return null;
}

/**
 * Returns new INI content with `[section] key = value` set, preserving all
 * other lines, comments, and spacing style ("Key = value" vs "Key=value").
 *
 * Strategy:
 *  - Key exists  → replace value in-place, keep surrounding spaces.
 *  - Section exists, key absent → insert line at end of section.
 *  - Section absent → append "\n[section]\nkey = value".
 */
function setIniValue(content, section, key, value) {
  const lines   = content.split(/\r?\n/);
  const secPat  = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const keyPat  = new RegExp('^\\s*' + escRegex(key) + '\\s*=', 'i');

  let inSection    = false;
  let sectionFound = false;
  let keyReplaced  = false;
  let insertPos    = -1; // last line index inside target section

  for (let i = 0; i < lines.length; i++) {
    const line      = lines[i];
    const isComment = /^\s*[;#]/.test(line);
    const isHeader  = !isComment && /^\s*\[/.test(line);

    if (isHeader) {
      if (inSection && !keyReplaced) {
        // End of section reached without finding key — insert here (before next header).
        lines.splice(i, 0, key + ' = ' + value);
        keyReplaced = true;
        break;
      }
      inSection = secPat.test(line);
      if (inSection) { sectionFound = true; insertPos = i; }
      continue;
    }

    if (inSection) {
      insertPos = i; // track last line index we saw inside this section
      if (!isComment && keyPat.test(line)) {
        // Replace value while preserving key name and spacing around '='.
        const eqIdx      = line.indexOf('=');
        const before     = line.slice(0, eqIdx); // key name + leading space before '='
        const spaceAfter = (eqIdx + 1 < line.length && line[eqIdx + 1] === ' ') ? ' ' : '';
        lines[i]    = before + '=' + spaceAfter + value;
        keyReplaced = true;
        break;
      }
    }
  }

  if (!keyReplaced) {
    if (sectionFound) {
      // Section is at the end of the file — append after its last line.
      lines.splice(insertPos + 1, 0, key + ' = ' + value);
    } else {
      // Section not present — append a new section block.
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', '[' + section + ']', key + ' = ' + value);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Part G — INI list-value helpers (TDD-tested; used by settings page for
//          [Overrides] +ModsFolderPaths)
// ---------------------------------------------------------------------------

/**
 * Returns an array of values from every `+<key> = <value>` line under [section].
 * Case-insensitive section + key; comment lines (`;`/`#`) are ignored.
 * Returns [] if the section or key is absent.
 */
function getIniListValues(content, section, key) {
  const lines   = content.split(/\r?\n/);
  const secPat  = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const addPat  = new RegExp('^\\s*\\+\\s*' + escRegex(key) + '\\s*=(.*)', 'i');
  let inSection = false;
  const result  = [];
  for (const line of lines) {
    if (/^\s*[;#]/.test(line)) continue;
    if (/^\s*\[/.test(line)) { inSection = secPat.test(line); continue; }
    if (inSection) {
      const m = line.match(addPat);
      if (m) result.push(m[1].trim());
    }
  }
  return result;
}

/**
 * Returns new INI content where ALL existing `+<key>` and `-<key>` lines under
 * [section] are removed, and one `+<key> = <value>` line per entry in `valuesArray`
 * is inserted at the end of [section] (after the last non-blank line, before the next
 * [header]).  Everything else — comments, other keys, other sections — is preserved.
 *
 * If [section] doesn't exist and valuesArray is non-empty, the section is appended.
 * If valuesArray is empty, the existing +/-<key> lines are simply removed.
 */
function setIniListValues(content, section, key, valuesArray) {
  const lines      = content.split(/\r?\n/);
  const secPat     = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const listKeyPat = new RegExp('^\\s*[+-]\\s*' + escRegex(key) + '\\s*=', 'i');

  let inSection       = false;
  let sectionFound    = false;
  let sectionEndIdx   = -1; // insert-before position in filtered (after last non-blank line)
  let lastContentIdx  = -1; // index of last non-blank pushed line while in section

  const filtered = [];

  for (let i = 0; i < lines.length; i++) {
    const line      = lines[i];
    const isComment = /^\s*[;#]/.test(line);
    const isHeader  = !isComment && /^\s*\[/.test(line);

    if (isHeader) {
      if (inSection) {
        // End of target section: insertion point = just after last non-blank content
        sectionEndIdx = lastContentIdx >= 0 ? lastContentIdx + 1 : filtered.length;
      }
      inSection = secPat.test(line);
      if (inSection) { sectionFound = true; lastContentIdx = -1; }
      filtered.push(line);
      continue;
    }

    // Remove existing +key / -key lines from the target section
    if (inSection && !isComment && listKeyPat.test(line)) continue;

    // Track last non-blank pushed line inside the section (comments included)
    if (inSection && line.trim() !== '') lastContentIdx = filtered.length;
    filtered.push(line);
  }

  // Section ends at EOF
  if (inSection) {
    sectionEndIdx = lastContentIdx >= 0 ? lastContentIdx + 1 : filtered.length;
  }

  if (sectionFound) {
    // Insert new +key lines at computed position
    filtered.splice(sectionEndIdx, 0, ...valuesArray.map(v => '+' + key + ' = ' + v));
  } else if (valuesArray.length > 0) {
    // Append new section block
    while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();
    filtered.push('', '[' + section + ']');
    for (const v of valuesArray) filtered.push('+' + key + ' = ' + v);
  }

  return filtered.join('\n');
}

// ---------------------------------------------------------------------------
// H3 — Path safety guard (used by installer + tester)
// ---------------------------------------------------------------------------

/**
 * Returns false if `f` is an absolute path (drive letter or leading slash) or
 * contains a path-traversal segment (../).  All relative non-traversal paths pass.
 */
function isSafeRelPath(f) {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(f)) return false; // drive letter or absolute
  return !f.replace(/\\/g, '/').split('/').some(seg => seg === '..');
}

// ---------------------------------------------------------------------------
// H1 — Download URL trust check
// ---------------------------------------------------------------------------

/**
 * Returns true only when:
 *  - asset name matches UE4SS_ASSET_PATTERN (re-validates against sneaky renames)
 *  - download URL is https://
 *  - download hostname is in the explicit allowlist
 */
function isTrustedUE4SSAsset(asset) {
  if (!asset || !asset.browser_download_url || !UE4SS_ASSET_PATTERN.test(asset.name)) return false;
  let u;
  try { u = new URL(asset.browser_download_url); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  const ALLOWED = ['github.com', 'objects.githubusercontent.com'];
  return ALLOWED.includes(u.hostname);
}

// ---------------------------------------------------------------------------
// A2 — UE4SS installer: flat-aware, requires dwmapi.dll + UE4SS-settings.ini
// ---------------------------------------------------------------------------

/**
 * Tester: supports any archive that has BOTH dwmapi.dll AND UE4SS-settings.ini
 * (basename match — works for both flat and nested layouts) with no unsafe paths.
 */
function testUE4SSInjector(files, gameId) {
  if (gameId !== GAME_ID) return Promise.resolve({ supported: false, requiredFiles: [] });
  const norm       = files.map(f => f.replace(/\\/g, '/').toLowerCase());
  const hasDwmapi  = norm.some(f => f === 'dwmapi.dll' || f.endsWith('/dwmapi.dll'));
  // A2: basename match — flat ('ue4ss-settings.ini') OR nested ('.../ue4ss-settings.ini')
  const hasSettings = norm.some(f => f === 'ue4ss-settings.ini' || f.endsWith('/ue4ss-settings.ini'));
  const allSafe    = files.every(isSafeRelPath);
  return Promise.resolve({ supported: hasDwmapi && hasSettings && allSafe, requiredFiles: [] });
}

/**
 * Installer: drops directory entries and unsafe paths; patches UE4SS-settings.ini
 * to set [Debug] GraphicsAPI=dx11 (EMERGENCY requires dx11; UE4SS default is opengl).
 * Falls back to a plain copy if the settings file cannot be read.
 */
function installUE4SSInjector(files, destinationPath) {
  const filtered = files.filter(f => !f.endsWith(path.sep) && isSafeRelPath(f));
  return Promise.all(filtered.map(f => {
    const base = path.basename(f).toLowerCase();
    if (base === 'ue4ss-settings.ini') {
      return fs.readFileAsync(path.join(destinationPath, f), 'utf8')
        .then(content => {
          let patched = setIniValue(content, 'Debug', 'GraphicsAPI', 'dx11');
          patched = setIniValue(patched, 'Debug', 'GuiConsoleEnabled', '0');
          return { type: 'generatefile', data: Buffer.from(patched, 'utf8'), destination: f };
        })
        .catch(() => ({ type: 'copy', source: f, destination: f })); // read error → plain copy
    }
    return Promise.resolve({ type: 'copy', source: f, destination: f });
  })).then(instructions => {
    instructions.push({ type: 'setmodtype', value: UE4SS_INJECTOR_MODTYPE });
    return { instructions };
  });
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
          const rel   = JSON.parse(body);
          const asset = (rel.assets || []).find(a => UE4SS_ASSET_PATTERN.test(a.name));
          // H1: reject if URL isn't from a trusted host or name re-validation fails.
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
    }).on('error', (e) => {
      log('warn', 'UE4SS release request error', { error: e.message });
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// H2 — Download + install trigger with explicit consent dialog
// ---------------------------------------------------------------------------

async function downloadUE4SS(api) {
  const asset = await fetchLatestUE4SS();
  if (!asset) return;

  // Show a consent dialog naming the version and destination before proceeding.
  const dlgResult = await api.showDialog(
    'question',
    'Install UE4SS?',
    {
      text: 'EMERGENCY 2023 mods require UE4SS (' + asset.tag + '). Vortex will download the official release from github.com/UE4SS-RE/RE-UE4SS and install it into Binaries/Win64. Continue?',
    },
    [{ label: 'Cancel' }, { label: 'Download UE4SS' }],
  );

  if (!dlgResult || dlgResult.action !== 'Download UE4SS') return; // user declined → no-op

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
// B1 — Robust fail-safe guard: only returns false when CONFIDENT UE4SS is absent.
//      Checks multiple markers (flat + nested) to handle both layouts.
//      If Binaries/Win64 itself is missing → return true (unexpected layout, don't touch).
// ---------------------------------------------------------------------------

async function isUE4SSInstalled(root) {
  const win64 = path.join(root, BINARIES_WIN64);
  try { await fs.statAsync(win64); }
  catch (e) { return true; } // Binaries/Win64 missing → unexpected layout, fail-safe
  const markers = [
    'dwmapi.dll',
    'UE4SS.dll',
    'UE4SS-settings.ini',
    path.join('ue4ss', 'UE4SS-settings.ini'),
    path.join('ue4ss', 'UE4SS.dll'),
  ];
  for (const m of markers) {
    try { await fs.statAsync(path.join(win64, m)); return true; } catch (e) {}
  }
  return false;
}

// ---------------------------------------------------------------------------
// E2 — Find UE4SS settings file: flat first, then legacy nested layout
// ---------------------------------------------------------------------------

async function findSettingsFile(root) {
  const flat = path.join(root, BINARIES_WIN64, UE4SS_SETTINGS_FILE);
  try { await fs.statAsync(flat); return flat; } catch (_) {}
  const nested = path.join(root, BINARIES_WIN64, 'ue4ss', UE4SS_SETTINGS_FILE);
  try { await fs.statAsync(nested); return nested; } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// E3 — Settings page React class component (no hooks — React-version safe)
// ---------------------------------------------------------------------------

class UE4SSSettingsPage extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      settingsPath: null,
      graphicsAPI: 'dx11',
      consoleEnabled: false,
      guiConsoleEnabled: false,
      guiConsoleVisible: false,
      renderMode: 'ExternalThread',
      modFolders: [],
      newFolder: '',
      loaded: false,
      error: null,
      dirty: false,
    };
  }

  componentDidMount() { this.load(); }

  load() {
    const disc = this._getDiscovery();
    if (!disc || !disc.path) {
      this.setState({ error: 'Game not found in Vortex', loaded: true });
      return;
    }
    findSettingsFile(disc.path)
      .then(settingsPath => {
        if (!settingsPath) { this.setState({ settingsPath: null, loaded: true }); return; }
        return fs.readFileAsync(settingsPath, 'utf8').then(content => {
          const graphicsAPI       = getIniValue(content, 'Debug', 'GraphicsAPI')        || 'dx11';
          const consoleEnabled    = (getIniValue(content, 'Debug', 'ConsoleEnabled')    || '').trim() === '1';
          const guiConsoleEnabled = (getIniValue(content, 'Debug', 'GuiConsoleEnabled') || '').trim() === '1';
          const guiConsoleVisible = (getIniValue(content, 'Debug', 'GuiConsoleVisible') || '').trim() === '1';
          const renderMode        = getIniValue(content, 'Debug', 'RenderMode')         || 'ExternalThread';
          const modFolders        = getIniListValues(content, 'Overrides', 'ModsFolderPaths');
          this.setState({ settingsPath, graphicsAPI, consoleEnabled, guiConsoleEnabled, guiConsoleVisible, renderMode, modFolders, loaded: true });
        });
      })
      .catch(err => this.setState({ error: err.message, loaded: true }));
  }

  _getDiscovery() {
    const st = this.props.api && this.props.api.getState && this.props.api.getState();
    return st &&
           st.settings &&
           st.settings.gameMode &&
           st.settings.gameMode.discovered &&
           st.settings.gameMode.discovered[GAME_ID];
  }

  save() {
    const { settingsPath, graphicsAPI, consoleEnabled, guiConsoleEnabled, guiConsoleVisible, renderMode, modFolders } = this.state;
    if (!settingsPath) return;
    fs.readFileAsync(settingsPath, 'utf8')
      .then(content => {
        let updated = setIniValue(content, 'Debug', 'GraphicsAPI', graphicsAPI);
        updated     = setIniValue(updated,  'Debug', 'ConsoleEnabled',    consoleEnabled    ? '1' : '0');
        updated     = setIniValue(updated,  'Debug', 'GuiConsoleEnabled', guiConsoleEnabled ? '1' : '0');
        updated     = setIniValue(updated,  'Debug', 'GuiConsoleVisible', guiConsoleVisible ? '1' : '0');
        updated     = setIniValue(updated,  'Debug', 'RenderMode',        renderMode);
        updated     = setIniListValues(updated, 'Overrides', 'ModsFolderPaths', modFolders);
        return fs.writeFileAsync(settingsPath, updated, 'utf8');
      })
      .then(() => {
        if (this.props.api && this.props.api.sendNotification) {
          this.props.api.sendNotification({
            id: 'ue4ss-settings-saved', type: 'success', title: 'UE4SS settings saved',
          });
        }
        this.setState({ dirty: false });
      })
      .catch(err => this.setState({ error: err.message }));
  }

  render() {
    const rbs = reactBootstrap || {};
    const { Button, ControlLabel, FormControl, FormGroup, HelpBlock } = rbs;
    const { settingsPath, graphicsAPI, consoleEnabled, guiConsoleEnabled, guiConsoleVisible, renderMode, modFolders, newFolder, loaded, error, dirty } = this.state;
    const ce = React.createElement;

    // Refresh helper: resets transient state then re-runs load() so the page briefly
    // shows "Loading…" then reflects the current disk state.  Useful when UE4SS was
    // installed/deployed after this page first mounted (avoids a Vortex restart).
    const refreshBtn = Button ? ce(Button, {
      onClick: () => this.setState({ loaded: false, error: null }, () => this.load()),
    }, 'Refresh') : null;

    if (!loaded)      return ce('div', null, 'Loading UE4SS settings…');
    if (error)        return ce('div', null, 'Error: ' + error, ' ', refreshBtn);
    if (!settingsPath) return ce('div', null,
      'UE4SS is not installed yet. Install a UE4SS mod first, then click Refresh.',
      ' ', refreshBtn,
    );

    // QoL buttons — only when util.opn is available (vortex-api version dependent)
    const hasOpn = Button && typeof util.opn === 'function';
    const openFolderBtn = hasOpn ? ce(Button, {
      onClick: () => util.opn(path.dirname(settingsPath)).catch(() => null),
    }, 'Open folder') : null;
    const editFileBtn = hasOpn ? ce(Button, {
      onClick: () => util.opn(settingsPath).catch(() => null),
    }, 'Edit file') : null;

    return ce('div', null,
      // GraphicsAPI
      FormGroup ? ce(FormGroup, null,
        ControlLabel ? ce(ControlLabel, null, 'Graphics API') : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: graphicsAPI,
          onChange: (e) => this.setState({ graphicsAPI: e.target.value, dirty: true }),
        },
          ce('option', { value: 'dx11' },   'DirectX 11 (recommended for EMERGENCY 2023)'),
          ce('option', { value: 'd3d11' },  'DirectX 11 (d3d11)'),
          ce('option', { value: 'opengl' }, 'OpenGL'),
        ) : null,
        HelpBlock ? ce(HelpBlock, null, 'EMERGENCY 2023 requires dx11; opengl causes a black screen.') : null,
      ) : null,
      // ConsoleEnabled
      FormGroup ? ce(FormGroup, null,
        ControlLabel ? ce(ControlLabel, null, 'Console') : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: consoleEnabled ? '1' : '0',
          onChange: (e) => this.setState({ consoleEnabled: e.target.value === '1', dirty: true }),
        },
          ce('option', { value: '1' }, 'Enabled'),
          ce('option', { value: '0' }, 'Disabled'),
        ) : null,
      ) : null,
      // GuiConsoleEnabled
      FormGroup ? ce(FormGroup, null,
        ControlLabel ? ce(ControlLabel, null, 'GUI Console') : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: guiConsoleEnabled ? '1' : '0',
          onChange: (e) => this.setState({ guiConsoleEnabled: e.target.value === '1', dirty: true }),
        },
          ce('option', { value: '1' }, 'Enabled'),
          ce('option', { value: '0' }, 'Disabled (recommended — hides the in-game debug console)'),
        ) : null,
      ) : null,
      // GuiConsoleVisible
      FormGroup ? ce(FormGroup, null,
        ControlLabel ? ce(ControlLabel, null, 'GUI Console Visible') : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: guiConsoleVisible ? '1' : '0',
          onChange: (e) => this.setState({ guiConsoleVisible: e.target.value === '1', dirty: true }),
        },
          ce('option', { value: '1' }, 'Visible'),
          ce('option', { value: '0' }, 'Hidden'),
        ) : null,
      ) : null,
      // RenderMode
      FormGroup ? ce(FormGroup, null,
        ControlLabel ? ce(ControlLabel, null, 'Render Mode') : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: renderMode,
          onChange: (e) => this.setState({ renderMode: e.target.value, dirty: true }),
        },
          ce('option', { value: 'ExternalThread' },           'ExternalThread (default)'),
          ce('option', { value: 'EngineTick' },               'EngineTick'),
          ce('option', { value: 'GameViewportClientTick' },   'GameViewportClientTick'),
        ) : null,
      ) : null,
      // External mod folders — [Overrides] +ModsFolderPaths
      FormGroup ? ce(FormGroup, null,
        ControlLabel ? ce(ControlLabel, null, 'External mod folders (UE4SS +ModsFolderPaths)') : null,
        ...modFolders.map((folder, idx) => ce('div', { key: String(idx) },
          ce('span', null, folder),
          ' ',
          Button ? ce(Button, {
            bsSize: 'xsmall',
            onClick: () => this.setState(s => ({
              modFolders: s.modFolders.filter((_, i) => i !== idx),
              dirty: true,
            })),
          }, 'Remove') : null,
        )),
        ce('div', null,
          ce('input', {
            type: 'text',
            value: newFolder,
            onChange: (e) => this.setState({ newFolder: e.target.value }),
            placeholder: '../SharedMods',
          }),
          ' ',
          Button ? ce(Button, {
            onClick: () => {
              const trimmed = newFolder.trim();
              if (trimmed) this.setState(s => ({ modFolders: [...s.modFolders, trimmed], newFolder: '', dirty: true }));
            },
          }, 'Add') : null,
        ),
      ) : null,
      Button ? ce(Button, {
        onClick: () => this.save(),
        disabled: !dirty || !loaded,
      }, 'Save') : null,
      refreshBtn,
      openFolderBtn,
      editFileBtn,
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function main(context) {
  // Injector modType: deploys UE4SS itself (flat: dwmapi.dll + Mods/ + settings) to Binaries/Win64.
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

function findGame() {
  return util.GameStoreHelper.findByAppId([STEAM_APP_ID])
    .then((game) => game.gamePath);
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
