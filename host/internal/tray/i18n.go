package tray

import (
	"os"
	"strings"
)

// texts are the tray's user-facing strings.
type texts struct {
	Tooltip          string
	StatusRunning    string // the host runs in this tray
	StatusService    string // the host runs in the background service
	StatusStopped    string // no host answers; the error is on the next line
	OnlineSessions   string // %d: agent sessions not offline
	ServiceDown      string
	ServiceNotBack   string // %d: seconds waited
	OpenLogs         string
	OpenData         string
	LAN              string
	Autostart        string
	Restart          string
	Quit             string
	FirewallNotice   string // %d TCP port, %d UDP discovery port
	FirewallFailed   string // %d TCP port, %d UDP discovery port, %s error
	RestartNoControl string
	Error            string // %s: error
}

var english = texts{
	Tooltip:          "n2n-nexus host",
	StatusRunning:    "Running",
	StatusService:    "Running · background service",
	StatusStopped:    "Not running",
	OnlineSessions:   "Online sessions: %d",
	ServiceDown:      "the background service does not answer",
	ServiceNotBack:   "The background service did not answer within %d s of the restart; see the log folder.",
	OpenLogs:         "Open log folder",
	OpenData:         "Open data folder",
	LAN:              "Allow LAN access",
	Autostart:        "Start at login",
	Restart:          "Restart",
	Quit:             "Quit",
	FirewallNotice:   "LAN access is on. Allow TCP port %d and UDP port %d (discovery) in your firewall so other machines can reach this host.",
	FirewallFailed:   "LAN access is on, but the firewall rules for TCP port %d and UDP port %d were not added: %s",
	RestartNoControl: "The running host was not started by this tray or the background service; restart it where it was started.",
	Error:            "n2n-nexus host: %s",
}

var chinese = texts{
	Tooltip:          "n2n-nexus host",
	StatusRunning:    "运行中",
	StatusService:    "运行中 · 后台服务",
	StatusStopped:    "未运行",
	OnlineSessions:   "在线会话：%d",
	ServiceDown:      "后台服务无响应",
	ServiceNotBack:   "重启后后台服务在 %d 秒内没有响应，请查看日志目录。",
	OpenLogs:         "打开日志目录",
	OpenData:         "打开数据目录",
	LAN:              "允许局域网访问",
	Autostart:        "登录后自启",
	Restart:          "重启",
	Quit:             "退出",
	FirewallNotice:   "已开启局域网访问。请在防火墙中放行 TCP 端口 %d 和 UDP 端口 %d（发现），其他机器才能连接本机。",
	FirewallFailed:   "已开启局域网访问，但没有添加 TCP 端口 %d 和 UDP 端口 %d 的防火墙规则：%s",
	RestartNoControl: "正在运行的 host 不是由托盘或后台服务启动的，请在启动它的地方重启。",
	Error:            "n2n-nexus host：%s",
}

// textsFor is the Chinese texts when zh, else the English ones.
func textsFor(zh bool) texts {
	if zh {
		return chinese
	}
	return english
}

// isChineseLocale reports whether a POSIX locale (zh_CN.UTF-8, zh_TW, zh) is Chinese.
func isChineseLocale(locale string) bool {
	return locale == "zh" || strings.HasPrefix(locale, "zh_") || strings.HasPrefix(locale, "zh-") || strings.HasPrefix(locale, "zh.")
}

// firstAppleLanguage is the first entry of `defaults read -g AppleLanguages`,
// which prints a list such as ( "zh-Hans-CN", "en-US" ) one entry per line.
func firstAppleLanguage(out string) string {
	for _, line := range strings.Split(out, "\n") {
		if v := strings.Trim(strings.TrimSpace(line), `",`); v != "" && v != "(" && v != ")" {
			return v
		}
	}
	return ""
}

// envLocale is the first set of LC_ALL, LC_MESSAGES and LANG.
func envLocale() string {
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if v := os.Getenv(name); v != "" {
			return v
		}
	}
	return ""
}

// isChineseLangID reports whether a Windows LANGID is Chinese (primary language LANG_CHINESE, 0x04).
func isChineseLangID(id uint16) bool { return id&0x3ff == 0x04 }
