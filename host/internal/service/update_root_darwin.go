package service

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

func registeredServe() ([]string, error) {
	f, err := os.Open(DaemonPlistPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	d := xml.NewDecoder(f)
	for {
		token, err := d.Token()
		if err != nil {
			return nil, fmt.Errorf("read service ProgramArguments: %w", err)
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "key" {
			continue
		}
		var key string
		if err = d.DecodeElement(&key, &start); err != nil {
			return nil, err
		}
		if key == "ProgramArguments" {
			var args struct {
				Strings []string `xml:"string"`
			}
			if err = d.Decode(&args); err != nil {
				return nil, err
			}
			return args.Strings, nil
		}
	}
}
