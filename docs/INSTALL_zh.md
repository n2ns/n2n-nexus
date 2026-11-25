# n2n-nexus 安装手册

[English version](INSTALL.md)

本手册介绍如何安装 n2n-nexus，让你的 AI 编程会话（Claude Code、Codex、pi 和 Google Antigravity）共享项目和文档、互相发消息。装好以后怎么用，见[使用手册](USER_GUIDE_zh.md)。

## 要安装什么

| 组件 | 是什么 | 装在哪 |
|---|---|---|
| `n2n-nexus-host` | host：保存所有共享数据、在会话之间传递消息的程序。只需在一台机器上运行。 | Windows、macOS 或 Linux |
| `n2n-nexus`（npm） | 客户端：AI 客户端启动的 MCP 服务器，以及告诉 host"这是哪个对话"的 hooks。 | 每台装了 Claude Code、Codex、pi 或 Antigravity 的机器 |

## 1. 安装 host

| 平台 | 安装 |
|---|---|
| Windows（Scoop） | `scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`，然后 `scoop install n2ns/n2n-nexus-host` |
| Windows（发布的 zip） | 从 [Releases](https://github.com/n2ns/n2n-nexus/releases) 下载 `n2n-nexus-host_<版本>_windows_<amd64\|arm64>.zip`，解压后在该目录里运行 `n2n-nexus-host.exe install` |
| Windows（winget） | 即将提供 |
| macOS（Homebrew） | `brew install n2ns/tap/n2n-nexus-host` |
| Linux | 从 [Releases](https://github.com/n2ns/n2n-nexus/releases) 下载 `n2n-nexus-host_<版本>_linux_<amd64\|arm64>.tar.gz`，解压后把 `n2n-nexus-host` 放到 `PATH` 里 |

[Releases](https://github.com/n2ns/n2n-nexus/releases)（标签 `host-v<版本>`）里有各平台的压缩包：Windows 为 `n2n-nexus-host_<版本>_<os>_<arch>.zip`，macOS 和 Linux 为 `.tar.gz`，均有 amd64 和 arm64。用 Release 里的 `SHA256SUMS` 和构建证明校验下载的文件：

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify n2n-nexus-host_<版本>_<os>_<arch>.tar.gz --repo n2ns/n2n-nexus
```

需要知道的：

- 程序暂未做代码签名。Windows 上第一次运行 `n2n-nexus-host.exe` 或 `n2n-nexus-host-tray.exe` 可能弹出 SmartScreen 提示：点 **更多信息 → 仍要运行**。Homebrew 在你的 Mac 上从源码编译 host，所以不会有 Gatekeeper 提示。
- `n2n-nexus-host.exe install`（Windows）把两个程序复制到 `%LOCALAPPDATA%\Programs\n2n-nexus-host`（`--dir` 指定别的目录），第一次安装时打开 **登录后自启**，启动托盘，并说明做了什么。升级也用它：从新版本的发布包里再运行一次；它会替换程序（正在运行的程序先改名为 `.old`，下次安装时删除），结束旧托盘并启动新托盘；后台服务运行的是已安装的程序时，经管理员确认后让服务改用新版本、按原来的数据目录重启。用 Scoop、Homebrew 安装的，用包管理器升级。
- Windows 安装包里有两个程序：`n2n-nexus-host.exe` 用于命令，`n2n-nexus-host-tray.exe` 是托盘程序，不会打开控制台窗口。不带参数运行 `n2n-nexus-host` 会启动托盘程序后立即返回。

## 2. 启动 host

用下面两种方式之一启动：

- **托盘程序**：不带参数运行 `n2n-nexus-host`。托盘第一次运行时会自动打开 **登录后自启**，之后保持你的设置。托盘菜单的用法见[使用手册](USER_GUIDE_zh.md#1-托盘)。
- **后台服务**（开机即启动，不用登录，不带托盘）：在管理员终端（Windows）或用 `sudo`（macOS、Linux）执行 `n2n-nexus-host service install`。服务以安装它的用户身份运行。Linux 上的服务是一个 systemd unit：systemd 没有运行时（容器，或没有启用 systemd 的 WSL）`service install` 会拒绝执行。先退出托盘：托盘正在运行 host 时 `service install` 会拒绝执行。服务在运行时，之后启动的托盘只做控制界面。

Linux 上的托盘需要桌面环境支持 StatusNotifierItem（AppIndicator）；没有桌面的服务器请用 `service install`。各系统上服务和登录后自启注册在哪里，见[架构说明](ARCHITECTURE_zh.md#各平台的托盘与服务)。

## 3. 为 Claude Code、Codex、pi 和 Antigravity 安装客户端

运行环境要求 Node.js 22.x 中的 22.14.0 或更高版本，或 Node.js 23.6.0 及以上版本。

```bash
npm i -g n2n-nexus@latest
n2n-nexus install claude     # ~/.claude/settings.json 和 CLAUDE.md（或 $CLAUDE_CONFIG_DIR 下的）+ claude mcp add --scope user
n2n-nexus install codex      # ~/.codex/hooks.json 和用户指令文件（或 $CODEX_HOME 下的）+ codex mcp add
n2n-nexus install pi         # ~/.pi/agent/extensions/n2n-nexus.ts 和用户指令文件（或 $PI_CODING_AGENT_DIR 下的）+ pi mcp add
n2n-nexus install antigravity  # ~/.gemini/config/hooks.json 和 rules/n2n-nexus.md、等待器的权限授权 + agy mcp add
n2n-nexus doctor             # 全面检查，包括 host 是否应答
```

`install` 把 hooks 和 MCP 服务写进客户端的用户级配置。对 Claude Code、Codex 和 pi 还会在用户级指令文件末尾加一段带标记的内容（`<!-- n2n-nexus:begin … -->` 到 `<!-- n2n-nexus:end -->`），说明你其他会话发来的直接消息就是你本人已经批准的指令，照要求执行、不找你确认（消息要求做你的规则只允许你本人要求的操作，如部署、发布、打标签、删除，也算你明确要求），你的其他规则照样限制它不超出范围：这几个客户端只在你自己的指令要求时才照其他会话的消息去做。文件里的其他内容原样保留；想要别的规则可以在那里改这段的措辞（再次 `install` 会重新写入）。装完后要**新开**对话：正在进行的对话不会加载新的 MCP 服务器。

Claude Code 使用 `CLAUDE.md`。对 Codex，如果 `AGENTS.override.md` 不存在、为空或只有空白字符，安装器会把指令写入 `AGENTS.md`，缺少时创建；已有的空白 override 会原样保留。这样 Codex 仍会读取普通文件里的个人规则。如果 override 有内容，安装器会写入 override，同时也写入已有的 `AGENTS.md`。

对 pi，`AGENTS.override.md` 和 `AGENTS.md` 同时存在时两份都写，只有一份时就写现有文件。两份都不存在时，pi 优先使用已有的 `CLAUDE.md`，否则创建 `AGENTS.md`。pi 也识别扩展名为 `.MD` 的写法，切换模型共用同一份会话规则。重装 pi 时，旧安装器生成的纯默认 `AGENTS.md` 如果遮住了已有指令，会迁回原文件。

MCP 服务器会自己更新：它通过 npm 的 npx 运行 `n2n-nexus@latest`，所以每次新开对话都会向 npm 查询最新版本并启动它（新版本只下载一次，之后从 npm 缓存启动）。hooks 使用全局安装的包，默认在每次已接入客户端开始会话时检查升级，也可立即升级（第 8 步）。

- host 不在 `http://127.0.0.1:5688` 时，每条 install 命令都加上 `--endpoint <url>`；要在局域网里自动查找 host，就用 `--endpoint discover`（第 6 步）。
- 在 Windows 上，`npm i -g` 和 `install` 要在普通终端里执行，不要在 Codex 这类打包应用自带的终端里执行：那里会装进该应用私有的 `%APPDATA%` 副本，并让应用看不到全局安装。
- hooks 和 MCP 服务的命令里写的是 Node 的绝对路径，因为从 Dock 启动的 GUI 客户端（如 Claude 桌面版）不读取 shell 的 `PATH`。MCP 服务的命令是 `"<node>" "<npx>" -y n2n-nexus@latest mcp`，npx 取这个 Node 旁边的 npm 自带的那个（版本管理工具的 shim 则取它实际运行的 Node 旁边的）；同时把 `PATH` 设为一个其中 `node` 就是这个 Node 的目录，后面跟系统目录（`/usr/bin` 和 `/bin`；Windows 上是 `System32` 和 Windows 目录），让 npx 启动的包能找到 Node。默认情况下，`PATH` 上的 `node` 与运行 `install` 的 Node 是同一个文件时，`install` 写入 `PATH` 上的路径（例如 `/usr/local/bin/node`、`/opt/homebrew/bin/node`、`~/.local/bin/node` 或版本管理工具的稳定入口），否则写入当前运行的 Node 的真实路径。`install` 会打印一行 `Node: <path>` 显示实际写入的路径。
- macOS 上用 Claude 桌面版：Code 标签页只需要 `n2n-nexus install claude`，它和 `claude` 命令行读同一份 `~/.claude.json` 和 hooks。不要再把 n2n-nexus 加进桌面版的 `claude_desktop_config.json`：桌面版会把那个服务器桥接进每个 Code 标签页、顶替 Claude Code 自己启动的那份，桥接会丢掉对话身份，直接消息全部报 "This call carries no agent session"。如果已经加了，删掉这一项、重启桌面版、再新开 Code 标签页对话（[用户手册第 2 节](USER_GUIDE_zh.md#2-claude-桌面版)）。
- 用 `--node <path>` 手动指定 Node 路径。路径必须存在、可执行，且版本满足 package.json 的 `engines`（`^22.14.0 || >=23.6.0`），否则 `install` 以退出码 1 退出，不写任何配置。
- 升级 Node 后：如果 `install` 提示 Node 路径位于带版本号的目录（Homebrew `Cellar`、nvm、fnm、Volta、asdf、`node-v<版本>`），每次升级 Node 后都要重新运行 `n2n-nexus install <claude|codex|pi|antigravity>`，或用 `--node` 指定稳定路径。
- 支持 Linux、WSL 和 macOS；Codex hooks 也支持 Windows PowerShell。
- pi 没有 hook 配置：`install pi` 把扩展 `n2n-nexus.ts` 写进 pi 的全局扩展目录（`~/.pi/agent/extensions`，或 `$PI_CODING_AGENT_DIR/extensions`）。它在 pi 的会话开始、提交提示、工具结果（模型自己发起的调用；`codemode` 脚本里的调用由脚本自己的结果覆盖）、一轮运行结束和退出时运行 hook 命令，每轮运行结束后启动后台等待；叫醒时把通知作为下一条用户消息发给 pi。pi 调用 MCP 工具时不附带元数据，所以 pi 启动的 MCP 服务器报上它上面的各级进程（pi 经 npx 和 shell 启动它）和所在机器，host 从中找到最近的 pi 进程，取它最近报告的会话。装完后重新启动 pi（或执行 `/reload`）。用户中断的一轮不会被接着跑，`/reload` 不会结束会话。同名的扩展文件如果不是 n2n-nexus 写的，不会被改动：`install pi` 拒绝执行，`uninstall pi` 跳过它。
- Google Antigravity（IDE 和 `agy` CLI）：`install antigravity` 需要 `PATH` 上有 `agy`。它把名为 `n2n-nexus` 的命名 hook 写进 `~/.gemini/config/hooks.json`（SessionStart、PreInvocation 和 Stop；其他命名 hook 保留），写入规则文件 `~/.gemini/config/rules/n2n-nexus.md`（`trigger: always_on`），并把权限授权 `command(n2n-nexus hook antigravity --wait)`（指定了 `--endpoint` 时带上 ` --endpoint <url>`）加进 IDE 的 `~/.gemini/config/config.json`（`userSettings.globalPermissionGrants.allow`）和 CLI 的 `~/.gemini/antigravity-cli/settings.json`（`permissions.allow`），其他授权和设置都保留；然后用 `agy mcp add` 注册 MCP 服务器。它不改沙箱、模型或权限模式，也不为 n2n-nexus 的 MCP 工具授权：权限策略要求审核时，在交互式 CLI 或 IDE 里 Antigravity 会在第一次调用时请你确认；在 print 模式（`agy -p`、`stream-json`）下它会拒绝这次调用，这一轮也无法结束。Antigravity 没有能在后台等待的 hook，所以由模型按规则启动消息等待器 `n2n-nexus hook antigravity --wait`：`[n2n-nexus]` 通知说等待器没有运行时，模型把它作为后台命令启动；等待器通过 `agy agentapi send-message` 叫醒空闲的对话。这条命令必须能在 `PATH` 上找到（全局 npm 安装）。空闲叫醒取决于模型是否遵守规则，以及权限策略是否允许这条授权运行该命令；没有运行中的等待器时，对话仍会在下一次提示、模型调用之间和一轮结束时收到消息。恢复的对话在下一次提示时重新启动等待器。Windows 上每条 hook 命令是 `powershell -NoProfile -NonInteractive -EncodedCommand …`，因为 Antigravity 通过 `cmd /c` 运行 hook。同名但不是 n2n-nexus 写的规则文件不会被动：`install antigravity` 拒绝执行，`uninstall antigravity` 跳过它。安装后新开一个 Antigravity 对话。

## 4. 启用 Codex 的 hooks（只需一次，必须做）

Codex 不会运行别人写的 hooks，除非它们被信任。没有信任，Codex 对话仍能用共享工具，但收发不了直接消息，host 也看不到它们上线。

`n2n-nexus install codex` 会替你信任 n2n-nexus 的 hooks：它通过 Codex 自己（`codex app-server`）取得每条 hook 的信任哈希并存下，和 Codex 自己的设置做的一样。Windows 上用 Codex 桌面应用实际运行的那份 Codex（`%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe`），其他系统用 `PATH` 上的 `codex`（`NEXUS_CODEX_COMMAND` 可替换两者）。成功时输出 `Trusted the 6 n2n-nexus hooks in Codex (...)`，之后新开一个 Codex 对话即可。

如果输出 `Could not trust the hooks automatically`，就手动信任：

- Codex 桌面应用：打开设置，找到 hooks，信任 n2n-nexus 的几条。
- Codex 命令行：运行 `codex`，输入 `/hooks`，信任 n2n-nexus 的几条。

这几条是 SessionStart、SessionEnd、UserPromptSubmit、PostToolUse 和两条 Stop，命令都是 `n2n-nexus … hook codex`。

需要知道的：

- Codex 按每条 hook 记录信任，存在 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）里，值是 Codex 根据这条 hook 的完整配置算出的哈希。命令行和桌面应用共用这个文件，但哈希的算法随 Codex 版本变化：`PATH` 上的命令行版本和桌面应用自带的那份不一致时，其中一方可能认为 hooks 已被修改。以桌面应用自带的那份为准，所以 `install` 优先用它。
- hook 变了（换了 `--endpoint` 或 `--node`、Node.js 换了路径），或者 Codex 升级后哈希算法变了，都要重新信任。这时 `n2n-nexus doctor codex` 会向 Codex 核对并报告 `FAIL hook trust`，重新运行 `n2n-nexus install codex` 即可。只升级 npm 包不会改变 hooks。
- 当前版本的 Codex 默认开启 hooks。如果管理策略或你自己的 `config.toml` 里设置了 `[features] hooks = false`，hooks 就完全不会运行。

官方文档：[Codex hooks](https://learn.chatgpt.com/docs/hooks)。

Claude Code 不需要这一步：`install claude` 写入 `settings.json` 后，hooks 立即生效。

## 5. 其他 MCP 客户端

其他 MCP 客户端可以使用除直接消息以外的全部工具：

```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": ["-y", "n2n-nexus", "mcp"],
      "env": {
        "NEXUS_ENDPOINT": "http://127.0.0.1:5688"
      }
    }
  }
}
```

适配器可以先于 host 启动。host 可访问后，适配器会加载工具列表。适配器和 hooks 从不自己启动 host：连不上时，工具调用会报错并提示安装并启动它（远程地址则提示需在那台机器上启动），hooks 则跳过：以退出码 0 退出，stdout 不输出，把同样的提示作为一行写到 stderr。host 没有及时应答的调用只让这一次失败，host 可能仍会执行完。

## 6. 多台机器和多个环境

host 默认只监听 `127.0.0.1`。要让它成为可信网络里其他机器的 host：

1. 在 host 所在的机器上打开局域网访问：
   - 托盘：勾选 **允许局域网访问**。托盘把 `"host": "0.0.0.0"` 写进 `settings.json` 并重启 host。Windows 上会在 UAC 确认后添加 TCP 端口和 UDP 发现端口（默认都是 5688）的入站防火墙规则，只对专用和域网络生效，不含公用网络；macOS 和 Linux 上会提示需要在防火墙放行的端口。
   - 服务：`n2n-nexus-host service install --host 0.0.0.0` 把地址写进 `settings.json`；防火墙里的 TCP 5688 和 UDP 5688 需要自己放行。
2. 在其他机器上用 `--endpoint discover` 安装客户端（例如 `n2n-nexus install claude --endpoint discover`），或者直接写 host 的地址。

设为 `discover` 时，适配器和 hooks 在 UDP `NEXUS_DISCOVERY_PORT` 上广播查询，使用第一个应答的 host；结果缓存在 `~/.n2n-nexus/discovered-endpoint`，连不上该 host 时重新查找。只有监听非回环地址（开启了局域网访问）的 host 才应答，所以要在它的防火墙上对可信网络放行 UDP 和 TCP 5688。没有应答时，客户端使用 `http://127.0.0.1:5688`（本机的 host），一分钟后再查找。

| 场景 | `--endpoint` / `NEXUS_ENDPOINT` |
| --- | --- |
| 同一台机器 | `http://127.0.0.1:5688` |
| WSL IDE 连接 Windows host | `http://host.docker.internal:5688` |
| Windows IDE 连接 WSL host | `http://<WSL-IP>:5688` |
| 远程机器 | `http://<Server-IP>:5688` |
| 在局域网里自动查找 host | `discover` |

macOS 上第一次连接时，系统可能会为运行客户端的应用（Claude、终端、VS Code）弹出**本地网络**权限提示。请允许；否则客户端连不上 host（**系统设置 → 隐私与安全性 → 本地网络**）。

IPv6 发现会保持 HTTP 的地址族：本机监听 `::` 时使用 `[::1]`，具体 IPv6 监听地址则按应答中的地址连接。另一台机器的 IPv4 UDP 应答无法确定它的 IPv6 通配监听地址（`::`）；这种情况请配置具体可达的 IPv6 监听地址，或显式指定 `http://[IPv6]:端口`。

## 7. 检查安装

`n2n-nexus doctor [claude|codex|pi|antigravity]` 检查已安装的 hook 命令里的 Node 路径与入口脚本、MCP 命令里的 Node 路径与 npx 是否仍然存在、能否运行，Claude Code 的后台等待 hook 的超时时间是否与客户端一致（旧版 install 写入的更短），Codex 是否信任 Codex 的 hooks（直接问 Codex），Antigravity 是否有写着等待器命令的 n2n-nexus 规则、两个设置文件里是否有等待器的授权、`PATH` 上能否找到 `n2n-nexus`，以及它们连接的 host 是否应答、协议版本是否与客户端一致，有检查失败时以退出码 1 退出。检查会同时读取 hooks 的地址和 MCP 注册中的 `env.NEXUS_ENDPOINT`，一方连接正常不会掩盖另一方的连接故障。

## 8. 升级

在每台使用 n2n-nexus 的机器上，用安装时的用户执行：

```bash
n2n-nexus update
```

这条命令依次检查本机的 host 和全局 npm 客户端，分别报告结果。一项失败仍会检查另一项，任一项失败时最终退出码为 1。只装客户端的机器会跳过 host；通过局域网连接的其他机器各自更新。MCP 适配器仍在新对话启动时使用最新版。

默认情况下，正式版 host 每次开始监听后（前台、托盘内或后台服务）会在后台检查更新。全局 npm 客户端在每次已接入会话的 `SessionStart` 事件中启动独立进程检查，不在每次工具调用时检查。两者都不等待网络才启动，只安装兼容版本，不注册每日任务。需要关闭时，可以分别执行：

```bash
n2n-nexus auto-update off       # 全局 npm 客户端及其 hooks
n2n-nexus-host auto-update off  # 本机 host
```

重启、升级和重新安装都会保留关闭选择。把 `off` 换成 `on` 可以重新开启。`off` 只关闭启动检查，不影响手动升级。运行组件的账户需要能联网并写入安装目录。如果试用过未发布的每日任务测试版，请先用旧版的两条 `auto-update off` 命令注销任务，再更换程序；在新版执行 `on` 即可开启启动检查。

Windows 后台服务在无人登录时也能启动。升级检查由安装服务的用户在登录会话中以普通权限运行，可以使用该用户的网络凭据。用户尚未登录时，检查会等到登录后执行；登录托盘也能补查待处理的请求。

host 会识别原来的 Scoop、Homebrew 或压缩包安装。压缩包升级需要 PATH 上有可用的 GitHub CLI（`gh attestation verify`）以验证发布来源。多个 host 使用同一程序、不同数据目录同时启动时，会等待安装完成，各自重启并验证实际运行版本。已停止的 host 会保持停止。统一命令从 PATH 和标准安装位置查找本机程序，自定义安装目录应在 PATH 上。它会读取主机启动时或执行 `auto-update on --root <目录>` 时记录的数据目录；关闭启动检查不会清除这个位置，也可通过 `NEXUS_ROOT` 指定。

运行 `n2n-nexus doctor` 可以查看最近一次客户端更新失败的原因，包括新版需要协调升级的提示。检查成功后会清除之前的失败记录。

自动更新只安装协议兼容的正式版。host 还会比对数据库迁移；需要协调升级时，命令会提示按该版本的更新日志手动处理。两端各自按版本发布。即使换了终端，升级命令也能识别用 `npm install -g --prefix <目录>` 安装的全局包。升级只刷新模板有变的已注册 hooks，保留原 Node 和连接地址。Claude Code、Codex、pi 的指令块只有在仍与旧版默认内容一致时才会更新；用户修改或删除的内容保持原样。Antigravity 规则同样保留用户改动；旧版升级记录缺少原默认规则的摘要时保留现状。pi 扩展有变时，新开会话或执行 `/reload`。

首次从没有更新命令的版本升级，以及需要协调升级时，沿用原安装方式：

- 客户端运行 `npm i -g n2n-nexus@latest`，按更新日志刷新相应客户端的注册。
- host 使用 `scoop update n2n-nexus-host`、`brew upgrade n2n-nexus-host`，或在新版 Windows 发布包里运行 `n2n-nexus-host.exe install`。其他压缩包安装替换程序后，按原启动方式重启。

## 9. 卸载

`n2n-nexus uninstall <claude|codex|pi|antigravity>` 删除 `install` 写入的 hooks（pi 是它的扩展文件）、MCP 服务，以及 Claude Code、Codex、pi 用户级指令文件里的标记段落（文件里没有别的内容时连文件一起删）；Antigravity 先删除规则文件、命名 hook 和等待器的授权（授权列表、设置文件、`hooks.json` 或 `rules` 目录里没有别的内容时连同它们一起删）；配置里的其他内容不动。已打开的 Antigravity 对话会保留它们的消息等待器，直到对话关闭。

```bash
n2n-nexus uninstall claude
n2n-nexus uninstall codex
n2n-nexus-host service uninstall     # 如果装了服务（管理员终端 / sudo）
n2n-nexus-host autostart off         # 如果托盘设置了登录后自启
```

然后用当初安装 host 的包管理器卸载它，或删掉你放到 `PATH` 里的程序。用 Homebrew 安装的，这样卸载：

```bash
HOMEBREW_NO_AUTOREMOVE=1 brew uninstall n2n-nexus-host
```

从 Homebrew 4.3 起，`brew uninstall` 默认还会运行 `brew autoremove`，删除这台 Mac 上所有作为依赖安装、现在已不被需要的 formula，不限于被卸载的那个（例如别的 formula 当初带进来的 `python@3.13`）。加上 `HOMEBREW_NO_AUTOREMOVE=1` 只删除 `n2n-nexus-host`。Homebrew 为构建 host 安装的 `go` 会保留；运行 `brew autoremove --dry-run` 查看哪些已不被需要，由你自己决定是否删除。
