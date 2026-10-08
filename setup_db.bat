@echo off
REM ============================================================================
REM  XMP local DB setup — XAMPP (MySQL/MariaDB)
REM  XAMPP Control Panel me MySQL "Start" hone ke baad ye file double-click karo
REM  (ya: cmd me  setup_db.bat  chalao)
REM ============================================================================

setlocal
set MYSQL="C:\xampp\mysql\bin\mysql.exe"
set DBUSER=root
set DBPASS=
set DBNAME=xmp_db
set BASE=%~dp0

if not exist %MYSQL% (
  echo [X] %MYSQL% nahi mila. Agar XAMPP kisi aur drive par hai to is file me
  echo     MYSQL path theek kar do.
  pause
  exit /b 1
)

echo.
echo === 1/8  Database %DBNAME% bana rahe hain (agar nahi hai) ===
%MYSQL% -u %DBUSER% %PASSARG% -e "CREATE DATABASE IF NOT EXISTS %DBNAME% CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
if errorlevel 1 goto :fail

REM  -- password blank hai to -p mat lagao; agar aapne root ka password set kiya
REM     hai to niche har line me  -p%DBPASS%  add kar dena.

echo === 2/8  users.sql ===
%MYSQL% -u %DBUSER% %DBNAME% < "%BASE%db_bkp\Dump20260504 (2)\users.sql"       || goto :fail
echo === 3/8  projects.sql ===
%MYSQL% -u %DBUSER% %DBNAME% < "%BASE%db_bkp\Dump20260504 (2)\projects.sql"     || goto :fail
echo === 4/8  project_code.sql ===
%MYSQL% -u %DBUSER% %DBNAME% < "%BASE%db_bkp\Dump20260504 (2)\project_code.sql" || goto :fail
echo === 5/8  holidays.sql ===
%MYSQL% -u %DBUSER% %DBNAME% < "%BASE%db_bkp\Dump20260504 (2)\holidays.sql"     || goto :fail
echo === 6/8  add_in_table.sql ===
%MYSQL% -u %DBUSER% %DBNAME% < "%BASE%add_in_table.sql"
echo === 7/8  xmp_db_pm_pmo_module.sql ===
%MYSQL% -u %DBUSER% %DBNAME% < "%BASE%db_bkp\xmp_db_pm_pmo_module.sql"          || goto :fail
echo === 8/8  xmp_db_user_module.sql ===
%MYSQL% -u %DBUSER% %DBNAME% < "%BASE%db_bkp\xmp_db_user_module.sql"            || goto :fail

echo.
echo ============================================================
echo  DONE. Ab  npm install  (pehli baar)  phir  npm start
echo  Backend: http://localhost:8021
echo ============================================================
pause
exit /b 0

:fail
echo.
echo [X] Kuch galat hua — upar ki error dekho.
pause
exit /b 1
