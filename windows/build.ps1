$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$version = '1.0.4370.26'
$expectedHash = '1C0DACAC84B70109B3FD42F90C53A0BA942ABC3A87590D7A4E0CCD86E4A06CF4'
$packageRoot = Join-Path $PSScriptRoot '.packages'
$package = Join-Path $packageRoot $version
$archive = Join-Path $packageRoot 'webview2.zip'
$output = Join-Path $PSScriptRoot 'bin'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '64bit .NET Framework のC#コンパイラーが必要です。' }
New-Item -ItemType Directory -Force $packageRoot, $output | Out-Null
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'WebView2パッケージのハッシュが一致しません。' }
Expand-Archive -LiteralPath $archive -DestinationPath $package -Force
$libraries = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')
foreach ($library in $libraries) { Copy-Item -LiteralPath (Join-Path $package "lib\net462\$library") -Destination $output -Force }
Copy-Item -LiteralPath (Join-Path $package 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $package 'LICENSE.txt') -Destination (Join-Path $output 'WebView2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $package 'NOTICE.txt') -Destination (Join-Path $output 'WebView2-NOTICE.txt') -Force
$references = @('/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.dll', '/r:System.Core.dll')
foreach ($library in $libraries) { $references += '/r:' + (Join-Path $output $library) }
$sources = @((Join-Path $PSScriptRoot 'BackgroundWindow.cs'), (Join-Path $PSScriptRoot 'Dashboard.cs'))
& $compiler /nologo /target:winexe /platform:x64 /utf8output "/out:$output\PersonalDashboard.exe" @references @sources
if ($LASTEXITCODE -ne 0) { throw 'Windowsアプリのビルドに失敗しました。' }
& $compiler /nologo /target:exe /platform:x64 /utf8output /main:DesktopTests "/out:$output\DesktopTests.exe" @references @sources (Join-Path $PSScriptRoot 'DesktopTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Windows検証プログラムのビルドに失敗しました。' }
Write-Output "ビルド成功: $output\PersonalDashboard.exe"
