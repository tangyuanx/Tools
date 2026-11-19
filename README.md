# 工具工作台

Windows 10/11 x64 桌面工具。左侧图标直达「命令定向」与「日志采集」，四宫格打开可搜索的工具目录。两个工具各自绑定会话，切换工作区会保留编辑状态与正在运行的任务。

从 [GitHub Releases](https://github.com/tangyuanx/Tools/releases/latest) 下载 **Tools-Workbench-版本号-Windows-x64-Setup.exe**。安装后启动「工具工作台」。右上角版本号用于检查及安装工作台更新。

## 命令定向

从顶部文件菜单打开 UTF-8 TXT 文件，按住「选择目标」拖到要发送的输入区，松开绑定。选择当前命令或连续选区后发送。保留场景目录、查找、保存、目标备注、暂停/继续/停止、循环发送、倒计时与指定时间发送。首次可用仓库附带的 **快速验证.txt**，将目标选为一个空白文本编辑器。

## 日志采集

在 MobaXterm 的 Settings → Configuration → Terminal 开启会话日志，配置保存目录，并重新连接会话。在工作台拖选 MobaXterm 会话，确认准备就绪后开始采集，最后点击「停止并保存」。可以更改保存目录、复制文件名或绝对路径，以及用系统关联应用打开已保存的日志。采集从当前日志末尾开始，边界与校验由原采集引擎处理。

工作台使用独立的应用数据目录。首次可读取已保存的旧版命令文件列表、定时任务与日志保存目录。各工具的窗口绑定需要在工作台重新拖选，定时任务需手动启动。

## 开发与构建

Windows x64 环境需要 Node.js 24、Python 3.12 和 Git。应用在 Windows 上验证与构建。Windows 安装包包含 Python 采集运行时。

    npm ci
    py -3.12 -m pip install -r collector/requirements-build.txt
    npm test
    $env:PYTHONPATH = 'collector'
    py -3.12 -m unittest discover -s collector/tests -v
    npm start
    npm run test:suite
    npm run build:win

设置 TOOLS_PYTHON 可指定开发和构建所用的 Python 可执行文件。构建输出到 artifacts 目录。GitHub Actions 先测试，再安装并启动实际安装包，最后发布与版本号对应的 Release。

命令定向基于 [cmd_send v0.1.27](https://github.com/tangyuanx/cmd_send/tree/7abb019680e9a4edb40d9204b203b8c489dcb0a0)。会话绑定和字节采集基于 [Log_Collector v0.1.11](https://github.com/tangyuanx/Log_Collector/tree/2fe1495380d650a857565a1159c982501fc1042a)。工作台统一管理窗口与更新。
