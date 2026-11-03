# NEWAY TMS - local PostgreSQL helper (Windows, portable binaries, no admin rights needed).
#
#   npm run db:start   | db:stop | db:status | db:psql
#   powershell -ExecutionPolicy Bypass -File infra/scripts/db.ps1 <start|stop|restart|status|psql|logs>
#
# Expects the PostgreSQL 16 portable binaries under $env:PGSQL_HOME (default: %USERPROFILE%\pgsql),
# laid out as:
#   <PGSQL_HOME>\pgsql\bin\pg_ctl.exe     binaries (from the EDB "windows-x64-binaries" zip)
#   <PGSQL_HOME>\data                     data directory (created with initdb)
#   <PGSQL_HOME>\log\postgres.log         server log
#
# Production does not use this script; it runs PostgreSQL in a container (infra/docker-compose.yml)
# or a managed service.

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'psql', 'logs')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$home_ = if ($env:PGSQL_HOME) { $env:PGSQL_HOME } else { Join-Path $env:USERPROFILE 'pgsql' }
$bin = Join-Path $home_ 'pgsql\bin'
$data = Join-Path $home_ 'data'
$log = Join-Path $home_ 'log\postgres.log'
$pgctl = Join-Path $bin 'pg_ctl.exe'
$psql = Join-Path $bin 'psql.exe'

if (-not (Test-Path $pgctl)) {
  Write-Host "PostgreSQL binaries not found at $bin" -ForegroundColor Red
  Write-Host "Install the PostgreSQL 16 portable binaries under $home_ (see README.md > Database)."
  exit 1
}

switch ($Action) {
  'start' {
    & $pgctl -D $data -l $log -w start
  }
  'stop' {
    & $pgctl -D $data -m fast -w stop
  }
  'restart' {
    & $pgctl -D $data -l $log -m fast -w restart
  }
  'status' {
    & $pgctl -D $data status
  }
  'psql' {
    $url = if ($env:DATABASE_URL) { $env:DATABASE_URL } else { 'postgres://neway:neway@localhost:5432/neway' }
    & $psql $url
  }
  'logs' {
    Get-Content $log -Tail 50
  }
}

exit $LASTEXITCODE
