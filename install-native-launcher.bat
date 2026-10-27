@echo off
rem ============================================================================
rem Fush MCP - Native Launcher install (HKCU, no admin needed)
rem
rem What it does:
rem   1) Generates native-messaging-host.json from native-messaging-host.json.template,
rem      filling in THIS machine's absolute path to native-host.cmd.
rem      Why: a native messaging manifest must contain an absolute path, so the
rem      repo must NOT ship one -- otherwise it only ever works on the machine it
rem      was generated on (the original file shipped the author's own path, so
rem      "open the popup switch to auto-start the server" silently failed for
rem      everyone else, and running this installer did not fix it either).
rem   2) Registers that JSON for Edge + Chrome (HKCU = current user, no admin).
rem
rem Usage:
rem   install-native-launcher.bat                  generate + register
rem   install-native-launcher.bat --generate-only  generate only, NO registry write
rem
rem Re-run this whenever the project folder moves.
rem ============================================================================
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "HOST_JSON=%ROOT%\native-messaging-host.json"

echo [1/2] Generating native-messaging-host.json from template...
rem UTF8Encoding($false) = UTF-8 WITHOUT BOM. PowerShell 5.1's `Set-Content -Encoding UTF8`
rem would add a BOM; Chrome/Edge's native messaging parser expects plain UTF-8, and the
rem template itself is BOM-less, so write it the same way.
rem Path is taken from $env:ROOT (set above) so this file never hardcodes a directory.
powershell -NoProfile -Command "$root = $env:ROOT; $tpl = Join-Path $root 'native-messaging-host.json.template'; $out = Join-Path $root 'native-messaging-host.json'; if (-not (Test-Path $tpl)) { Write-Host ('  [x] template not found: ' + $tpl); exit 1 }; $hostCmd = (Join-Path $root 'native-host.cmd'); $esc = $hostCmd.Replace('\', '\\'); $text = [System.IO.File]::ReadAllText($tpl, [System.Text.Encoding]::UTF8); if ($text -notmatch '__ADB_NATIVE_HOST_PATH__') { Write-Host '  [x] template is missing the __ADB_NATIVE_HOST_PATH__ placeholder'; exit 1 }; $text = $text.Replace('__ADB_NATIVE_HOST_PATH__', $esc); [System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false))); Write-Host ('  [ok] ' + $out)"
if errorlevel 1 (
  echo.
  echo [x] Failed to generate the manifest. Nothing was registered.
  pause
  exit /b 1
)

if /I "%~1"=="--generate-only" (
  echo.
  echo [2/2] Skipped (--generate-only): no registry write.
  echo.
  echo ----- generated manifest -----
  type "%HOST_JSON%"
  echo.
  echo -------------------------------
  exit /b 0
)

echo [2/2] Registering with Edge + Chrome (HKCU)...
rem V4.9.38 (batch-4 audit D-07): check errorlevel. Previously the script printed
rem "Done. Registered" unconditionally -- a failed write (group policy, locked key)
rem looked exactly like success and sent the user down the wrong diagnosis path.
set "REG_FAIL=0"
powershell -NoProfile -Command "New-Item -Path 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.adb.http_launcher' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.adb.http_launcher' -Name '(default)' -Value $env:HOST_JSON"
if errorlevel 1 set "REG_FAIL=1"
powershell -NoProfile -Command "New-Item -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.adb.http_launcher' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.adb.http_launcher' -Name '(default)' -Value $env:HOST_JSON"
if errorlevel 1 set "REG_FAIL=1"
echo.
if "%REG_FAIL%"=="1" goto :reg_failed
echo Done. Registered for Edge + Chrome (current user). Re-run if the project folder moves.
echo NOTE: if the extension ID ever changes, update allowed_origins in the .template first.
pause
exit /b 0

:reg_failed
echo [x] Registry write failed for at least one browser -- the native launcher will NOT auto-start.
echo     Check with: reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.adb.http_launcher"
echo     Group policy can block HKCU writes; in that case nothing was registered.
pause
exit /b 1
