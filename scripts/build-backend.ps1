[CmdletBinding()]
param(
    [string] $OutputPath = ".runtime\backend\vibe-app-server",
    [string] $UpstreamSourcePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$VibeVersion = "2.26.1"
$PyInstallerVersion = "6.20.0"
$buildRoot = Join-Path $repoRoot ".runtime\backend-build"
$venvPython = Join-Path $repoRoot ".runtime\venv\Scripts\python.exe"
$outputDirectory = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputPath))
$upstreamCommit = "4ae5c5955da8e761318916bdb1a7f46f0b50c7d0"
$supportFiles = @(
    @{ Source = "vibe-app-server.spec"; Relative = "vibe-app-server.spec"; Blob = "8b5371a1362b1a79e0bfa1de1614240ec5878626"; Sha256 = "9EF54E4C146BDE645D2E6174AF29D86511425B20BDD4BF91866451F9220E7052" },
    @{ Source = "pyinstaller\unified_runtime.py"; Relative = "pyinstaller\unified_runtime.py"; Blob = "ab0d392568880259070b96ac2ed7b6bd695d7863"; Sha256 = "EBDE581ABF55E88529040A6DF9680657C6F8E14EFBB00FEE32DBE715AA15BB95" },
    @{ Source = "pyinstaller\runtime_hook_truststore.py"; Relative = "pyinstaller\runtime_hook_truststore.py"; Blob = "14311b0e5b9921ff2e85b2993417e56dd93ab19b"; Sha256 = "2E23CAF7D9A96FE921FCACE352FB1BEABB8A341ED873FB385B1B7F071678B52F" }
)

function Assert-ContainedPath([string] $Path, [string] $Purpose) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootWithSeparator = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if ($fullPath -eq $repoRoot -or -not $fullPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Purpose must resolve inside the repository: $fullPath"
    }
    $currentPath = $repoRoot
    foreach ($segment in $fullPath.Substring($rootWithSeparator.Length).Split([System.IO.Path]::DirectorySeparatorChar)) {
        $currentPath = Join-Path $currentPath $segment
        if (Test-Path -LiteralPath $currentPath) {
            $item = Get-Item -LiteralPath $currentPath -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Purpose cannot pass through a reparse point: $currentPath"
            }
        }
    }
    return $fullPath
}

function Remove-ContainedDirectory([string] $Path, [string] $Purpose) {
    $safePath = Assert-ContainedPath $Path $Purpose
    if (Test-Path -LiteralPath $safePath) {
        Remove-Item -LiteralPath $safePath -Recurse -Force
    }
}

function Get-CanonicalSourceHashes([string] $Path) {
    $sourceBytes = [System.IO.File]::ReadAllBytes($Path)
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    try {
        $sourceText = $utf8.GetString($sourceBytes)
    } catch {
        throw "Upstream support file is not valid UTF-8: $Path"
    }
    if ($sourceText.Length -gt 0 -and [int][char]$sourceText[0] -eq 0xFEFF) {
        throw "Upstream support file has an unexpected UTF-8 BOM: $Path"
    }
    $canonicalText = $sourceText.Replace("`r`n", "`n")
    if ($canonicalText.Contains("`r")) {
        throw "Upstream support file has a non-canonical bare carriage return: $Path"
    }
    $canonicalBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonicalText)
    $blobHeader = [System.Text.Encoding]::ASCII.GetBytes("blob $($canonicalBytes.Length)`0")
    $blobBytes = [byte[]]::new($blobHeader.Length + $canonicalBytes.Length)
    [System.Buffer]::BlockCopy($blobHeader, 0, $blobBytes, 0, $blobHeader.Length)
    [System.Buffer]::BlockCopy($canonicalBytes, 0, $blobBytes, $blobHeader.Length, $canonicalBytes.Length)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $blobHash = [System.BitConverter]::ToString($sha1.ComputeHash($blobBytes)).Replace("-", "").ToLowerInvariant()
        $sha256Hash = [System.BitConverter]::ToString($sha256.ComputeHash($canonicalBytes)).Replace("-", "")
    } finally {
        $sha1.Dispose()
        $sha256.Dispose()
    }
    return @{
        Blob = $blobHash
        Sha256 = $sha256Hash
        CanonicalBytes = $canonicalBytes
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "The frozen Vibe app server is supported on Windows x64 only."
}
$needsInstall = $true
if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
    $installedVersions = & $venvPython -c "import importlib.metadata as m, json; print(json.dumps({'vibe': m.version('mistral-vibe'), 'pyinstaller': m.version('pyinstaller')}))" 2>$null
    if ($LASTEXITCODE -eq 0) {
        try {
            $installedVersions = $installedVersions | ConvertFrom-Json
            $needsInstall = $installedVersions.vibe -ne $VibeVersion -or $installedVersions.pyinstaller -ne $PyInstallerVersion
        } catch {
            $needsInstall = $true
        }
    }
}
if ($needsInstall) {
    & (Join-Path $PSScriptRoot "install-backend.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "The isolated backend environment could not be prepared."
    }
}

Assert-ContainedPath $buildRoot "Build directory" | Out-Null
Assert-ContainedPath $outputDirectory "Backend output directory" | Out-Null
if ($outputDirectory.StartsWith(($buildRoot.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or $buildRoot.StartsWith(($outputDirectory.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Backend output and temporary build directories must not overlap."
}
Remove-ContainedDirectory $buildRoot "Build directory"
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

$upstreamDirectory = Join-Path $buildRoot "upstream"
New-Item -ItemType Directory -Force -Path (Join-Path $upstreamDirectory "pyinstaller") | Out-Null
if (-not [string]::IsNullOrWhiteSpace($UpstreamSourcePath)) {
    $upstreamDirectorySource = [System.IO.Path]::GetFullPath($UpstreamSourcePath)
    if (-not (Test-Path -LiteralPath (Join-Path $upstreamDirectorySource ".git") -PathType Container)) {
        throw "Upstream source path is not a Git checkout: $upstreamDirectorySource"
    }
    $upstreamHead = & git -c "safe.directory=$upstreamDirectorySource" -C $upstreamDirectorySource rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $upstreamHead.Trim() -ne $upstreamCommit) {
        throw "Upstream source must be at pinned commit $upstreamCommit; found $($upstreamHead.Trim())."
    }
}

foreach ($support in $supportFiles) {
    $destination = Join-Path $upstreamDirectory $support.Relative
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    if ([string]::IsNullOrWhiteSpace($UpstreamSourcePath)) {
        $sourceUrl = "https://raw.githubusercontent.com/mistralai/mistral-vibe/$upstreamCommit/$($support.Source.Replace('\', '/'))"
        Invoke-WebRequest -Uri $sourceUrl -OutFile $destination -UseBasicParsing
    } else {
        Copy-Item -LiteralPath (Join-Path $upstreamDirectorySource $support.Source) -Destination $destination
    }
    $actualHashes = Get-CanonicalSourceHashes $destination
    if ($actualHashes.Blob -ne $support.Blob -or $actualHashes.Sha256 -ne $support.Sha256) {
        throw "Upstream support file failed its pinned Git blob or canonical UTF-8/LF SHA-256 check: $($support.Source) (blob $($actualHashes.Blob), SHA-256 $($actualHashes.Sha256))"
    }
    [System.IO.File]::WriteAllBytes($destination, $actualHashes.CanonicalBytes)
}

$pythonInfoJson = & $venvPython -c "import importlib.metadata as m, importlib.util, json, pathlib, platform, site, struct, sys; native=importlib.util.find_spec('mistralai_vibe_local_harness._native'); print(json.dumps({'vibe': m.version('mistral-vibe'), 'pyinstaller': m.version('pyinstaller'), 'python': platform.python_version(), 'machine': platform.machine(), 'bits': struct.calcsize('P') * 8, 'vibeRoot': str(pathlib.Path(importlib.util.find_spec('vibe').origin).resolve()), 'nativeRuntime': None if native is None else str(pathlib.Path(native.origin).resolve()), 'sitePackages': site.getsitepackages()[0], 'basePrefix': sys.base_prefix}))"
if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the isolated backend environment."
}
$pythonInfo = $pythonInfoJson | ConvertFrom-Json
if ($pythonInfo.vibe -ne $VibeVersion -or $pythonInfo.pyinstaller -ne $PyInstallerVersion) {
    throw "The installed Vibe or PyInstaller version does not match the build pin."
}
if ([string]::IsNullOrWhiteSpace($pythonInfo.nativeRuntime) -or -not (Test-Path -LiteralPath $pythonInfo.nativeRuntime -PathType Leaf)) {
    throw "The installed Vibe wheel is missing its required Unified Runtime native extension."
}
if (-not ($pythonInfo.python -like "3.12.*") -or $pythonInfo.bits -ne 64 -or $pythonInfo.machine -notmatch "^(AMD64|x86_64)$") {
    throw "The frozen backend build requires Python 3.12 x64; found Python $($pythonInfo.python) $($pythonInfo.machine) $($pythonInfo.bits)-bit."
}
if ($pythonInfo.vibeRoot -notlike "$repoRoot\.runtime\venv\Lib\site-packages\vibe\*") {
    throw "Vibe resolved outside the isolated wheel environment: $($pythonInfo.vibeRoot)"
}

$officialSpecPath = Join-Path $upstreamDirectory "vibe-app-server.spec"
$specText = Get-Content -LiteralPath $officialSpecPath -Raw
function Replace-ExactlyOnce([string] $Text, [string] $Old, [string] $New, [string] $Description) {
    $count = [regex]::Matches($Text, [regex]::Escape($Old)).Count
    if ($count -ne 1) {
        throw "Pinned upstream spec no longer has exactly one expected $Description stanza."
    }
    return $Text.Replace($Old, $New)
}
$specText = Replace-ExactlyOnce $specText 'sys.path.insert(0, os.path.join(SPECPATH, "pyinstaller"))' 'sys.path.insert(0, os.path.join(SPECPATH, "upstream", "pyinstaller"))' "unified-runtime helper path"
$builtinSource = 'datas += [(os.path.join(os.path.dirname(__import__("vibe").__file__), "core", "tools", "builtins", "*.py"), "vibe/core/tools/builtins")]'
$specText = Replace-ExactlyOnce $specText 'datas += [("vibe/core/tools/builtins/*.py", "vibe/core/tools/builtins")]' $builtinSource "built-in tool source collection"
$builtinPluginData = @'
datas += collect_data_files("vibe.plugins.builtins", include_py_files=True)
datas += _harness_datas
'@
$specText = Replace-ExactlyOnce $specText 'datas += _harness_datas' $builtinPluginData.TrimEnd() "built-in plugin resources collection"
$specText = Replace-ExactlyOnce $specText '["vibe/app_server/entrypoint.py"]' '[os.path.join(SPECPATH, "entrypoint.py")]' "installed-wheel entry point"
$specText = Replace-ExactlyOnce $specText 'pathex=[]' 'pathex=[SPECPATH]' "project launcher import path"
$specText = Replace-ExactlyOnce $specText '["pyinstaller/runtime_hook_truststore.py"]' '[os.path.join(SPECPATH, "upstream", "pyinstaller", "runtime_hook_truststore.py")]' "truststore runtime hook"
$specText = Replace-ExactlyOnce $specText 'excludes=[]' 'excludes=["textual_speedups"]' "optional Textual speedups exclusion"
$specPath = Join-Path $buildRoot "build.spec"
[System.IO.File]::WriteAllText($specPath, $specText, [System.Text.UTF8Encoding]::new($false))

$entryPointPath = Join-Path $buildRoot "entrypoint.py"
$entryPoint = @'
"""Project-owned launcher for the official Vibe server and desktop auth bridge."""

import os
import sys

os.environ["TEXTUAL_SPEEDUPS"] = "0"


if __name__ == "__main__":
    if sys.argv[1:] == ["--desktop-auth"]:
        from auth_sidecar import main as auth_main

        raise SystemExit(auth_main())
    from vibe.app_server.stdio import main

    main()
'@
[System.IO.File]::WriteAllText($entryPointPath, $entryPoint, [System.Text.UTF8Encoding]::new($false))
$authSidecarPath = Join-Path $PSScriptRoot "auth-sidecar.py"
if (-not (Test-Path -LiteralPath $authSidecarPath -PathType Leaf)) {
    throw "The desktop browser-auth sidecar source was not found: $authSidecarPath"
}
Copy-Item -LiteralPath $authSidecarPath -Destination (Join-Path $buildRoot "auth_sidecar.py")

$env:PYINSTALLER_CONFIG_DIR = Join-Path $buildRoot "pyinstaller-cache"
$env:UV_CACHE_DIR = Join-Path $repoRoot ".runtime\uv-cache"
Push-Location $buildRoot
try {
    & $venvPython -m PyInstaller --noconfirm --clean --distpath (Join-Path $buildRoot "dist") --workpath (Join-Path $buildRoot "work") $specPath
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed to freeze the pinned official app-server package."
    }
} finally {
    Pop-Location
}

$frozenDirectory = Join-Path $buildRoot "dist\vibe-app-server-dir"
$frozenExecutable = Join-Path $frozenDirectory "vibe-app-server.exe"
if (-not (Test-Path -LiteralPath $frozenExecutable -PathType Leaf)) {
    throw "PyInstaller did not produce the expected onedir server executable."
}
$frozenBuiltinPluginRoot = Join-Path $frozenDirectory "_internal\vibe\plugins\builtins"
$requiredBuiltinPluginFiles = @(
    (Join-Path $frozenBuiltinPluginRoot "vibe\plugin.json"),
    (Join-Path $frozenBuiltinPluginRoot "vibe\skills\vibe\SKILL.md"),
    (Join-Path $frozenBuiltinPluginRoot "vibe\skills\worktree\SKILL.md")
)
if (-not (Test-Path -LiteralPath $frozenBuiltinPluginRoot -PathType Container) -or @($requiredBuiltinPluginFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) {
    throw "The frozen backend is missing packaged built-in plugin resources under _internal\vibe\plugins\builtins."
}

$licenseToolPath = Join-Path $buildRoot "write_backend_notices.py"
$licenseTool = @'
from __future__ import annotations

import importlib.metadata as metadata
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

destination = Path(sys.argv[1]).resolve()
site_packages = Path(sys.argv[2]).resolve()
distributions = {
    canonicalize_name(dist.metadata.get("Name", dist.name)): dist
    for dist in metadata.distributions()
}
roots = ["mistral-vibe", "pyinstaller"]
excluded = {"textual-speedups"}
selected = {}
pending = list(roots)
environment = default_environment()
while pending:
    name = canonicalize_name(pending.pop())
    if name in selected:
        continue
    dist = distributions.get(name)
    if dist is None:
        raise SystemExit(f"Required distribution is missing: {name}")
    selected[name] = dist
    for raw in dist.requires or []:
        requirement = Requirement(raw)
        if requirement.marker and not requirement.marker.evaluate(environment):
            continue
        dependency = canonicalize_name(requirement.name)
        if dependency in excluded:
            continue
        if dependency in distributions and dependency not in selected:
            pending.append(dependency)

license_name = re.compile(r"^(license|licence|copying|copyright|notice)(?:[._-].*)?$", re.I)
license_entries = []
for key, dist in sorted(selected.items()):
    package_name = dist.metadata.get("Name", dist.name)
    package_version = dist.version
    safe_name = re.sub(r"[^A-Za-z0-9._+-]+", "_", f"{package_name}-{package_version}")
    license_files = []
    for item in dist.files or []:
        relative = PurePosixPath(str(item).replace("\\", "/"))
        if not license_name.match(relative.name) or ".." in relative.parts:
            continue
        source = Path(dist.locate_file(str(item))).resolve()
        if site_packages not in source.parents or not source.is_file():
            continue
        license_files.append((relative, source))
    license_dir = destination / "licenses" / safe_name
    copied = []
    for relative, source in sorted(license_files, key=lambda pair: str(pair[0]).lower()):
        target = license_dir.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append(target.relative_to(destination).as_posix())
    declared = dist.metadata.get("License-Expression") or dist.metadata.get("License") or "not declared in package metadata"
    license_entries.append({
        "name": package_name,
        "version": package_version,
        "license": " ".join(declared.split()),
        "licenseFiles": copied,
    })

python_license = Path(sys.base_prefix) / "LICENSE.txt"
if python_license.is_file():
    target = destination / "licenses" / f"Python-{sys.version_info.major}.{sys.version_info.minor}" / "LICENSE.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(python_license, target)
    python_license_entry = target.relative_to(destination).as_posix()
else:
    python_license_entry = "not found in the Python installation"

lines = [
    "# Frozen backend third-party inventory",
    "",
    "Generated from the installed `mistral-vibe` and PyInstaller dependency metadata used for this build.",
    "The complete matching license files are copied into this directory where the distributions publish them.",
    "",
    f"Python runtime: {sys.version.split()[0]} (PSF license file: `{python_license_entry}`)",
    "",
    "| Distribution | Version | Declared license | License files copied |",
    "| --- | --- | --- | --- |",
]
for entry in license_entries:
    files = ", ".join(f"`{item}`" for item in entry["licenseFiles"]) or "No matching license file in wheel metadata"
    license_text = entry["license"].replace("|", "\\|")
    lines.append(f"| {entry['name']} | {entry['version']} | {license_text} | {files} |")
lines += [
    "",
    "This inventory includes the installed runtime dependency closure and PyInstaller build tools. Optional extras not installed in this build are not included.",
    "",
]
(destination / "licenses" / "THIRD_PARTY_NOTICES.generated.md").write_text("\n".join(lines), encoding="utf-8")
(destination / "licenses" / "manifest.json").write_text(
    json.dumps({"python": sys.version.split()[0], "packages": license_entries, "pythonLicense": python_license_entry}, indent=2) + "\n",
    encoding="utf-8",
)
missing = [item["name"] for item in license_entries if not item["licenseFiles"] and item["license"] == "not declared in package metadata"]
if missing:
    raise SystemExit("No license text or metadata found for: " + ", ".join(missing))
if any("textual_speedups" in path.name.lower() or "textual-speedups" in path.name.lower() for path in destination.rglob("*")):
    raise SystemExit("textual-speedups was excluded from the inventory but is present in the frozen output")
'@
[System.IO.File]::WriteAllText($licenseToolPath, $licenseTool, [System.Text.UTF8Encoding]::new($false))

Remove-ContainedDirectory $outputDirectory "Backend output directory"
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Get-ChildItem -LiteralPath $frozenDirectory -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $outputDirectory -Recurse -Force
}
& $venvPython $licenseToolPath $outputDirectory $pythonInfo.sitePackages
if ($LASTEXITCODE -ne 0) {
    throw "The frozen backend license inventory could not be generated."
}

$metadataPath = Join-Path $outputDirectory "build-metadata.json"
$requirementsPath = Join-Path $repoRoot "requirements-backend.txt"
if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw "Pinned backend requirements file was not found: $requirementsPath"
}
$requirementsHash = (Get-FileHash -LiteralPath $requirementsPath -Algorithm SHA256).Hash.ToLowerInvariant()
$buildMetadata = [ordered]@{
    upstreamRepository = "https://github.com/mistralai/mistral-vibe"
    upstreamCommit = $upstreamCommit
    upstreamPackage = "mistral-vibe"
    upstreamVersion = $VibeVersion
    pyinstallerVersion = $PyInstallerVersion
    requirementsFile = "requirements-backend.txt"
    requirementsSha256 = $requirementsHash
    pythonVersion = $pythonInfo.python
    architecture = "windows-x64"
    desktopAuthBridge = [ordered]@{
        controller = "vibe.acp.auth.AcpAuthController"
        source = "scripts/auth-sidecar.py"
        sourceSha256 = (Get-FileHash -LiteralPath $authSidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
        launcherSha256 = (Get-FileHash -LiteralPath $entryPointPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    includedBuiltinPluginResources = @(
        "vibe/plugins/builtins/vibe/plugin.json",
        "vibe/plugins/builtins/vibe/skills/**/*.md"
    )
    buildInputHashes = @($supportFiles | ForEach-Object { [ordered]@{ path = $_.Source.Replace('\', '/'); gitBlob = $_.Blob; canonicalUtf8LfSha256 = $_.Sha256.ToLowerInvariant() } })
    excludedRuntimePackages = @([ordered]@{ name = "textual-speedups"; reason = "Optional Textual TUI geometry accelerator; disabled in the stdio app-server." })
}
[System.IO.File]::WriteAllText($metadataPath, ($buildMetadata | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))

$packagedExecutable = Join-Path $outputDirectory "vibe-app-server.exe"
& $venvPython (Join-Path $PSScriptRoot "windows-probe.py") $packagedExecutable
if ($LASTEXITCODE -ne 0) {
    throw "The frozen backend failed the real Windows app-server protocol probe."
}

Write-Output "Frozen Vibe app server: $packagedExecutable"
Write-Output "Pinned upstream: $upstreamCommit (mistral-vibe $VibeVersion)"
