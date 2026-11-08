# Builds native\build\egctl.exe and egcap.exe (10-bit capture helper) with MSVC (Visual Studio 2022+ with "Desktop development with C++").
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'MSVC not found. Install Visual Studio Build Tools with "Desktop development with C++".' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'build'
New-Item -ItemType Directory -Force $out | Out-Null
$builds = @(
  @{ name = 'egctl'; libs = 'setupapi.lib hid.lib cfgmgr32.lib strmiids.lib ole32.lib oleaut32.lib' },
  @{ name = 'egcap'; libs = 'mfplat.lib mf.lib mfreadwrite.lib mfuuid.lib ole32.lib oleaut32.lib windowscodecs.lib' }
)
foreach ($b in $builds) {
  $src = Join-Path $PSScriptRoot "$($b.name).cpp"
  $cl = "cl /nologo /O2 /EHsc /W4 /std:c++17 /DUNICODE /D_UNICODE `"$src`" /Fo`"$out\\`" /Fe`"$out\$($b.name).exe`" $($b.libs)"
  & "$env:SystemRoot\System32\cmd.exe" /c "`"$vcvars`" >nul && $cl"
  if ($LASTEXITCODE -ne 0) { throw "cl failed for $($b.name) ($LASTEXITCODE)" }
  Remove-Item "$out\$($b.name).obj" -ErrorAction SilentlyContinue
  Write-Host "Built $out\$($b.name).exe"
}
