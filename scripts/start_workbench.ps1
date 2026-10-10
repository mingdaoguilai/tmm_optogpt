param(
    [string]$Python = "",
    [int]$Port = 8000,
    [switch]$NoBrowser
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendIndex = Join-Path $projectRoot "frontend\dist\index.html"

if (-not $Python) {
    if ($env:OPTOGPT_PYTHON) { $Python = $env:OPTOGPT_PYTHON }
    elseif (Test-Path -LiteralPath 'D:\anaconda\envs\optogpt\python.exe') {
        $Python = 'D:\anaconda\envs\optogpt\python.exe'
    }
    else { $Python = 'python' }
}

if (-not (Test-Path -LiteralPath $frontendIndex)) {
    throw "Frontend build not found. Run .\scripts\setup_workbench.ps1 first."
}

Push-Location $projectRoot
try {
    $launchArgs = @('-m', 'app', '--port', $Port)
    if ($NoBrowser) { $launchArgs += '--no-browser' }
    & $Python @launchArgs
    if ($LASTEXITCODE -ne 0) { throw "Workbench failed to start with $Python." }
}
finally {
    Pop-Location
}
