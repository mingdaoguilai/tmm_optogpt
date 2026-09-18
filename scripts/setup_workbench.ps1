param(
    [string]$Python = "python"
)

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    & $Python -m pip install -r .\requirements-optogpt.txt
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

    & $Python -m pip install -e .\tmm
    if ($LASTEXITCODE -ne 0) { throw "Local TMM installation failed." }

    Push-Location .\frontend
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed." }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
    }
    finally {
        Pop-Location
    }

    Write-Host "Workbench setup complete." -ForegroundColor Green
    Write-Host "Start it with: .\scripts\start_workbench.ps1 -Python `"$Python`""
}
finally {
    Pop-Location
}
