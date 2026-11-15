# 安全策略

[English version](../SECURITY.md)

## 支持的版本

安全修复针对 n2n-nexus（npm 客户端）和 n2n-nexus-host 的最新发布版本。

## 报告漏洞

疑似漏洞请不要提交公开 issue。

请通过本仓库的 GitHub 私密漏洞报告（private vulnerability reporting）提交安全问题，或通过 Datafrog 组织主页上列出的安全渠道联系我们。

报告时请包含：

- 漏洞描述。
- 复现步骤或概念验证（proof of concept）。
- 受影响的版本或提交哈希。
- 已知的影响或缓解措施。

我们力争在 5 个工作日内确认收到报告。

## 安全模型

n2n-nexus 运行一个本地 HTTP host `n2n-nexus-host`，它把协调数据保存在数据目录（默认 `%LOCALAPPDATA%\n2n-nexus`、`~/Library/Application Support/n2n-nexus` 或 `~/.local/share/n2n-nexus`）下的 `nexus.db` 中。它不会把项目数据发送到远程服务。

需要注意的关键边界：

- **未签名的程序**：`n2n-nexus-host` 的发布程序暂未做代码签名。请用 release 里的 `SHA256SUMS` 和 `gh attestation verify <file> --repo n2ns/n2n-nexus`（构建证明）校验下载的文件，或通过从源码编译的 Homebrew 安装。
- **本机信任模型**：以同一操作系统用户运行的所有进程都被视为可信。host 没有身份认证；这样的进程可以直接调用它，也可以读写 `nexus.db` 以及 `~/.claude`、`~/.codex` 和 `~/.pi` 下的客户端对话记录。对话 ID、Claude 的 tool-use 绑定和 pi 的进程 ID 用于在对话之间路由直接消息；它们不是凭据，所以一个能执行 shell 的 AI 会话可以冒充同一用户的另一个对话。只要数据对该用户可读，host 内部的检查就无法阻止这一点。真正起作用的屏障是客户端执行命令的权限，由用户控制。要让各个代理相互隔离，请让它们以不同的操作系统用户运行，每个用户有自己的 host 和数据目录。

- **Host 的网络暴露**：host 默认绑定 `127.0.0.1`。开启局域网访问（托盘的 **Allow LAN access**、`settings.json` 中的 `"host": "0.0.0.0"` 或 `--host 0.0.0.0`）会把它暴露给本地网络，此时它还会在 UDP `discoveryPort` 上应答局域网发现。开源基础版本没有认证层——只在你能控制的网络上把 host 暴露到 localhost 之外。
- **浏览器请求**：host 没有身份认证，所以它拒绝带浏览器 `Origin` 头或跨站 `Sec-Fetch-Site` 头的请求（403），要求 POST 使用 `Content-Type: application/json`（415），并把请求体限制在 16 MB（413）。它还拒绝任何不是 IP、`localhost`、`host.docker.internal` 或 `settings.json` 中 `allowedHosts` 所列名称的 `Host` 头，以此封堵 DNS rebinding 攻击（网页在攻击者的域名下以同源请求的形式访问 host）。MCP 适配器和脚本不受影响。
- **限流**：工具调用按对话限流，识别不出对话时按实例 ID（默认每秒 20 次、突发 60 次，在 `settings.json` 中用 `rateLimit` / `rateBurst` 设置），另外因为实例 ID 和会话 ID 是自报的，再按客户端地址以 5 倍额度限流。既识别不出对话、也没有指明实例 ID 的工具调用只按地址限流。hooks（`POST /api/hook`）按对话和按客户端地址限流，使用各自独立的桶。超限时 host 返回带 `Retry-After` 的 `429`；`/health` 和 `GET /api/tools` 不限流。
- **格式错误的请求**：无效的请求 URL 或 Host 头返回 400，不会让 host 退出。格式正确的请求仍要经过上面的浏览器和 Host 检查。
- **协调数据中的敏感内容**：项目 manifest、内部文档、会议消息和全局文档以明文保存在 host 的本地数据库中。不要在这些字段里存放密钥、凭据或客户数据。
- **破坏性工具**：项目删除这类破坏性工具应通过明确的审核流程使用。
- **项目资产**：通过 `upload_project_asset` 上传的二进制资产保存在 host 数据目录下的数据库中。请把它们当作具有相同访问控制的本地文件对待。
- **MCP 的 API key**：MCP 适配器通过普通 HTTP 连接 host。如果你把 host 暴露给其他机器，可以考虑在它前面加一个带 TLS 的反向代理。
