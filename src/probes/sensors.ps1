$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cpu = $null
$cimCpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $cimCpu) {
  $cpu = [ordered]@{
    name       = ("$($cimCpu.Name)").Trim()
    cores      = [int]$cimCpu.NumberOfCores
    threads    = [int]$cimCpu.NumberOfLogicalProcessors
    maxClockMhz = [int]$cimCpu.MaxClockSpeed
  }
}

$gpus = @()
foreach ($gpu in @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue)) {
  if ($gpu.Name) { $gpus += ("$($gpu.Name)").Trim() }
}

$thermalZones = @()
foreach ($zone in @(Get-CimInstance -Namespace 'root/wmi' -ClassName 'MSAcpi_ThermalZoneTemperature' -ErrorAction SilentlyContinue)) {
  if ($null -eq $zone.CurrentTemperature) { continue }
  $celsius = [math]::Round((($zone.CurrentTemperature / 10) - 273.15), 1)
  if ($celsius -gt 0 -and $celsius -lt 130) {
    $thermalZones += [ordered]@{ name = ("$($zone.InstanceName)").Trim(); celsius = $celsius }
  }
}

$fans = @()
foreach ($fan in @(Get-CimInstance -ClassName Win32_Fan -ErrorAction SilentlyContinue)) {
  if ($null -ne $fan.DesiredSpeed -and $fan.DesiredSpeed -gt 0) {
    $fans += [ordered]@{ name = ("$($fan.DeviceID)").Trim(); rpm = [int]$fan.DesiredSpeed }
  }
}

$result = [ordered]@{
  cpu          = $cpu
  gpus         = @($gpus)
  thermalZones = @($thermalZones)
  fans         = @($fans)
}

$result | ConvertTo-Json -Depth 5 -Compress
