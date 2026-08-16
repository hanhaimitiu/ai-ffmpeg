# AI FFmpeg 音视频工作台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hanhaimitiu/ai-ffmpeg)](https://github.com/hanhaimitiu/ai-ffmpeg/releases)

基于 Electron 的本地音视频处理工具：调用**本机 ffmpeg** 完成转格式、裁剪、压缩、提取音频、加字幕水印等操作，并内置 **自然语言 Agent**——你只需要用中文或英文描述想要的效果，程序会自动调用 ffmpeg 完成。

## ✨ 功能

### 本地 ffmpeg 处理
- 自动检测 ffmpeg / ffprobe（PATH、常见安装目录、项目内 `ffmpeg-static`），也可在设置中手动指定路径
- 常用操作一键执行：转 MP4、提取音频、压缩、转 720p/1080p、转 GIF、静音、倒放、生成封面、降噪
- 自定义参数操作：如「转 avi，截取 10-30s，码率 2000k」直接输入即可
- 任务队列：串行执行、实时进度条、取消任务、历史记录（可一键清空）
- 自动选择输出路径：与源文件隔离，目标重名时自动 `-2` 递增，绝不覆盖已有文件

### 🤖 自然语言 Agent（大模型驱动）

智能助手由**大模型**解析指令：支持任何 OpenAI 兼容接口（DeepSeek / OpenAI / 通义千问 / Moonshot / 智谱 GLM / **llama.cpp 本地模型** / Ollama 等）。Agent 会把"媒体信息 + 操作能力 Schema"发给大模型，由它返回结构化操作列表再调用 ffmpeg 执行。

- **多步骤指令**：一句话里可以包含多个操作（如"转 mp4 + 截取前 30 秒 + 压缩"），每个步骤都会解析为一个 action 并完整执行
- **多轮对话**：助手记得这个会话里说过什么——第一轮"帮我压缩"，第二轮"再压缩一点"，它会结合上下文理解指代并给出新的完整计划
- **会话管理**：支持多个独立会话（新建 / 切换 / 删除），聊天记录与执行结果跨重启持久化保存
- **失败明确提示**：未配置大模型、LLM 不可用或返回无效结果时，助手会明确提示原因，不会静默返回空操作

支持的操作（可自由组合）：
格式转换、裁剪片段、提取音频、静音、分辨率/码率/帧率调整、倍速/减速、倒放、旋转、音量、文字水印、压缩(CRF)、降噪、镜像翻转、封面/帧截图、转 GIF、查询媒体信息。

例：
- 「把 video.mp4 转成 mp3 并压缩」
- 「截取从 10 秒到 30 秒的片段，转 720p，然后加速 2 倍」
- 「在右下角加水印"我的视频"，提取音频为 wav」
- 「这个视频有多长？」
- 第一轮「帮我压缩」→ 第二轮「再压缩一点」（多轮对话理解指代）

### 🎨 界面

- 自绘标题栏（无系统边框），支持拖拽移动、双击最大化
- 三套皮肤：**浅色**（石板灰）/ **深色**（暗石板）/ **暖灰**（石灰），顶栏一键切换，全部为无彩灰系配色
- 顶栏即选即生效并记忆偏好，重启不闪白

## 🚀 快速开始

```bash
npm install          # 安装依赖（Electron）
npm start            # 启动应用
```

> 需要本机已安装 ffmpeg 并加入 PATH（Windows 可下载 gyan.dev 的 essentials 版；macOS 用 `brew install ffmpeg`）。应用启动后若检测不到，可在「设置」中手动指定 ffmpeg.exe 和 ffprobe.exe 路径。
>
> npm 安装 electron 较慢/失败时（国内网络），可指定镜像：
> `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install`

也可以直接下载预编译安装包（自动发布构建，见下文）：前往 [Releases](https://github.com/hanhaimitiu/ai-ffmpeg/releases) 下载对应平台的安装程序（Windows 为 NSIS 安装包，macOS 为 dmg，Linux 为 AppImage）。

### 配置大模型 Agent（可选但推荐）

打开「⚙ 设置」，填写：
1. **服务预设**：选择 DeepSeek / OpenAI / 通义 / Moonshot / 智谱 / Ollama / **llama.cpp**，会自动填入接口地址和模型名
2. **API Key**（本地模型可留空）
3. 点击「测试连接」验证，保存即可

配置成功后，智能助手即由大模型解析指令。

### 🦙 对接本地 llama.cpp（推荐：完全离线）

本地跑 llama.cpp 时（如 `llama-server -m Qwen3.5-4B-Q4_K_M.gguf --port 8080`），它自带 OpenAI 兼容接口：

1. 设置 → 服务预设选 **llama.cpp(本地)**，自动填入 `http://localhost:8080/v1`
2. 点模型名称旁的「**读取**」按钮，自动从接口拉取真实模型名填入（也可手动填 `llama`，llama.cpp 不校验模型名）
3. API Key 留空，点「测试连接」验证即可

应用会通过 `response_format: json_object` 让本地模型直接输出结构化操作 JSON（llama.cpp 与 Ollama 均支持），解析结果无效时自动带提示重试一次。

验证（本地服务启动后）：
```bash
npm run test:real    # 用真实大模型解析自然语言并真实执行 ffmpeg
```

## 🧪 测试

```bash
npm test             # 单元测试：Agent 链路(15) + 命令构建(28) + 会话存储(14)
npm run test:e2e     # 端到端冒烟：真实 ffmpeg 执行（生成测试视频→解析→执行→校验产物）
npm run test:real    # 真实本地大模型验证（含多轮对话用例，需 llama.cpp/Ollama 已启动，未启动时自动跳过）
```

## 📁 项目结构

```
├── main/                    # Electron 主进程
│   ├── main.js              # 无框窗口、IPC、设置持久化、任务调度
│   ├── preload.js           # 安全的渲染进程桥接 API
│   ├── ffmpeg.js            # 二进制探测、ffprobe、带进度的 ffmpeg 执行
│   ├── taskManager.js       # 串行任务队列
│   ├── sessions.js          # 会话存储（多会话 + 持久化 + LLM 上下文）
│   └── agent/
│       ├── agent.js         # 编排：LLM 解析（含多轮历史）+ 输出校验 + 无效重试
│       ├── executor.js      # 操作 → ffmpeg 命令（注意选项位置语义）
│       └── llm.js           # OpenAI 兼容接口调用
├── renderer/                # 渲染进程 UI（原生 HTML/CSS/JS，无框架）
│   ├── index.html
│   ├── style.css            # 三套皮肤（CSS 变量，data-theme 切换）
│   ├── theme-boot.js        # 渲染前应用上次皮肤，避免闪白
│   └── app.js
└── tests/                   # 测试
```

## ⚠️ 说明

- 所有媒体处理都在本机完成，不上传任何文件；仅自然语言指令会发送给你配置的大模型服务
- 裁剪等操作的时长计算依赖 ffprobe 探测结果，播放前建议先在左栏选中文件查看信息
- 文字水印会自动查找系统中文字体（Windows 使用微软雅黑/黑体），找不到时回退默认字体

## 📦 自动发布

本项目使用 **GitHub Actions + electron-builder** 实现发布即自动构建：推送一个 `v*` 格式的 tag 时，CI 会在 Windows / Ubuntu / macOS 三平台上自动打包安装程序并发布到 [GitHub Releases](https://github.com/hanhaimitiu/ai-ffmpeg/releases)。

发布新版本（注意：electron-builder 以 `package.json` 中的 version 作为 release 版本，tag 仅用于触发）：

```bash
# 1. 修改 package.json 的 version（如 1.1.0），提交推送
git commit -am "chore: release v1.1.0"
git push origin main
# 2. 打对应 tag（必须与 version 一致）并推送，触发 CI 自动构建与发布
git tag v1.1.0
git push origin v1.1.0
```

工作流：`npm test` 质量门 → electron-builder 打包（Windows NSIS / macOS dmg / Linux AppImage）→ 上传 GitHub Releases。可在仓库 Actions 页查看进度。

> 本地打包提示：Windows 上若未开启开发者模式，electron-builder 解压 winCodeSign 工具可能因无符号链接权限失败，CI 不受影响（runner 有管理员权限）。本地可设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名。

## 📄 开源许可

本项目基于 [MIT License](LICENSE) 开源。你可以自由使用、修改、分发本项目，包括商业用途，但需保留版权声明；本项目按「原样」提供，不附带任何明示或默示的担保。
