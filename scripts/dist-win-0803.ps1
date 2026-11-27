$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\cairr\Documents\Codex\2026-11-21\sie\openbot-merge'
# Git's tar in PATH is GNU tar, which reads a Windows path as a remote host; Windows' own tar must win.
$env:PATH = 'C:\Windows\System32;' + $env:PATH
$steps = @(
  { bun run voice:prepare-runtime },
  { bun scripts/prepare-remote-desktop-runtime.ts win32 x64 },
  { bun run verify:remote-desktop-runtime --windows },
  { bun scripts/install-cua-driver.ts win32 x64 },
  { bun run build },
  { npx electron-builder --win nsis --x64 --publish never }
)
foreach ($step in $steps) {
  & $step
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Output 'BUILD_SUCCESS'

