package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/update"
)

func autoUpdate(args []string) int {
	if len(args) > 0 && (args[0] == "on" || args[0] == "off") {
		if err := scheduleHostUpdate(args[0], args[1:]); err != nil {
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
	if len(args) == 0 || args[0] != "run" {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	fs := flag.NewFlagSet("auto-update run", flag.ContinueOnError)
	root := fs.String("root", "", "host data directory (default: NEXUS_ROOT, installed service root, or platform default)")
	method := fs.String("method", "", "installation method (default: detect)")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
		return 2
	}
	if *root == "" && os.Getenv("NEXUS_ROOT") == "" {
		saved, err := savedUpdateRoot()
		if err != nil {
			fmt.Fprintln(os.Stderr, "auto-update:", err)
			return 1
		}
		*root = saved
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	if err := update.Run(ctx, version, *root, *method, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "auto-update:", err)
		return 1
	}
	return 0
}
