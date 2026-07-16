# Builds the Nexus/Vortex upload archive with info.json, index.js, gameart.png and src/
# at the ROOT of the zip. GitHub's auto-generated "Source code (zip)" release asset nests
# everything under <repo>-<tag>/ instead, which Vortex rejects (see issue #23414).
$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$info    = Get-Content (Join-Path $root 'info.json') | ConvertFrom-Json
$version = $info.version

$distDir  = Join-Path $root 'dist'
$zipPath  = Join-Path $distDir "game-emergency-2023-$version.zip"

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# Compress-Archive stores entry names with backslashes on Windows, which violates the
# ZIP spec (entries must use '/') and breaks extraction on non-Windows unzip tools —
# the same class of bug fixed in this extension's own UE4SS archive handling. Write
# entries via ZipArchive directly so separators are always '/'.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = @(
    @{ Path = (Join-Path $root 'info.json');   Entry = 'info.json' }
    @{ Path = (Join-Path $root 'index.js');    Entry = 'index.js' }
    @{ Path = (Join-Path $root 'gameart.png'); Entry = 'gameart.png' }
)
Get-ChildItem (Join-Path $root 'src') -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
    $files += @{ Path = $_.FullName; Entry = $rel }
}

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.Path, $f.Entry) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Write-Output "Packaged: $zipPath"
