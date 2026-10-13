<#
.SYNOPSIS
  Start the Corvex API and console.

.DESCRIPTION
  Exists because `python -m uvicorn backend.main:app --reload --port 8010`
  fails on a stock Windows box in a way that does not say what is wrong.

  Two traps, both of which have actually bitten here:

    1. `python` on PATH is usually C:\...\WindowsApps\python.exe — the
       Microsoft Store stub. It is not a Python. It prints an advert for the
       Store and exits, and it wins over the venv unless the venv is
       activated first.

    2. If a previous server is still holding the port, uvicorn reports
       "only one usage of each socket address is normally permitted" AFTER
       printing "Application startup complete", so it reads like the app
       started and then crashed. It did not: it never bound.

  This script calls the venv interpreter by full path, so activation is not
  required, and names the process holding the port instead of failing with
  a WinSock number.

.EXAMPLE
  .\run.ps1
  .\run.ps1 -Port 8011
  .\run.ps1 -NoReload
#>
[CmdletBinding()]
param(
  [int]$Port = 8010,
  [switch]$NoReload,
  [string]$BindHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# --- the interpreter ---------------------------------------------------------

$py = Join-Path $PSScriptRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py)) {
  Write-Host 'No virtual environment found at venv\.' -ForegroundColor Red
  Write-Host 'Create it once with:' -ForegroundColor Yellow
  Write-Host '    py -3.11 -m venv venv'
  Write-Host '    .\venv\Scripts\python.exe -m pip install -r requirements.txt'
  exit 1
}

# Catches a venv whose interpreter was deleted or whose pyvenv.cfg points at
# a Python that has since been uninstalled — the error from that is otherwise
# a bare DLL failure.
try {
  $ver = & $py --version 2>&1
  if ($LASTEXITCODE -ne 0) { throw $ver }
} catch {
  Write-Host "The venv interpreter will not run: $_" -ForegroundColor Red
  Write-Host 'Recreate it with: py -3.11 -m venv venv --clear' -ForegroundColor Yellow
  exit 1
}

# --- the port ----------------------------------------------------------------

$held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($held) {
  $owner = Get-Process -Id $held[0].OwningProcess -ErrorAction SilentlyContinue
  $name = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $($held[0].OwningProcess)" }
  Write-Host "Port $Port is already in use by $name." -ForegroundColor Red
  Write-Host 'Either stop it:' -ForegroundColor Yellow
  Write-Host "    Stop-Process -Id $($held[0].OwningProcess)"
  Write-Host 'or start this one somewhere else:' -ForegroundColor Yellow
  Write-Host "    .\run.ps1 -Port $($Port + 1)"
  exit 1
}

# --- the console build -------------------------------------------------------

# FastAPI serves web\dist when it exists and falls back to the no-build
# vanilla console otherwise. That fallback is a real page, so a missing build
# is a warning and not a failure — but it is worth saying, because "the UI
# looks older than I remember" is a confusing thing to debug.
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'web\dist\index.html'))) {
  Write-Host 'web\dist is not built — serving the fallback console.' -ForegroundColor Yellow
  Write-Host '    cd web; npm install; npm run build' -ForegroundColor DarkGray
}

# --- go ----------------------------------------------------------------------

$uvicornArgs = @(
  '-m', 'uvicorn', 'backend.main:app',
  '--host', $BindHost,
  '--port', $Port
)
if (-not $NoReload) { $uvicornArgs += '--reload' }

Write-Host "Corvex on http://$BindHost`:$Port  ($ver)" -ForegroundColor Green
& $py @uvicornArgs
