@echo off
title MailBox Socket Tactics - Agent Adapters
cd /d "%~dp0.."
node src\service\ServiceRunner.js --adapters
if errorlevel 1 pause
