# Vortex game extension — EMERGENCY 2023

Makes **EMERGENCY 2023** (Steam `850170`) a Vortex-managed game so any UE4SS mod
installs in one click instead of users hand-dropping files.

## Game detection

| Field | Value |
|---|---|
| Steam App ID | `850170` |
| Install root | `…/steamapps/common/EMERGENCY/` |
| Executable | `EMERGENCY.exe` (at install root) |
| UE project | `<root>/EMERGENCY/` |
| Managed mods path | `EMERGENCY/Binaries/Win64/Mods` (relative to root) |

Detection uses `util.GameStoreHelper.findByAppId(['850170'])` — standard Vortex Steam detection.

## Mod deploy path

Mods are deployed into `EMERGENCY/Binaries/Win64/ue4ss/Mods` by default (the nested layout).
`queryModPath` detects the actual installed UE4SS layout at deploy time and switches to the
**flat** `EMERGENCY/Binaries/Win64/Mods` path when a flat `UE4SS.dll` is found instead.

## UE4SS injector mod type

A dedicated mod type (`emergency2023-ue4ss-injector`) handles UE4SS itself as a Vortex mod,
deploying its files to `EMERGENCY/Binaries/Win64`.

**Installer recognition** (`testUE4SSInjector`): any archive containing both `dwmapi.dll` and
`UE4SS-settings.ini` (basename match — works for flat or legacy nested archives). Archives with
absolute paths or `../` traversal are rejected.

**At install time** (`installUE4SSInjector`): the `UE4SS-settings.ini` is patched to set
`[Debug] GraphicsAPI = dx11` (EMERGENCY 2023 requires DirectX 11; `opengl` causes a black screen)
**and** `[Debug] GuiConsoleEnabled = 0` (hides the debug console by default).
The patch is applied via `generatefile`; if the source INI cannot be read the file is copied unmodified as a fallback.

## UE4SS auto-install

On first launch (`setup` callback), if UE4SS is not already installed:

1. **Guard** — `isUE4SSInstalled(root)` checks five markers in `Binaries/Win64`:
   `dwmapi.dll`, `UE4SS.dll`, `UE4SS-settings.ini`, `ue4ss/UE4SS-settings.ini`,
   `ue4ss/UE4SS.dll`. Any one present → skip. If `Binaries/Win64` itself is absent
   (unexpected layout) → also skip (fail-safe, never clobbers).
2. **Fetch** — queries `https://api.github.com/repos/UE4SS-RE/RE-UE4SS/releases/tags/v4.0.0`
   for the standard `UE4SS_v4.0.0.zip` asset.
3. **Trust check** — download URL must be `https://` from `github.com` or
   `objects.githubusercontent.com`; asset name is re-validated against the pattern.
   Untrusted URLs are silently dropped.
4. **Consent dialog** — names the release tag and destination (`Binaries/Win64`) before
   any download starts. User can cancel with no side effects.
5. **Download + install** — fired via the standard Vortex `start-download` /
   `start-install-download` event pipeline. Reuses the download ID when Vortex already has the archive. If the injector is staged, setup prompts for deployment.

## Settings page (Settings → EMERGENCY 2023 · UE4SS)

A Vortex settings page (registered only when `react-bootstrap` is available and the game
is discovered and active) lets users edit all `[Debug]` and `[Overrides]` fields in the deployed
`UE4SS-settings.ini`:

| Field | INI key | Values |
|---|---|---|
| Graphics API | `GraphicsAPI` | `dx11` / `d3d11` / `opengl` |
| Console | `ConsoleEnabled` | `0` / `1` |
| GUI Console | `GuiConsoleEnabled` | `0` / `1` |
| GUI Console Visible | `GuiConsoleVisible` | `0` / `1` |
| Render Mode | `RenderMode` | `ExternalThread` / `EngineTick` / `GameViewportClientTick` |
| External mod folders | `+ModsFolderPaths` | list of paths in `[Overrides]` |

The page also exposes **Open folder** and **Edit file** buttons (using `util.opn`) for direct
access to the settings file location. A **Refresh** button re-reads the INI without restarting Vortex.

The page finds the settings file in the flat location first (`Binaries/Win64/UE4SS-settings.ini`),
then falls back to the legacy nested location (`Binaries/Win64/ue4ss/UE4SS-settings.ini`).
Changes are written back to the live INI file; a success notification confirms the save.

## Files

```
vortex-emergency2023/
├── info.json          ← extension metadata (name, version 1.3.0, description)
├── index.js           ← plain JS, no build step required
├── gameart.png        ← 2048×1024 key art (T_LoginBackground_BC)
├── src/                ← required by index.js (constants, ini, ue4ss, settings-page)
└── test/
    └── index.test.js  ← offline unit tests (plain Node, no deps)
```

All logic is in plain JS. There is no build step and no npm dependencies.

## Tests

```bash
node test/index.test.js
```

Tests cover: `isSafeRelPath`, `isTrustedUE4SSAsset`, `testUE4SSInjector` (flat + nested),
`getIniValue`, `setIniValue`, `getIniListValues`, `setIniListValues`,
`installUE4SSInjector` (generatefile baking both GraphicsAPI=dx11 and GuiConsoleEnabled=0, fallback),
`fetchLatestUE4SS` (HTTP stubs), `downloadUE4SS` (consent gate, H1 guard), `isUE4SSInstalled`
(all 5 markers + fail-safe), `findSettingsFile`,
`UE4SSSettingsPage` (load all 6 fields, save all 6 fields + mod folders, render full UI, Refresh).

## Build and submit

1. Run `scripts/package.ps1` to produce `dist/game-emergency-2023-<version>.zip` with
   `info.json`, `index.js`, `gameart.png` and `src/` at the **root** of the archive.
   **Do not** upload a GitHub "Source code (zip)" release asset — it nests everything under
   `game-emergency-2023-<tag>/`, which Vortex rejects (see [#23414](https://github.com/Nexus-Mods/Vortex/issues/23414)).
2. Upload to [nexusmods.com/site/mods](https://www.nexusmods.com/site/mods) (Vortex extension
   category). The upload version **must match** `info.json` → `1.3.0`.
3. Submit the **Review Extension** form on the Vortex GitHub repository.
   A reviewer responds within ~5 working days. Increment `version` on every re-upload.

## Status

**Scaffolded + offline-tested (62) + live-validated** (extension loads, guard correctly skips
auto-download on an existing UE4SS install, no clobber).

**Pending before submit:**
- Visual confirmation of the Settings page rendering inside Vortex on Windows
- Fresh-install deploy/purge cycle (no existing UE4SS → auto-download → mod deploys to `Mods/` → purge cleans up)
