param(
  [int]$Port = 8765,
  [string]$HostName = "127.0.0.1"
)
$ErrorActionPreference = "Stop"
$siteRoot = Split-Path -Parent $PSScriptRoot
$python = "C:\Users\Eat_Peach\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (-not (Test-Path -LiteralPath $python)) { throw "Bundled Python runtime not found: $python" }
& $python (Join-Path $siteRoot "scripts\serve.py") --host $HostName --port $Port
