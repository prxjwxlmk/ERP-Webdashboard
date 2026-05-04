@echo off
set SOURCE=%~dp0motorstock.db
set BACKUP=%~dp0backups\motorstock_%date:~-4,4%%date:~-10,2%%date:~-7,2%.db

if not exist "%~dp0backups" mkdir "%~dp0backups"

if not exist "%SOURCE%" (
  echo ERROR: motorstock.db not found at %SOURCE%
  pause
  exit
)

copy "%SOURCE%" "%BACKUP%"
echo Backup done! Saved to: %BACKUP%
pause