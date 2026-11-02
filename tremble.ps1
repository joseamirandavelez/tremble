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
  .\tremble.cmd upload           Flash the StickS3 (no bootloader needed)
  .\tremble.cmd monitor          Open the serial monitor
  .\tremble.cmd run              Flash the StickS3, then open the monitor
  .\tremble.cmd test             Check the browser vibration math
  .\tremble.cmd clean            Remove the build output

  .\tremble.cmd upload -Port COM5
  .\tremble.cmd upload -Port COM5 -Force

Upload uses the Stick's ESP32-S3 USB-JTAG port when it is present, so you do
not need to hold the power button for bootloader mode. A Tab5 on the same PC
is never flashed unless -Port and -Force are both given.

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
        'Stick' { return 'StickS3 CDC' }
        'StickBoot' { return 'StickS3 UF2 bootloader' }
        'Jtag' { return 'StickS3 USB-JTAG' }
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
        if ($device.Role -eq 'Jtag') {
            $note = '  (preferred for upload)'
        } elseif ($device.Role -eq 'Tab5' -or $device.Role -eq 'OtherEspressif' -or $device.Role -eq 'Other') {
            $note = '  (left alone)'
        }
        Write-Host ("{0,-6} {1}:{2}  {3}{4}" -f $device.Port, $device.Vid, $device.Product, $label, $note)
    }
}

function Resolve-RequestedPort {
    param($Devices, [string]$Requested, [switch]$AllowOther)
    $wanted = $Requested.ToUpper()
    $match = $Devices | Where-Object { $_.Port -eq $wanted } | Select-Object -First 1
    if (-not $match) {
        throw "No USB serial device is on $wanted. Run: .\tremble.cmd ports"
    }
    if ($match.Role -eq 'Stick' -or $match.Role -eq 'Jtag' -or $match.Role -eq 'StickBoot') {
        return $match
    }
    if (-not $AllowOther) {
        $label = Get-DeviceLabel $match
        throw "$($match.Port) is $label ($($match.Vid):$($match.Product)). Plug in the StickS3, or pass -Force to override."
    }
    Write-Host "Override: using $($match.Port), which is $(Get-DeviceLabel $match)."
    return $match
}

function Select-OneRole {
    param($Devices, [string]$Role, [string]$ManyMessage)
    $hits = @($Devices | Where-Object { $_.Role -eq $Role })
    if ($hits.Count -eq 1) { return $hits[0] }
    if ($hits.Count -gt 1) { throw $ManyMessage }
    return $null
}

# USB-JTAG (PID 1001) can flash a running Stick without holding the power
# button. CDC often needs bootloader mode, so upload prefers JTAG first.
function Select-UploadPort {
    param($Devices, [string]$Requested, [switch]$AllowOther)

    if ($Requested) {
        return Resolve-RequestedPort $Devices $Requested -AllowOther:$AllowOther
    }

    $jtag = Select-OneRole $Devices 'Jtag' 'More than one ESP32-S3 USB-JTAG port is connected. Pass -Port COMx.'
    if ($jtag) { return $jtag }

    $boot = Select-OneRole $Devices 'StickBoot' 'More than one StickS3 bootloader port is connected. Pass -Port COMx.'
    if ($boot) { return $boot }

    $stick = Select-OneRole $Devices 'Stick' 'More than one StickS3 CDC port is connected. Pass -Port COMx.'
    if ($stick) {
        Write-Host "No USB-JTAG port found. Flashing CDC $($stick.Port). If this fails, reconnect USB-C so USB-JTAG appears."
        return $stick
    }

    throw "StickS3 not found. Plug it in over USB-C and run: .\tremble.cmd ports"
}

function Select-MonitorPort {
    param($Devices, [string]$Requested, [switch]$AllowOther)

    if ($Requested) {
        return Resolve-RequestedPort $Devices $Requested -AllowOther:$AllowOther
    }

    $stick = Select-OneRole $Devices 'Stick' 'More than one StickS3 CDC port is connected. Pass -Port COMx.'
    if ($stick) { return $stick }

    $jtag = Select-OneRole $Devices 'Jtag' 'More than one ESP32-S3 USB-JTAG port is connected. Pass -Port COMx.'
    if ($jtag) { return $jtag }

    $boot = Select-OneRole $Devices 'StickBoot' 'More than one StickS3 bootloader port is connected. Pass -Port COMx.'
    if ($boot) { return $boot }

    throw "StickS3 not found. Plug it in over USB-C and run: .\tremble.cmd ports"
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
    $target = Select-UploadPort $Devices $Port -AllowOther:$Force
    $label = Get-DeviceLabel $target
    Write-Host "Flashing $($target.Port) ($($target.Vid):$($target.Product), $label)."
    if ($target.Role -eq 'Jtag') {
        Write-Host "USB-JTAG upload: bootloader mode is not required."
    }
    Invoke-Pio @('run', '-t', 'upload', '--upload-port', $target.Port)
    Write-Host "Upload finished. The Stick should reset on its own."
}

function Invoke-Monitor {
    param($Devices)
    $target = Select-MonitorPort $Devices $Port -AllowOther:$Force
    Write-Host "Monitoring $($target.Port) ($(Get-DeviceLabel $target)). Press Ctrl+C to stop."
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
        Invoke-Upload (Get-SerialDevices)
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
