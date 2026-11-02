@echo off
rem Run the service manager implementation beside this script, forwarded arguments included.
node "%~dp0dsh-superagent.mjs" %*
