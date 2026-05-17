@echo off
setlocal
set ROOT_DIR=%~dp0..
pushd %ROOT_DIR%

if "%GATEWAY_PORT%"=="" set GATEWAY_PORT=8080
if "%GATEWAY_WS_PORT%"=="" set GATEWAY_WS_PORT=7000
if "%ROOT_DOMAIN%"=="" set ROOT_DOMAIN=portivox.braintechsolution.com

echo Starting gateway on :%GATEWAY_PORT% (ws:%GATEWAY_WS_PORT%) for *.%ROOT_DOMAIN%
call npm run dev:gateway

popd
endlocal
