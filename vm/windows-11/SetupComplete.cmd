@echo off
rem Windows runs this as SYSTEM at the end of Setup; see autounattend.xml.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remotebrowser-setup.ps1"
