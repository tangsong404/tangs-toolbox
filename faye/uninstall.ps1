param(
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
$installDir = if ($env:FAYE_INSTALL_DIR) {
    $env:FAYE_INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA "Faye\bin"
}
$binary = Join-Path $installDir "faye.exe"

if (Test-Path -LiteralPath $binary) {
    Remove-Item -LiteralPath $binary -Force
    Write-Host "Removed: $binary"
} else {
    Write-Host "Faye executable was not installed in $installDir"
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
$remaining = @($entries | Where-Object { $_ -ne $installDir })
if ($remaining.Count -ne $entries.Count) {
    [Environment]::SetEnvironmentVariable("Path", ($remaining -join ";"), "User")
    Write-Host "Removed $installDir from the user PATH"
}

if ((Test-Path -LiteralPath $installDir) -and -not (Get-ChildItem -LiteralPath $installDir)) {
    Remove-Item -LiteralPath $installDir -Force
}

$dataDir = if ($env:FAYE_HOME) { $env:FAYE_HOME } else { Join-Path $HOME ".faye" }
if ($Purge) {
    $resolvedData = [System.IO.Path]::GetFullPath($dataDir)
    $resolvedHome = [System.IO.Path]::GetFullPath($HOME)
    $pathRoot = [System.IO.Path]::GetPathRoot($resolvedData)
    if (
        [string]::IsNullOrWhiteSpace($resolvedData) -or
        $resolvedData.TrimEnd("\") -eq $resolvedHome.TrimEnd("\") -or
        $resolvedData -eq $pathRoot
    ) {
        throw "Refusing to remove unsafe data directory: $resolvedData"
    }
    if (Test-Path -LiteralPath $resolvedData) {
        Remove-Item -LiteralPath $resolvedData -Recurse -Force
        Write-Host "Removed data: $resolvedData"
    }
} else {
    Write-Host "Preserved configuration and sessions in $dataDir"
    Write-Host "Run with -Purge to remove them."
}

Write-Host "Open a new terminal to refresh PATH."
