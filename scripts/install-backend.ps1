[CmdletBinding()]
param(
    [string] $BackendPython = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$VibeVersion = "2.26.1"
$PyInstallerVersion = "6.20.0"
$runtimeRoot = Join-Path $repoRoot ".runtime"
$venvPath = Join-Path $runtimeRoot "venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"
$uvCache = Join-Path $runtimeRoot "uv-cache"
$requirementsPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\requirements-backend.txt"))
if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw "Pinned backend requirements file was not found: $requirementsPath"
}

function Resolve-ExecutablePath([string] $Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $fullPath -ErrorAction Stop
    if ($item.LinkType -eq "SymbolicLink") {
        $target = [string]@($item.Target)[0]
        if ([string]::IsNullOrWhiteSpace($target)) {
            throw "Could not resolve the symbolic-link target for $fullPath."
        }
        if (-not [System.IO.Path]::IsPathRooted($target)) {
            $target = Join-Path $item.DirectoryName $target
        }
        $fullPath = [System.IO.Path]::GetFullPath($target)
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Symbolic-link target does not exist: $fullPath"
        }
    }
    return $fullPath
}

if ($env:OS -ne "Windows_NT") {
    throw "The Vibe Desktop backend build currently targets Windows x64."
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    if ([string]::IsNullOrWhiteSpace($BackendPython)) {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($null -eq $pythonCommand) {
            throw "Python 3.12 x64 was not found. Install Python 3.12 or pass -BackendPython."
        }
        $BackendPython = $pythonCommand.Source
    }
    if (-not (Test-Path -LiteralPath $BackendPython -PathType Leaf)) {
        throw "Python executable does not exist: $BackendPython"
    }

    $pythonInfo = & $BackendPython -c "import json,platform,struct,sys; print(json.dumps({'version': sys.version_info[:2], 'machine': platform.machine(), 'bits': struct.calcsize('P') * 8}))"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect Python at $BackendPython"
    }
    $pythonInfo = $pythonInfo | ConvertFrom-Json
    if ($pythonInfo.version[0] -ne 3 -or $pythonInfo.version[1] -ne 12 -or $pythonInfo.bits -ne 64 -or $pythonInfo.machine -notmatch "^(AMD64|x86_64)$") {
        throw "Backend Python must be 3.12 x64; found Python $($pythonInfo.version -join '.') $($pythonInfo.machine) $($pythonInfo.bits)-bit."
    }

    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -eq $uvCommand) {
        throw "uv was not found. Install uv, then rerun this script."
    }
    $uvExecutable = Resolve-ExecutablePath $uvCommand.Source
    $env:UV_CACHE_DIR = $uvCache
    & $uvExecutable venv --python $BackendPython $venvPath
    if ($LASTEXITCODE -ne 0) {
        throw "uv could not create the isolated backend environment."
    }
}

$installedInfo = & $venvPython -c "import json,platform,struct,sys; print(json.dumps({'version': sys.version_info[:2], 'machine': platform.machine(), 'bits': struct.calcsize('P') * 8}))"
if ($LASTEXITCODE -ne 0) {
    throw "The isolated backend Python could not start: $venvPython"
}
$installedInfo = $installedInfo | ConvertFrom-Json
if ($installedInfo.version[0] -ne 3 -or $installedInfo.version[1] -ne 12 -or $installedInfo.bits -ne 64 -or $installedInfo.machine -notmatch "^(AMD64|x86_64)$") {
    throw "The isolated backend must use Python 3.12 x64; found Python $($installedInfo.version -join '.') $($installedInfo.machine) $($installedInfo.bits)-bit."
}

$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
if ($null -eq $uvCommand) {
    throw "uv was not found. Install uv, then rerun this script."
}
$uvExecutable = Resolve-ExecutablePath $uvCommand.Source
$env:UV_CACHE_DIR = $uvCache
& $uvExecutable pip install --python $venvPython --only-binary :all: --requirement $requirementsPath
if ($LASTEXITCODE -ne 0) {
    throw "Could not install the pinned backend requirement set into the isolated environment."
}

$versions = & $venvPython -c "import importlib.metadata as m, json, pathlib, importlib.util; native=importlib.util.find_spec('mistralai_vibe_local_harness._native'); print(json.dumps({'vibe': m.version('mistral-vibe'), 'pyinstaller': m.version('pyinstaller'), 'nativeRuntime': None if native is None else native.origin, 'vibeRoot': str(pathlib.Path(importlib.util.find_spec('vibe').origin).resolve())}))"
if ($LASTEXITCODE -ne 0) {
    throw "The installed backend packages could not be inspected."
}
$versions = $versions | ConvertFrom-Json
if ($versions.vibe -ne $VibeVersion) {
    throw "Expected mistral-vibe $VibeVersion but found $($versions.vibe)."
}
if ($versions.pyinstaller -ne $PyInstallerVersion) {
    throw "Expected PyInstaller $PyInstallerVersion but found $($versions.pyinstaller)."
}
if ([string]::IsNullOrWhiteSpace($versions.nativeRuntime) -or -not (Test-Path -LiteralPath $versions.nativeRuntime -PathType Leaf)) {
    throw "The Vibe wheel does not contain the Unified Runtime native extension."
}
if ($versions.vibeRoot -notlike "$venvPath\Lib\site-packages\vibe\*") {
    throw "Vibe resolved outside the isolated wheel environment: $($versions.vibeRoot)"
}

Write-Output "Installed mistral-vibe $($versions.vibe) and PyInstaller $($versions.pyinstaller) in $venvPath."
