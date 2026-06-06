# Vortex game extension — EMERGENCY 2023

Adds **EMERGENCY 2023** to Vortex as a managed game so any UE4SS mod (e.g.
[em-fast-boot](https://gitlab.com/em-modding/em-fast-boot)) installs in one click,
instead of users hand-dropping files into `ue4ss/Mods`.

Until this exists, the game has a Nexus **website** page but does **not** appear in
the Vortex app (Vortex only lists games that have a game extension). This fills that gap.

## Files (top-level — no nested root folder, per Vortex packaging rules)
- `info.json` — name / author / version (semver, must match the Nexus upload version) / description
- `index.js` — registers the game, Steam detection (App ID **850170**), UE4SS mod path
- `gameart.png` — ✅ the game key art (2048×1024), from the game's own login background (`Content/UI/Login/T_LoginBackground_BC`). Standard for Vortex game extensions (identifies the game visually).

## ⚠ Windows field-test gaps (verify before submitting — see `index.js` G1–G3)
1. **Executable** — exact `.exe` name + relative path in the Steam install. Placeholder: `EMERGENCY2023.exe`.
2. **Mod path** — confirm UE4SS deploys to `<ProjectName>/Binaries/Win64/ue4ss/Mods` and the real `<ProjectName>`.
3. **requiredFiles** — set to the confirmed exe.
(Steam App ID `850170` is confirmed.)

## Test (per the Vortex "How to test" guide)
1. Zip the 3 files at top-level.
2. Extract into `%APPDATA%\Vortex\Plugins\game-emergency2023\`.
3. Restart Vortex → EMERGENCY 2023 should appear under **Games**, detect the Steam install,
   and deploy a test mod (em-fast-boot) into the UE4SS Mods folder. Verify **purge** works too.
4. Reviewer "80/20": the most popular mods should install correctly.

## Submit (per the Vortex "How to submit" guide)
1. Upload the extension archive to Nexus Mods (Vortex extension category), **version == `info.json` version**.
2. Open the **Review Extension** form on the Vortex GitHub repo. A reviewer responds within ~5 working days.
3. Increment the version on every re-upload.

## Status
Scaffolded offline, grounded on the official Vortex wiki (package/test/submit). The 3 gaps above + `gameart.png`
are the only blockers — all Windows-side. Once confirmed, this is submit-ready.
