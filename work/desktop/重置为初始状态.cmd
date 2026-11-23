@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if exist "data-location.txt" (
  echo 这台电脑把资料保存在自定义目录中：
  type "data-location.txt"
  echo.
  echo 为避免误删自定义目录，本脚本已停止。请先在软件中备份资料，
  echo 再使用「设置 - 资料与备份 - 查看资料目录」核对实际位置。
  echo.
  pause
  exit /b 1
)
if not exist "Data" (
  mkdir "Data"
  if not exist "Data" exit /b 1
  echo 已创建空资料目录，当前是初始状态。
  echo 下次启动 DoNote 会用「默认用户」创建一个空资料库。
  echo.
  pause
  exit /b 0
)
echo 这会删除本机的全部记录、附件、批注、回收站内容和本机设置，且无法撤销。
echo 建议先在软件里用「设置 - 资料与备份」导出一份完整备份。
echo.
choice /c YN /n /m "确定重置为初始状态吗？[Y=重置 / N=取消] "
if errorlevel 2 exit /b 0
rmdir /s /q "Data"
if exist "Data" (
  echo.
  echo 重置失败：部分文件仍被占用，请先完全退出 DoNote 再运行一次。
  echo.
  pause
  exit /b 1
)
mkdir "Data"
if not exist "Data" (
  echo 无法创建空资料目录，请检查写入权限。
  pause
  exit /b 1
)
echo.
echo 已重置。下次启动 DoNote 时是一个全新的空资料库，用户为「默认用户」。
echo.
pause
