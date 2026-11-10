param(
    [string]$Version = $env:FAYE_VERSION
)

$ErrorActionPreference = "Stop"
$repository = if ($env:FAYE_REPOSITORY) { $env:FAYE_REPOSITORY } else { "tangsong404/tangs-toolbox" }
$installDir = if ($env:FAYE_INSTALL_DIR) {
    $env:FAYE_INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA "Faye\bin"
}

$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) {
    $architecture = $env:PROCESSOR_ARCHITECTURE
}
if (-not $architecture) {
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
}

switch ($architecture.ToUpperInvariant()) {
    "AMD64" { }
    "X64" { }
    default {
        throw "Faye requires Windows x64. Detected architecture: $architecture"
    }
}

if ($Version) {
    $tag = if ($Version.StartsWith("faye-v")) {
        $Version
    } elseif ($Version.StartsWith("v")) {
        "faye-$Version"
    } else {
        "faye-v$Version"
    }
} else {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases?per_page=100"
    $release = $releases | Where-Object { -not $_.draft -and $_.tag_name -like "faye-v*" } | Select-Object -First 1
    if (-not $release) {
        throw "No Faye release was found in $repository."
    }
    $tag = $release.tag_name
}
$baseUrl = "https://github.com/$repository/releases/download/$tag"

$target = "x86_64-pc-windows-msvc"
$archiveName = "faye-$target.zip"
$checksumName = "faye-$target.sha256"
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("faye-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null

try {
    $archive = Join-Path $temporary $archiveName
    $checksum = Join-Path $temporary $checksumName
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$checksumName" -OutFile $checksum

    $expected = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA-256 verification failed."
    }

    Expand-Archive -LiteralPath $archive -DestinationPath $temporary
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $temporary "faye-$target\faye.exe") `
        -Destination (Join-Path $installDir "faye.exe") -Force

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if ($entries -notcontains $installDir) {
        $newPath = (@($entries) + $installDir) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    }

    Write-Host "Installed: $(Join-Path $installDir 'faye.exe')"
    Write-Host "Restart the terminal, then run: faye login"
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
