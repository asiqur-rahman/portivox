@echo off
setlocal
set ROOT_DIR=%~dp0..
pushd %ROOT_DIR%

if "%TUNNEL_GATEWAY_URL%"=="" set TUNNEL_GATEWAY_URL=ws://localhost:7000/connect
if "%TUNNEL_LOCAL_URL%"=="" set TUNNEL_LOCAL_URL=http://localhost:3000

set ARGS=--gateway %TUNNEL_GATEWAY_URL% --local %TUNNEL_LOCAL_URL%
if not "%TUNNEL_SUBDOMAIN%"=="" set ARGS=%ARGS% --subdomain %TUNNEL_SUBDOMAIN%

echo Starting tunnel client -> %TUNNEL_GATEWAY_URL% => %TUNNEL_LOCAL_URL%
call npm run -w apps/tunnel-client dev -- %ARGS%

popd
endlocal