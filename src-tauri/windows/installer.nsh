; AIGateway Windows 安装器钩子
;
; 问题背景：
;   proxy-server.exe（sidecar）由主程序作为独立子进程启动，且按设计在父进程
;   退出后继续运行（proxy/proxy-server.js：stdin 关闭时若代理已初始化则不退出，
;   用于跨主程序重启保持服务）。Tauri 默认安装流程只会关闭主程序，
;   仍在运行的 sidecar 锁着自己的 exe，NSIS 覆盖文件时会失败：
;     "Error opening file for writing: <安装目录>\proxy-server.exe"
;   结果就是更新装不上，旧代理还占着端口。
;
; 处理方式：
;   在复制文件之前，用 RestartManager 结束所有占用 sidecar 文件的进程，
;   机制与 Tauri 安装器关闭主程序相同，因此不依赖应用侧代码是否已修复，
;   从任意旧版本升级到带本钩子的版本都能成功。
;
; 注意：这里依赖 sidecar 的实际文件名（bundler 会去掉 target triple）。
; 如果以后重命名 proxy-server，需要同步修改下面的路径。
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping AIGateway proxy sidecar (if running)..."
  !insertmacro RestartManager_ShutdownFile "$INSTDIR\proxy-server.exe" $R9
!macroend
