@echo off
cd /d "%~dp0"

if not exist .env (
  copy .env.example .env
  echo.
  echo Arquivo .env criado a partir do exemplo.
  echo Vou abrir ele no Bloco de Notas - cole sua SUPABASE_SERVICE_KEY no lugar certo, salve e feche.
  echo.
  pause
  notepad .env
) else (
  echo O arquivo .env ja existe. Abrindo para conferencia...
  notepad .env
)

echo.
echo Instalando dependencias (pode levar 1-2 minutos)...
call npm install

echo.
echo ================================
echo Tudo pronto! Iniciando o conector...
echo (se ele cair por algum motivo, reinicia sozinho em 5 segundos)
echo ================================
echo.

:loop
call npm start
echo.
echo O conector parou. Reiniciando em 5 segundos... (Ctrl+C pra cancelar de vez)
timeout /t 5
goto loop
