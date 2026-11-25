package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/update"
)

func autoUpdate(args []string) int {
	if len(args) > 0 && (args[0] == "service-start" || args[0] == "service-login") {
		return serviceUpdateCommand(args)
	}
	if len(args) > 0 && (args[0] == "on" || args[0] == "off") {
		if err := setHostStartupUpdates(args[0], args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, "auto-update:", err)
			return 1
		}
		return 0
	}
	if len(args) == 1 && args[0] == "info" {
		build, err := update.LocalBuild(version)
		if err == nil {
			err = json.NewEncoder(os.Stdout).Encode(build)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	if len(args) == 0 || (args[0] != "run" && args[0] != "startup") {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	fs := flag.NewFlagSet("auto-update run", flag.ContinueOnError)
	root := fs.String("root", "", "host data directory (default: NEXUS_ROOT, installed service root, or platform default)")
	method := fs.String("method", "", "installation method (default: detect)")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	var out, errOut io.Writer = os.Stdout, os.Stderr
	if args[0] == "startup" {
		log := host.UpdateLogWriter(config.LogDir())
		defer log.Close()
		out, errOut = log, log
		if *root == "" {
			return 2
		}
		enabled, err := prepareHostUpdate(ctx, "startup", *root, *method)
		if err != nil {
			fmt.Fprintln(errOut, "startup update:", err)
			return 1
		}
		if !enabled {
			return 0
		}
	}
	if *root == "" && os.Getenv("NEXUS_ROOT") == "" {
		saved, err := savedUpdateRoot()
		if err != nil {
			fmt.Fprintln(os.Stderr, "auto-update:", err)
			return 1
		}
		*root = saved
	}
	if err := update.Run(ctx, version, *root, *method, args[0] == "startup", out); err != nil {
		fmt.Fprintln(errOut, "auto-update:", err)
		return 1
	}
	return 0
}
