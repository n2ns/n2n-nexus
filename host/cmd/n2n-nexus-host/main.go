// Command n2n-nexus-host runs the n2n-nexus host: by default as a tray
// program, with `serve` in the foreground without a user interface.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/service"
	"github.com/n2ns/n2n-nexus/host/internal/testhooks"
	"github.com/n2ns/n2n-nexus/host/internal/tray"
)

// version is set at build time: -ldflags "-X main.version=0.9.0".
var version = "dev"

const usage = `usage:
  n2n-nexus-host                                   tray (default)
  n2n-nexus-host serve [--host <addr>] [--port <port>] [--root <dir>] [--supervise [--log-dir <dir>]]
  n2n-nexus-host service install|uninstall|status [--host <addr>] [--port <port>] [--root <dir>]
  n2n-nexus-host autostart on|off
  n2n-nexus-host install [--dir <dir>]             Windows: install or upgrade from this release folder
  n2n-nexus-host version
`

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		// Windows: the console build hands the tray to the GUI build next to it and returns.
		if launchTray(executable()) {
			fmt.Println("Started the n2n-nexus-host tray.")
			return
		}
		os.Exit(runTray())
	}
	// The Windows tray build has no console (-H=windowsgui): print to the
	// terminal it was started from, if any.
	attachConsole()
	cmd, args := args[0], args[1:]
	switch cmd {
	case "serve":
		os.Exit(serve(args))
	case "service":
		os.Exit(serviceCmd(args))
	case "autostart":
		os.Exit(autostart(args))
	case "install":
		os.Exit(install(args))
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n%s", cmd, usage)
		os.Exit(2)
	}
}

func executable() string {
	exe, err := service.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return exe
}

func runTray() int {
	dataDir := config.DataDir()
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return 1
	}
	err := tray.Run(tray.Options{Version: version, DataDir: dataDir, LogDir: config.LogDir(), Exe: executable()})
	if err != nil {
		attachConsole()
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// serve runs the host in the foreground until SIGINT / SIGTERM; with
// --supervise it runs `serve` with the other flags as a child instead,
// restarting it 5 s after it exits, and logs to host.log in --log-dir.
func serve(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	hostFlag := fs.String("host", "", "address to listen on (default: settings.json, then 127.0.0.1)")
	port := fs.Int("port", -1, fmt.Sprintf("port to listen on, 0 for any free port (default: settings.json, then %d)", config.Defaults().Port))
	root := fs.String("root", "", "data directory (default: NEXUS_ROOT, then the platform data directory)")
	supervise := fs.Bool("supervise", false, "run serve as a child process and restart it 5 s after it exits")
	logDir := fs.String("log-dir", "", "directory of host.log for --supervise (default: the platform log directory)")
	var test testhooks.Options
	testhooks.RegisterFlags(fs, &test)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "serve: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	if *supervise {
		dir := *logDir
		if dir == "" {
			dir = config.LogDir()
		}
		return superviseServe(fs, dir)
	}
	logger := host.NewLogger(os.Stderr)
	dataDir := *root
	if dataDir == "" {
		dataDir = config.DataDir()
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		logger.Print(err)
		return 1
	}
	started := time.Now() // before the settings load: restart requests from now on are for this serve
	settings, err := config.LoadSettings(dataDir)
	if err != nil {
		logger.Print(err)
		return 1
	}
	settings.Override(*hostFlag, *port)
	supervisor, _ := strconv.Atoi(os.Getenv(host.SupervisorEnv))
	h, err := host.Start(host.Options{Version: version, DataDir: dataDir, Settings: settings, Logger: logger, Test: test, SupervisorPID: supervisor})
	if err != nil {
		logger.Print(err)
		return 1
	}
	// The conformance harness reads the port from this line.
	logger.Print(host.ReadyLine(version, h))
	logger.Printf("data: %s", dataDir)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	restart := make(chan struct{})
	if supervisor > 0 {
		service.WatchSupervisor(supervisor, func() { stop <- syscall.SIGTERM })
		// The tray asks for a restart through a file; its supervisor then starts serve again.
		done := make(chan struct{})
		defer close(done)
		host.WatchRestart(dataDir, started, time.Second, done, func() { close(restart) })
	}
	select {
	case <-stop:
	case <-testhooks.Shutdown():
	case <-restart:
		logger.Print("restart requested")
	}
	logger.Print("shutting down")
	h.Stop()
	return 0
}

// superviseServe runs `serve` with every flag given except --supervise, logging to logDir.
func superviseServe(fs *flag.FlagSet, logDir string) int {
	childArgs := []string{"serve"}
	fs.Visit(func(f *flag.Flag) {
		if f.Name != "supervise" {
			childArgs = append(childArgs, "--"+f.Name+"="+f.Value.String())
		}
	})
	logs := host.LogWriter(logDir)
	defer logs.Close()
	logger := host.NewLogger(logs)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	exe := executable()
	logger.Printf("supervise: %s %v (PID %d)", exe, childArgs, os.Getpid())
	_ = service.Supervise(ctx, service.SuperviseOptions{Exe: exe, Args: childArgs, Out: logs, Logger: logger, Delay: service.RestartDelay})
	logger.Print("supervise: stopped")
	return 0
}

func serviceCmd(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	action, args := args[0], args[1:]
	fs := flag.NewFlagSet("service "+action, flag.ContinueOnError)
	o := service.Options{Out: os.Stdout}
	fs.StringVar(&o.Host, "host", "", "address the service listens on (written to settings.json)")
	fs.IntVar(&o.Port, "port", -1, "port the service listens on (written to settings.json)")
	fs.StringVar(&o.Root, "root", "", "data directory (default: NEXUS_ROOT, then the platform data directory)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "service %s: unexpected argument %q\n", action, fs.Arg(0))
		return 2
	}
	o.Exe = executable()
	var err error
	switch action {
	case "install":
		err = service.Install(o)
	case "uninstall":
		err = service.Uninstall(o)
	case "status":
		err = service.Status(o)
	default:
		fmt.Fprintf(os.Stderr, "unknown service action %q\n%s", action, usage)
		return 2
	}
	if errors.Is(err, service.ErrNotElevated) {
		fmt.Fprintf(os.Stderr, "service %s %s: open a terminal as administrator (Windows) or use sudo (macOS, Linux) and run it again.\n", action, err)
		return 1
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "service %s failed: %v\n", action, err)
		return 1
	}
	return 0
}

// install installs or upgrades the programs next to this one (Windows).
func install(args []string) int {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	dir := fs.String("dir", "", `where to install (default: %LOCALAPPDATA%\Programs\n2n-nexus-host)`)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := service.SelfInstall(service.SelfInstallOptions{Exe: executable(), Dir: *dir, Out: os.Stdout}); err != nil {
		fmt.Fprintf(os.Stderr, "install: %v\n", err)
		return 1
	}
	return 0
}

func autostart(args []string) int {
	if len(args) != 1 || (args[0] != "on" && args[0] != "off") {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	on := args[0] == "on"
	where, err := service.SetAutostartChoice(trayExecutable(executable()), on)
	if err != nil {
		fmt.Fprintf(os.Stderr, "autostart %s: %v\n", args[0], err)
		return 1
	}
	if on {
		fmt.Printf("The tray starts at login (%s).\n", where)
	} else {
		fmt.Printf("The tray no longer starts at login (%s).\n", where)
	}
	return 0
}
