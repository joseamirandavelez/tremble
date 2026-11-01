# Tremble device actions. PlatformIO is invoked as a Python module because
# the pio command is not on PATH. Upload only targets a StickS3.
param(
    [Parameter(Position = 0)]
    [ValidateSet('help', 'ports', 'build', 'upload', 'flash', 'monitor', 'run', 'test', 'clean')]
    [string]$Action = 'help',

    [string]$Port,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Show-Help {
    Write-Host @'

Tremble

  .\tremble.cmd ports            List USB serial devices
  .\tremble.cmd build            Compile the firmware
  .\tremble.cmd upload           Flash the StickS3
  .\tremble.cmd monitor          Open the serial monitor
  .\tremble.cmd run              Flash the StickS3, then open the monitor
  .\tremble.cmd test             Check the browser vibration math
  .\tremble.cmd clean            Remove the build output

  .\tremble.cmd upload -Port COM5
  .\tremble.cmd upload -Port COM5 -Force

The Stick is chosen by its USB id. A Tab5 on the same PC is never flashed
unless -Port and -Force are both given. If the Stick does not appear, put it
in bootloader mode by holding the power button for a few seconds. After it
is uploaded, reboot the Stick by pressing the power button once.

'@
}

function Get-DeviceRole {
    param([string]$Vid, [string]$Product)
    if ($Vid -ne '303A') { return 'Other' }
    switch ($Product) {
        '811C' { return 'Stick' }
        '811D' { return 'Stick' }
        '811E' { return 'StickBoot' }
        '1001' { return 'Jtag' }
        '832A' { return 'Tab5' }
        '832B' { return 'Tab5' }
        '832C' { return 'Tab5' }
        default { return 'OtherEspressif' }
    }
}

function Get-DeviceLabel {
    param($Device)
    switch ($Device.Role) {
        'Stick' { return 'StickS3' }
        'StickBoot' { return 'StickS3 UF2 bootloader' }
        'Jtag' { return 'ESP32-S3 USB-JTAG' }
        'Tab5' { return 'M5Stack Tab5' }
        'OtherEspressif' { return 'other Espressif board' }
        default { return 'other USB serial' }
    }
}

function Get-SerialDevices {
    $found = @()
    $pnp = @(Get-PnpDevice -Class Ports -Status OK -ErrorAction SilentlyContinue)
    foreach ($item in $pnp) {
        $id = [string]$item.InstanceId
        if ($id -notmatch 'VID_([0-9A-Fa-f]{4}).*PID_([0-9A-Fa-f]{4})') { continue }
        $vid = $Matches[1].ToUpper()
        $product = $Matches[2].ToUpper()
        $name = [string]$item.FriendlyName
        if ($name -notmatch '\((COM\d+)\)') { continue }
        $role = Get-DeviceRole $vid $product
        $found += [pscustomobject]@{
            Port    = $Matches[1].ToUpper()
            Vid     = $vid
            Product = $product
            Role    = $role
            Name    = $name
        }
    }
    return ,$found
}

function Show-Ports {
    param($Devices)
    if ($Devices.Count -eq 0) {
        Write-Host 'No USB serial devices found.'
        return
    }
    foreach ($device in $Devices) {
        $label = Get-DeviceLabel $device
        $note = ''
        if ($device.Role -eq 'Tab5' -or $device.Role -eq 'OtherEspressif' -or $device.Role -eq 'Other') {
            $note = '  (left alone)'
        }
        Write-Host ("{0,-6} {1}:{2}  {3}{4}" -f $device.Port, $device.Vid, $device.Product, $label, $note)
    }
}

function Select-StickPort {
    param($Devices, [string]$Requested, [switch]$AllowOther)

    if ($Requested) {
        $wanted = $Requested.ToUpper()
        $match = $Devices | Where-Object { $_.Port -eq $wanted } | Select-Object -First 1
        if (-not $match) {
            throw "No USB serial device is on $wanted. Run: .\tremble.cmd ports"
        }
        if ($match.Role -eq 'Stick' -or $match.Role -eq 'Jtag') { return $match }
        if (-not $AllowOther) {
            $label = Get-DeviceLabel $match
            throw "$($match.Port) is $label ($($match.Vid):$($match.Product)). Plug in the StickS3, or pass -Force to override."
        }
        Write-Host "Override: flashing $($match.Port), which is $(Get-DeviceLabel $match)."
        return $match
    }

    $sticks = @($Devices | Where-Object { $_.Role -eq 'Stick' })
    if ($sticks.Count -eq 1) { return $sticks[0] }
    if ($sticks.Count -gt 1) {
        throw "More than one StickS3 is connected. Pass -Port COMx."
    }

    $jtag = @($Devices | Where-Object { $_.Role -eq 'Jtag' })
    if ($jtag.Count -eq 1) { return $jtag[0] }
    if ($jtag.Count -gt 1) {
        throw "More than one ESP32-S3 USB-JTAG port is connected. Pass -Port COMx."
    }

    $boots = @($Devices | Where-Object { $_.Role -eq 'StickBoot' })
    if ($boots.Count -ge 1) {
        $names = ($boots | ForEach-Object { $_.Port }) -join ', '
        throw "StickS3 is in the UF2 bootloader on $names. Put it in bootloader mode by holding the power button for a few seconds, then try again."
    }

    throw "StickS3 not found. Plug it in over USB-C. If it still does not appear, put it in bootloader mode by holding the power button for a few seconds."
}

function Get-PioCommand {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        foreach ($version in @('-3.13', '-3')) {
            & py $version -c "import platformio" *> $null
            if ($LASTEXITCODE -eq 0) {
                return @{ Exe = 'py'; Prefix = @($version, '-m', 'platformio') }
            }
        }
    }
    $pio = Get-Command pio -ErrorAction SilentlyContinue
    if ($pio) {
        return @{ Exe = 'pio'; Prefix = @() }
    }
    throw "PlatformIO is not installed for Python 3.13. Install it with: py -3.13 -m pip install --user platformio"
}

function Invoke-Pio {
    param([string[]]$PioArgs)
    $pio = Get-PioCommand
    Write-Host (">> {0} {1}" -f $pio.Exe, (($pio.Prefix + $PioArgs) -join ' '))
    & $pio.Exe @($pio.Prefix + $PioArgs)
    if ($LASTEXITCODE -ne 0) {
        throw "PlatformIO exited with code $LASTEXITCODE."
    }
}

function Invoke-Upload {
    param($Devices)
    $target = Select-StickPort $Devices $Port -AllowOther:$Force
    $label = Get-DeviceLabel $target
    Write-Host "Flashing $($target.Port) ($($target.Vid):$($target.Product), $label)."
    Invoke-Pio @('run', '-t', 'upload', '--upload-port', $target.Port)
    Write-Host "Upload finished. Reboot the Stick by pressing the power button once."
}

function Invoke-Monitor {
    param($Devices)
    $target = Select-StickPort $Devices $Port -AllowOther:$Force
    Write-Host "Monitoring $($target.Port). Press Ctrl+C to stop."
    Invoke-Pio @('device', 'monitor', '--port', $target.Port)
}

try {
switch ($Action) {
    'help' {
        Show-Help
    }
    'ports' {
        Show-Ports (Get-SerialDevices)
    }
    'build' {
        Invoke-Pio @('run')
    }
    'upload' {
        Invoke-Upload (Get-SerialDevices)
    }
    'flash' {
        Invoke-Upload (Get-SerialDevices)
    }
    'monitor' {
        Invoke-Monitor (Get-SerialDevices)
    }
    'run' {
        $devices = Get-SerialDevices
        Invoke-Upload $devices
        Invoke-Monitor (Get-SerialDevices)
    }
    'test' {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { throw "Node.js is required to run scripts\test_dsp.mjs." }
        & node (Join-Path $Root 'scripts\test_dsp.mjs')
        if ($LASTEXITCODE -ne 0) { throw "DSP check failed." }
    }
    'clean' {
        Invoke-Pio @('run', '-t', 'clean')
    }
}
} catch {
    Write-Host $_.Exception.Message
    exit 1
}
