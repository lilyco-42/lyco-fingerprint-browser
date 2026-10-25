$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Disposable Windows GitHub Actions only'
}
$setup = @(Get-ChildItem out/make -Recurse -File -Filter '*.exe')
$package = @(Get-ChildItem out/make -Recurse -File -Filter '*-full.nupkg')
if ($setup.Count -ne 1 -or $package.Count -ne 1) { throw 'Expected one owned Setup and full package' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($package[0].FullName)
try {
    $spec = @($archive.Entries | Where-Object { $_.FullName.EndsWith('.nuspec') })
    if ($spec.Count -ne 1) { throw 'Expected one package manifest' }
    $reader = [IO.StreamReader]::new($spec[0].Open())
    try { $manifestText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $manifest = [Xml.XmlDocument]::new()
    $manifest.XmlResolver = $null
    $manifest.LoadXml($manifestText)
    $packageId = $manifest.SelectSingleNode("/*[local-name()='package']/*[local-name()='metadata']/*[local-name()='id']").InnerText
    $packageVersion = $manifest.SelectSingleNode("/*[local-name()='package']/*[local-name()='metadata']/*[local-name()='version']").InnerText
} finally { $archive.Dispose() }
if ($packageId -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,80}$') { throw 'Unsafe package identity' }
if ($packageVersion -notmatch '^\d+\.\d+\.\d+$' -or [Version]$packageVersion -le [Version]'0.1.0') { throw 'Expected a new version after the historical 0.1.0 package' }
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$installRoot = [IO.Path]::GetFullPath((Join-Path $localRoot $packageId))
if (-not $installRoot.StartsWith($localRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install target escaped the disposable user directory'
}
if (Test-Path -LiteralPath $installRoot) { throw 'Refusing to modify an existing installation' }
$report = [ordered]@{ source=$env:GITHUB_SHA; run=$env:GITHUB_RUN_ID; productAcceptance=$false;
    version=$packageVersion; baselineInstalled=$false; upgraded=$false;
    installed=$false; installedRenderer=$false; iconAvailable=$false; shortcutCount=0; uninstalled=$false;
    setupSha256=(Get-FileHash $setup[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
$installedExe = $null
$shortcuts = @()

function Stop-OwnedInstalledProcesses {
    Get-CimInstance Win32_Process -Filter "Name='lyco-browser.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

try {
    # Historical owned release is a fixed, hash-verified upgrade fixture only.
    $fixtureDirectory = Join-Path $env:RUNNER_TEMP 'lyco-owned-upgrade-baseline'
    New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
    $baselineSetup = Join-Path $fixtureDirectory 'Setup-0.1.0.exe'
    Invoke-WebRequest -Uri 'https://github.com/lilyco-42/lyco-fingerprint-browser/releases/download/ci-2/LYCO.Browser-0.1.0.Setup.exe' -OutFile $baselineSetup -TimeoutSec 180
    if ((Get-FileHash $baselineSetup -Algorithm SHA256).Hash.ToLowerInvariant() -ne '4c1b207c8a7446f9bfa6bc71922cc1364ca913127ceb9f9a9b70177724a599a3') { throw 'Historical upgrade fixture digest mismatch' }
    $baseline = Start-Process -FilePath $baselineSetup -ArgumentList '--silent' -PassThru -Wait -WindowStyle Hidden
    if ($baseline.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $installRoot 'app-0.1.0/lyco-browser.exe'))) { throw 'Historical upgrade fixture did not install' }
    $report.baselineInstalled = $true
    Stop-OwnedInstalledProcesses
    $install = Start-Process -FilePath $setup[0].FullName -ArgumentList '--silent' -PassThru -Wait -WindowStyle Hidden
    if ($install.ExitCode -ne 0) { throw 'Setup executable failed' }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $candidate = Join-Path $installRoot ("app-$packageVersion/lyco-browser.exe")
        if (Test-Path -LiteralPath $candidate) { $installedExe = $candidate; break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $installedExe) { throw 'Setup did not create the owned installed application' }
    $report.installed = $true
    Stop-OwnedInstalledProcesses
    $portable = Get-Content -LiteralPath windows-preview-smoke.json -Raw | ConvertFrom-Json
    if ((Get-FileHash $installedExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $portable.executableSha256) { throw 'Installed executable differs from the validated portable build' }
    $report.upgraded = $true
    Add-Type -AssemblyName System.Drawing
    $icon = [Drawing.Icon]::ExtractAssociatedIcon($installedExe)
    try { $report.iconAvailable = $null -ne $icon -and $icon.Width -gt 0 } finally { if ($icon) { $icon.Dispose() } }
    if (-not $report.iconAvailable) { throw 'Installed application icon could not be read' }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($root in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('DesktopDirectory'))) {
        foreach ($link in @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
            $target = $shell.CreateShortcut($link.FullName).TargetPath
            if ($target -and $target.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                $shortcuts += $link.FullName
            }
        }
    }
    $report.shortcutCount = $shortcuts.Count
    if ($shortcuts.Count -eq 0) { throw 'Installer did not create an owned launch shortcut' }
    node scripts/windows-preview-smoke.cjs $installedExe windows-installed-smoke.json
    if ($LASTEXITCODE -ne 0) { throw 'Installed application renderer/IPC smoke failed' }
    $report.installedRenderer = $true
} finally {
    $cleanupError = $null
    try {
        Stop-OwnedInstalledProcesses
        $updater = Join-Path $installRoot 'Update.exe'
        if (Test-Path -LiteralPath $updater) {
            $uninstall = Start-Process -FilePath $updater -ArgumentList '--uninstall','--silent' -PassThru -Wait -WindowStyle Hidden
            if ($uninstall.ExitCode -ne 0) { throw 'Owned uninstall executable failed' }
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while ($installedExe -and (Test-Path -LiteralPath $installedExe) -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 250
            }
            $remainingLinks = @($shortcuts | Where-Object { Test-Path -LiteralPath $_ })
            $report.uninstalled = $report.installed -and -not (Test-Path -LiteralPath $installedExe) -and $remainingLinks.Count -eq 0
            if (-not $report.uninstalled) { throw 'Owned installed executable or shortcuts remain after uninstall' }
        }
    } catch { $cleanupError = $_ }
    $report | ConvertTo-Json | Set-Content -Encoding utf8 windows-installer-smoke.json
    $report | ConvertTo-Json -Compress | Write-Output
    if ($cleanupError) { throw $cleanupError }
}
