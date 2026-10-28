@echo off
title MailBox Socket Tactics - Event Broker
cd /d "%~dp0.."
node src\service\ServiceRunner.js --broker
if errorlevel 1 pause
