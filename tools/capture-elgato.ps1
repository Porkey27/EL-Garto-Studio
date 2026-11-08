# Captures USB traffic of a connected Elgato device (VID 0FD9) with USBPcap.
#   Start: powershell -File tools\capture-elgato.ps1 -Name settings
#   Stop:  powershell -File tools\capture-elgato.ps1 -Stop
# Writes captures\<Name>-<timestamp>.pcap in the repo. Needs USBPcap with its driver active
# (installing it requires a reboot) and Wireshark's tshark for hub detection.
param(
  [string] $Name = 'capture',
  [switch] $Stop,
  # Packets are truncated to this many bytes: control/HID traffic fits, video payloads are dropped.
  [int] $SnapLen = 512
)

$ErrorActionPreference = 'Stop'
$cmd = 'C:\Program Files\USBPcap\USBPcapCMD.exe'
$tshark = 'C:\Program Files\Wireshark\tshark.exe'
$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'captures'
$pidFile = Join-Path $outDir '.capture.pid'
New-Item -ItemType Directory -Force $outDir | Out-Null

if ($Stop) {
  if (-not (Test-Path $pidFile)) { throw 'No capture is running.' }
  $info = Get-Content $pidFile | ConvertFrom-Json
  Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile
  Write-Host "Stopped. Saved $($info.file)"
  return
}

# Find the root hub carrying the Elgato device: a short capture with injected descriptors
# lists every device on that hub.
$target = $null
$probe = Join-Path $env:TEMP 'egs-probe.pcap'
for ($i = 1; $i -le 16; $i++) {
  $dev = "\\.\USBPcap$i"
  Remove-Item $probe -ErrorAction SilentlyContinue
  $p = Start-Process $cmd -ArgumentList @('-d', $dev, '-A', '--inject-descriptors', '-s', '64', '-o', "`"$probe`"") -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  if (-not (Test-Path $probe)) { continue }
  $vendors = & $tshark -r $probe -Y 'usb.bDescriptorType == 1' -T fields -e usb.idVendor 2>$null
  if ($vendors -match '0x0fd9') { $target = $dev; break }
}
Remove-Item $probe -ErrorAction SilentlyContinue
if (-not $target) { throw 'No USBPcap root hub with an Elgato device found. Is the driver active (reboot after install)?' }

$file = Join-Path $outDir ("{0}-{1:yyyyMMdd-HHmmss}.pcap" -f $Name, (Get-Date))
$p = Start-Process $cmd -ArgumentList @('-d', $target, '-A', '--inject-descriptors', '-s', "$SnapLen", '-o', "`"$file`"") -PassThru -WindowStyle Hidden
@{ pid = $p.Id; file = $file; hub = $target; started = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content $pidFile
Write-Host "Capturing $target -> $file (stop with -Stop)"
