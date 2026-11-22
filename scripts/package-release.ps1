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
      $resolved = [System.IO.Path]::GetFullPath($file, $Root)
      if (-not $resolved.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive source escaped project: $resolved"
      }
      $entry = [System.IO.Path]::GetRelativePath($Root, $resolved).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $resolved, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose(); $stream.Dispose() }
}

Push-Location -LiteralPath $projectRoot
try {
  if (!(Test-Path -LiteralPath '.next/BUILD_ID') -or !(Test-Path -LiteralPath 'public/sw.js')) {
    throw 'Run npm run build before packaging.'
  }
  $sourceFiles = & rg --files --hidden --no-require-git -g '!.git/' -g '!.env*' -g '!art/generated/**/*.png'
  if ($LASTEXITCODE -ne 0) { throw 'Unable to list project files.' }
  $buildFiles = & rg --files --hidden --no-ignore .next public -g '!.next/cache/' -g '!.next/dev/' -g '!.next/diagnostics/' -g '!.next/types/' -g '!.next/trace*'
  if ($LASTEXITCODE -ne 0) { throw 'Unable to list build files.' }
  $buildFiles += 'package.json', 'package-lock.json', 'next.config.mjs', 'LICENSE'
  Write-ProjectZip -Destination (Join-Path $releaseRoot 'ArcanaJournal-source.zip') -Root $projectRoot -Files $sourceFiles
  Write-ProjectZip -Destination (Join-Path $releaseRoot 'ArcanaJournal-nextjs.zip') -Root $projectRoot -Files $buildFiles
} finally { Pop-Location }
