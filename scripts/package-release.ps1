$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

function Write-ProjectZip {
  param([string]$Destination, [string]$Root, [string[]]$Files)
  $stream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create)
  $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $Files) {
      $resolved = [System.IO.Path]::GetFullPath($file)
      if (-not $resolved.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive source escaped project: $resolved"
      }
      $entry = [System.IO.Path]::GetRelativePath($Root, $resolved).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $resolved, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose(); $stream.Dispose() }
}

$sourceFiles = & rg --files --hidden $projectRoot -g '!node_modules/**' -g '!dist/**' -g '!test-results/**' -g '!playwright-report/**' -g '!release/**' -g '!.git/**' -g '!art/references/style-reference.png' -g '!art/references/rws/**' -g '!art/previews/**' -g '!art/generated/**/*.png' -g '!art/generated/*.png'
if ($LASTEXITCODE -ne 0) { throw 'Unable to list project files.' }
$buildRoot = Join-Path $projectRoot 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'sw.js'))) { throw 'Run npm run build before packaging.' }
$buildFiles = & rg --files --hidden --no-ignore $buildRoot
if ($LASTEXITCODE -ne 0) { throw 'Unable to list build files.' }
Write-ProjectZip -Destination (Join-Path $releaseRoot 'ArcanaJournal-source.zip') -Root $projectRoot -Files $sourceFiles
Write-ProjectZip -Destination (Join-Path $releaseRoot 'ArcanaJournal-cloudflare.zip') -Root $buildRoot -Files $buildFiles
Get-ChildItem -LiteralPath $releaseRoot -Filter '*.zip' | Select-Object Name, Length
