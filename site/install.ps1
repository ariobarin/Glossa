Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-GlossaInstaller {
    if ($env:OS -ne "Windows_NT") {
        throw "This installer supports Windows. Use https://glossa.sh/install.sh on macOS or Linux."
    }

    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    $asset = switch ($architecture) {
        "X64" { "glossa-windows-x64.exe" }
        "Arm64" { "glossa-windows-arm64.exe" }
        default { throw "The Glossa direct installer does not support Windows $architecture. Use npm instead." }
    }

    $api = if ($env:GLOSSA_RELEASES_API) {
        $env:GLOSSA_RELEASES_API
    } else {
        "https://api.github.com/repos/ariobarin/glossa/releases?per_page=20"
    }
    $headers = @{
        "Accept" = "application/vnd.github+json"
        "User-Agent" = "glossa-installer"
    }
    $releases = Invoke-RestMethod -Uri $api -Headers $headers
    $selected = $null
    foreach ($release in $releases) {
        if ($release.draft -or -not $release.tag_name.StartsWith("cli-v")) {
            continue
        }
        $binary = $release.assets | Where-Object name -EQ $asset | Select-Object -First 1
        $checksum = $release.assets | Where-Object name -EQ "$asset.sha256" | Select-Object -First 1
        if ($binary -and $checksum) {
            $selected = @{
                Version = $release.tag_name.Substring(5)
                BinaryUrl = $binary.browser_download_url
                ChecksumUrl = $checksum.browser_download_url
            }
            break
        }
    }
    if (-not $selected) {
        throw "No Glossa direct-install release supports this computer yet. Use npm or try again after the next release."
    }

    $customInstallDirectory = [bool]$env:GLOSSA_INSTALL_DIR
    $installDirectory = if ($customInstallDirectory) {
        $env:GLOSSA_INSTALL_DIR
    } else {
        Join-Path $env:LOCALAPPDATA "Programs\Glossa\bin"
    }
    New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
    $destination = Join-Path $installDirectory "glossa.exe"
    $download = Join-Path $installDirectory "glossa.exe.download"
    $checksumFile = Join-Path $installDirectory "glossa.exe.sha256"

    try {
        Write-Host "Installing Glossa $($selected.Version)..."
        Invoke-WebRequest -Uri $selected.BinaryUrl -OutFile $download -Headers $headers
        Invoke-WebRequest -Uri $selected.ChecksumUrl -OutFile $checksumFile -Headers $headers
        $checksumLine = (Get-Content -LiteralPath $checksumFile -Raw).Trim()
        if ($checksumLine -notmatch '^([a-fA-F0-9]{64})\s+\*?(.+)$' -or $Matches[2] -ne $asset) {
            throw "The Glossa checksum file was invalid."
        }
        $stream = [System.IO.File]::OpenRead($download)
        try {
            $sha256 = [System.Security.Cryptography.SHA256]::Create()
            try {
                $actual = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
            } finally {
                $sha256.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
        if ($actual -ne $Matches[1].ToLowerInvariant()) {
            throw "Glossa refused to install because the SHA-256 checksum did not match."
        }
        Unblock-File -LiteralPath $download
        Move-Item -LiteralPath $download -Destination $destination -Force
    } finally {
        Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $checksumFile -Force -ErrorAction SilentlyContinue
    }

    if (-not $customInstallDirectory) {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $pathEntries = @($userPath -split ";" | Where-Object { $_ })
        if ($pathEntries -notcontains $installDirectory) {
            $newPath = (@($pathEntries) + $installDirectory) -join ";"
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        }
    }
    if (($env:Path -split ";") -notcontains $installDirectory) {
        $env:Path = "$installDirectory;$env:Path"
    }

    $version = (& $destination --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne $selected.Version) {
        throw "Glossa was installed, but its version check failed."
    }
    Write-Host "Installed Glossa $version."
    Write-Host "Next: open a new terminal in a project and run glossa."
    Write-Host "Press Ctrl+C to disconnect."
}

Invoke-GlossaInstaller
