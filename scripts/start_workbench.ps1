param(
    [string]$Python = "python"
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendIndex = Join-Path $projectRoot "frontend\dist\index.html"

if (-not (Test-Path -LiteralPath $frontendIndex)) {
    throw "Frontend build not found. Run .\scripts\setup_workbench.ps1 first."
}

Push-Location $projectRoot
try {
    & $Python -m app
}
finally {
    Pop-Location
}
