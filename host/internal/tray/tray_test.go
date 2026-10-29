package tray

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image/png"
	"reflect"
	"strings"
	"testing"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

func TestSetLANTogglesOnlyTheHost(t *testing.T) {
	dir := t.TempDir()
	s := config.Defaults()
	s.Port, s.DiscoveryPort, s.AllowedHosts, s.MaxAutoTurns = 5799, 5800, []string{"nexus.lan"}, 3
	if err := config.SaveSettings(dir, s); err != nil {
		t.Fatal(err)
	}
	on, err := setLAN(dir, true)
	if err != nil || on.Host != "0.0.0.0" || !isLAN(on) {
		t.Fatalf("on: %+v %v", on, err)
	}
	read, _ := config.LoadSettings(dir)
	want := s
	want.Host = "0.0.0.0"
	if !reflect.DeepEqual(read, want) {
		t.Fatalf("settings.json after on: %+v, want %+v", read, want)
	}
	off, err := setLAN(dir, false)
	if err != nil || off.Host != "127.0.0.1" || isLAN(off) {
		t.Fatalf("off: %+v %v", off, err)
	}
	if read, _ := config.LoadSettings(dir); !reflect.DeepEqual(read, s) {
		t.Fatalf("settings.json after off: %+v, want %+v", read, s)
	}
	// A fresh data directory gets the defaults plus the host.
	fresh, err := setLAN(t.TempDir(), true)
	if err != nil || fresh.Port != 5688 || fresh.Host != "0.0.0.0" {
		t.Fatalf("fresh: %+v %v", fresh, err)
	}
}

func TestProbeAddrs(t *testing.T) {
	s := config.Defaults()
	if got := probeAddrs(s); fmt.Sprint(got) != "[127.0.0.1:5688]" {
		t.Fatal(got)
	}
	s.Host = "0.0.0.0"
	if got := probeAddrs(s); fmt.Sprint(got) != "[127.0.0.1:5688]" {
		t.Fatal(got)
	}
	s.Host, s.Port = "192.168.1.9", 5799
	if got := probeAddrs(s); fmt.Sprint(got) != "[127.0.0.1:5799 192.168.1.9:5799]" {
		t.Fatal(got)
	}
}

func TestLanguage(t *testing.T) {
	for locale, zh := range map[string]bool{"zh_CN.UTF-8": true, "zh_TW": true, "zh": true, "zh-Hans": true, "en_US.UTF-8": false, "C": false, "": false, "zu_ZA": false} {
		if isChineseLocale(locale) != zh {
			t.Errorf("%q: want %v", locale, zh)
		}
	}
	for id, zh := range map[uint16]bool{0x0804: true, 0x0404: true, 0x0c04: true, 0x0409: false, 0x0411: false} {
		if isChineseLangID(id) != zh {
			t.Errorf("LANGID %#x: want %v", id, zh)
		}
	}
	// macOS: `defaults read -g AppleLanguages`.
	for out, want := range map[string]string{"(\n    \"zh-Hans-CN\",\n    \"en-US\"\n)\n": "zh-Hans-CN", "(\n    en,\n    \"zh-Hans\"\n)\n": "en", "(\n)\n": "", "": ""} {
		if got := firstAppleLanguage(out); got != want {
			t.Errorf("AppleLanguages %q: %q, want %q", out, got, want)
		}
	}
	if !isChineseLocale(firstAppleLanguage("(\n    \"zh-Hant-TW\"\n)\n")) {
		t.Error("zh-Hant-TW is Chinese")
	}
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "zh_CN.UTF-8")
	t.Setenv("LANG", "en_US.UTF-8")
	if envLocale() != "zh_CN.UTF-8" {
		t.Fatal(envLocale())
	}
	if textsFor(true).Quit != "退出" || textsFor(false).Quit != "Quit" {
		t.Fatal("texts")
	}
	// Every text is set in both languages, with the same format verbs.
	en, zh := reflect.ValueOf(english), reflect.ValueOf(chinese)
	for i := 0; i < en.NumField(); i++ {
		e, z := en.Field(i).String(), zh.Field(i).String()
		if e == "" || z == "" {
			t.Errorf("%s is empty", en.Type().Field(i).Name)
		}
		verbs := func(s string) string {
			var v []string
			for _, p := range strings.Split(s, "%")[1:] {
				if p != "" {
					v = append(v, p[:1])
				}
			}
			return strings.Join(v, "")
		}
		if verbs(e) != verbs(z) {
			t.Errorf("%s: verbs %q vs %q", en.Type().Field(i).Name, verbs(e), verbs(z))
		}
	}
}

func TestIcons(t *testing.T) {
	for _, size := range []int{16, 32} {
		img, err := png.Decode(bytes.NewReader(iconPNG(size)))
		if err != nil || img.Bounds().Dx() != size || img.Bounds().Dy() != size {
			t.Fatalf("png %d: %v", size, err)
		}
		if _, _, _, a := img.At(size/2, size/2).RGBA(); a == 0 {
			t.Fatalf("png %d: transparent centre", size)
		}
		if _, _, _, a := img.At(0, 0).RGBA(); a != 0 {
			t.Fatalf("png %d: opaque corner", size)
		}
	}
	// The macOS template image: black only, transparent around the network.
	tmpl, err := png.Decode(bytes.NewReader(templatePNG(32)))
	if err != nil {
		t.Fatal(err)
	}
	opaque := 0
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			r, g, b, a := tmpl.At(x, y).RGBA()
			if r|g|b != 0 {
				t.Fatalf("template pixel %d,%d is not black", x, y)
			}
			if a == 0xffff {
				opaque++
			}
		}
	}
	if _, _, _, a := tmpl.At(0, 0).RGBA(); a != 0 || opaque == 0 {
		t.Fatalf("template: corner alpha %d, %d opaque pixels", a, opaque)
	}
	ico := iconICO()
	var header [3]uint16
	_ = binary.Read(bytes.NewReader(ico), binary.LittleEndian, &header)
	if header != [3]uint16{0, 1, 2} {
		t.Fatalf("ico header %v", header)
	}
	for i, size := range []int{16, 32} {
		e := ico[6+16*i:]
		w := int(e[0])
		n := binary.LittleEndian.Uint32(e[8:])
		off := binary.LittleEndian.Uint32(e[12:])
		img, err := png.Decode(bytes.NewReader(ico[off : off+n]))
		if w != size || err != nil || img.Bounds().Dx() != size {
			t.Fatalf("ico entry %d: width %d, %v", i, w, err)
		}
	}
}

// The status line says whether and where the host runs; the line under it
// is the address a controlling tray's service listens on (from settings, not
// the loopback address the tray probes a LAN host on), or the error.
func TestStatusAndAddressLines(t *testing.T) {
	s := config.Defaults()
	s.Host = "0.0.0.0"
	a := &app{t: chinese, external: "127.0.0.1:5688", settings: s}
	if got, want := a.statusTitle(), "运行中 · 后台服务"; got != want {
		t.Fatalf("status: got %q, want %q", got, want)
	}
	if got, want := a.addressTitle(), "http://0.0.0.0:5688"; got != want {
		t.Fatalf("address: got %q, want %q", got, want)
	}
	s.Host = "127.0.0.1"
	a.settings = s
	if got, want := a.addressTitle(), "http://127.0.0.1:5688"; got != want {
		t.Fatalf("address: got %q, want %q", got, want)
	}
	// The service stopped answering: the status says so and the error takes the address line.
	a.lastErr = errors.New(chinese.ServiceDown)
	if got, want := a.statusTitle(), "未运行"; got != want {
		t.Fatalf("stopped status: got %q, want %q", got, want)
	}
	if got, want := a.addressTitle(), "后台服务无响应"; got != want {
		t.Fatalf("stopped address: got %q, want %q", got, want)
	}
	if a.addressURL() != "" {
		t.Fatalf("stopped URL: %q", a.addressURL())
	}
}
