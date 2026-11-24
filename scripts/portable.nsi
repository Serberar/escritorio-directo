; Ejecutable unico: no instala ni pide administrador. La primera vez se descomprime en
; %LOCALAPPDATA%\<programa>\app-<build>; despues arranca al instante desde ahi.
; La ruta es fija por version, asi Windows recuerda el permiso del firewall.
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SilentInstall silent
Name "${APP}"
OutFile "${OUT}"
Icon "${ICON}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "LegalCopyright" "${COMPANY}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
!include "FileFunc.nsh"

Section
  StrCpy $R0 "$LOCALAPPDATA\${DIRNAME}"
  StrCpy $INSTDIR "$R0\app-${BUILD}"
  IfFileExists "$INSTDIR\${EXE}" 0 extract
  IfFileExists "$INSTDIR\resources\app.asar" 0 extract
  IfFileExists "$INSTDIR\ffmpeg.dll" run

extract:

  ; Se extrae aparte y se renombra al final: un doble clic repetido o un corte no deja nada a medias.
  System::Call 'kernel32::GetCurrentProcessId() i .r1'
  StrCpy $R1 "$R0\tmp-$1"
  CreateDirectory "$R0"
  SetOutPath "$R1"
  File /r "${SRC}\*.*"
  SetOutPath "$R0"
  ; Copia incompleta (por ejemplo, el antivirus retiro un archivo): se sustituye.
  IfFileExists "$INSTDIR\${EXE}" 0 broken
  IfFileExists "$INSTDIR\resources\app.asar" 0 broken
  IfFileExists "$INSTDIR\ffmpeg.dll" place
broken:
  RMDir /r "$INSTDIR"
place:
  Rename "$R1" "$INSTDIR"
  RMDir /r "$R1" ; solo queda si otra copia termino antes

  IfFileExists "$INSTDIR\${EXE}" clean
  MessageBox MB_ICONSTOP "No se pudo preparar ${APP} en $INSTDIR"
  SetErrorLevel 1
  Quit

clean:
  ; Versiones anteriores: solo si no estan en uso (el renombrado falla si lo estan).
  FindFirst $2 $3 "$R0\app-*"
loop:
  StrCmp $3 "" done
  StrCmp $3 "app-${BUILD}" next
  ClearErrors
  Rename "$R0\$3" "$R0\old-$3"
  IfErrors next
  RMDir /r "$R0\old-$3"
next:
  FindNext $2 $3
  Goto loop
done:
  FindClose $2

run:
  ${GetParameters} $R2
  SetOutPath "$INSTDIR"
  Exec '"$INSTDIR\${EXE}" $R2'
SectionEnd
