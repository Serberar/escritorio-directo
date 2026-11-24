; Todo programa externo se llama con ruta completa: el instalador corre como administrador y,
; sin ella, Windows ejecutaria antes un archivo con ese nombre colocado junto al instalador.
!include "nsProcess.nsh"

; Sustituye la comprobacion de electron-builder, que llama a taskkill y tasklist sin ruta.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
    Quit
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $R0
    Sleep 1500
  ${endIf}
!macroend

; Reglas de firewall limitadas a este programa, a sus dos puertos y a redes privadas o de dominio.
!macro customInstall
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${PRODUCT_NAME}"'
  Pop $R0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${PRODUCT_NAME}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=TCP localport=47600 profile=private,domain'
  Pop $R0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${PRODUCT_NAME}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=UDP localport=47601 profile=private,domain'
  Pop $R0
!macroend
!macro customUnInstall
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${PRODUCT_NAME}"'
  Pop $R0
!macroend
