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
} finally { $archive.Dispose() }
if ($packageId -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,80}$') { throw 'Unsafe package identity' }
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$installRoot = [IO.Path]::GetFullPath((Join-Path $localRoot $packageId))
if (-not $installRoot.StartsWith($localRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install target escaped the disposable user directory'
}
if (Test-Path -LiteralPath $installRoot) { throw 'Refusing to modify an existing installation' }
$report = [ordered]@{ source=$env:GITHUB_SHA; run=$env:GITHUB_RUN_ID; productAcceptance=$false;
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
    $install = Start-Process -FilePath $setup[0].FullName -ArgumentList '--silent' -PassThru -Wait -WindowStyle Hidden
    if ($install.ExitCode -ne 0) { throw 'Setup executable failed' }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $candidates = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter 'lyco-browser.exe' -ErrorAction SilentlyContinue)
        if ($candidates.Count -eq 1) { $installedExe = $candidates[0].FullName; break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $installedExe) { throw 'Setup did not create the owned installed application' }
    $report.installed = $true
    Stop-OwnedInstalledProcesses
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
