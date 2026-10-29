package tray

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"runtime"
)

// iconPNG draws the tray icon at size×size: a charcoal rounded tile with a
// one-pixel grey edge, and on it a small network: a red node in the middle
// (the host) joined by light blue links to four white nodes (the
// conversations), two of which are also joined to each other. The README logo
// (assets/n2n-nexus-logo.png) is the same drawing at 512 px.
func iconPNG(size int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	var (
		top, bottom = color.NRGBA{R: 0x2a, G: 0x2a, B: 0x2e, A: 0xff}, color.NRGBA{R: 0x0e, G: 0x0e, B: 0x10, A: 0xff}
		edge        = color.NRGBA{R: 0x8e, G: 0x8e, B: 0x93, A: 0xff}
		link        = color.NRGBA{R: 0x8c, G: 0xc4, B: 0xff, A: 0xff}
		white       = color.NRGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
		red         = color.NRGBA{R: 0xff, G: 0x2d, B: 0x3a, A: 0xff}
	)
	// In units of the icon's width: the middle node, the four others, and the links between them.
	hub := [2]float64{0.469, 0.527}
	nodes := [][2]float64{{0.258, 0.293}, {0.727, 0.242}, {0.781, 0.688}, {0.313, 0.789}}
	links := [][2][2]float64{{hub, nodes[0]}, {hub, nodes[1]}, {hub, nodes[2]}, {hub, nodes[3]}, {nodes[1], nodes[2]}}
	const half, radius = 0.48, 0.14 // the tile
	px := 1 / float64(size)
	shade := func(x, y float64) (color.NRGBA, bool) {
		if !inRoundRect(x, y, half, radius) {
			return color.NRGBA{}, false
		}
		if !inRoundRect(x, y, half-px, radius-px) {
			return edge, true
		}
		if math.Hypot(x-hub[0], y-hub[1]) <= 0.094 {
			return red, true
		}
		for _, n := range nodes {
			if math.Hypot(x-n[0], y-n[1]) <= 0.066 {
				return white, true
			}
		}
		for _, l := range links {
			if segmentDist(x, y, l[0][0], l[0][1], l[1][0], l[1][1]) <= 0.025 {
				return link, true
			}
		}
		t := y
		mix := func(a, b uint8) uint8 { return uint8(float64(a)*(1-t) + float64(b)*t) }
		return color.NRGBA{R: mix(top.R, bottom.R), G: mix(top.G, bottom.G), B: mix(top.B, bottom.B), A: 0xff}, true
	}
	// 4×4 samples per pixel smooth the edges.
	const n = 4
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a float64
			for sy := 0; sy < n; sy++ {
				for sx := 0; sx < n; sx++ {
					c, ok := shade((float64(x)+(float64(sx)+0.5)/n)*px, (float64(y)+(float64(sy)+0.5)/n)*px)
					if ok {
						r, g, b, a = r+float64(c.R), g+float64(c.G), b+float64(c.B), a+1
					}
				}
			}
			if a > 0 {
				img.SetNRGBA(x, y, color.NRGBA{R: uint8(r / a), G: uint8(g / a), B: uint8(b / a), A: uint8(a / (n * n) * 0xff)})
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// inRoundRect: (x, y) is inside the square of half-width half centred in the unit square, with corners of radius r.
func inRoundRect(x, y, half, r float64) bool {
	qx, qy := math.Max(math.Abs(x-0.5)-half+r, 0), math.Max(math.Abs(y-0.5)-half+r, 0)
	return math.Hypot(qx, qy) <= r
}

func segmentDist(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	t := ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)
	t = math.Max(0, math.Min(1, t))
	return math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
}

// iconICO is a Windows .ico holding the 16 and 32 px icons as PNG images.
func iconICO() []byte {
	sizes := []int{16, 32}
	images := make([][]byte, len(sizes))
	for i, s := range sizes {
		images[i] = iconPNG(s)
	}
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, [3]uint16{0, 1, uint16(len(sizes))}) // reserved, type icon, count
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		entry := struct {
			W, H, Colors, Reserved uint8
			Planes, BPP            uint16
			Size, Offset           uint32
		}{uint8(s), uint8(s), 0, 0, 1, 32, uint32(len(images[i])), uint32(offset)}
		_ = binary.Write(&buf, binary.LittleEndian, entry)
		offset += len(images[i])
	}
	for _, img := range images {
		buf.Write(img)
	}
	return buf.Bytes()
}

// trayIcon is the icon in the format systray takes on this platform.
func trayIcon() []byte {
	if runtime.GOOS == "windows" {
		return iconICO()
	}
	return iconPNG(32)
}
