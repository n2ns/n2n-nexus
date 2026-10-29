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

// The network of the icon, in units of its width: the middle node (the host),
// the four others (the conversations), and the links between them.
var (
	iconHub   = [2]float64{0.469, 0.527}
	iconNodes = [][2]float64{{0.258, 0.293}, {0.727, 0.242}, {0.781, 0.688}, {0.313, 0.789}}
	iconLinks = [][2][2]float64{{iconHub, iconNodes[0]}, {iconHub, iconNodes[1]}, {iconHub, iconNodes[2]}, {iconHub, iconNodes[3]}, {iconNodes[1], iconNodes[2]}}
)

const iconHubR, iconNodeR, iconLinkW = 0.1, 0.07, 0.03

// iconCentre is the middle of the network, which network places at the middle of the icon.
var iconCentre = [2]float64{0.52, 0.516}

// network says which part of the network (x, y) is on, centred and scaled by zoom.
func network(x, y, zoom float64) (hub, node, link bool) {
	x, y = (x-0.5)/zoom+iconCentre[0], (y-0.5)/zoom+iconCentre[1]
	if math.Hypot(x-iconHub[0], y-iconHub[1]) <= iconHubR {
		return true, false, false
	}
	for _, n := range iconNodes {
		if math.Hypot(x-n[0], y-n[1]) <= iconNodeR {
			return false, true, false
		}
	}
	for _, l := range iconLinks {
		if segmentDist(x, y, l[0][0], l[0][1], l[1][0], l[1][1]) <= iconLinkW {
			return false, false, true
		}
	}
	return false, false, false
}

// iconPNG draws the tray icon at size×size: the network nearly filling a
// dark grey rounded tile, the hub red, the other nodes white, the links light
// blue. The README logo (assets/n2n-nexus-logo.png) is the same drawing at 512 px.
func iconPNG(size int) []byte {
	var (
		top, bottom = color.NRGBA{R: 0x4a, G: 0x4a, B: 0x52, A: 0xff}, color.NRGBA{R: 0x26, G: 0x26, B: 0x2c, A: 0xff}
		link        = color.NRGBA{R: 0x8c, G: 0xc4, B: 0xff, A: 0xff}
		white       = color.NRGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
		red         = color.NRGBA{R: 0xff, G: 0x2d, B: 0x3a, A: 0xff}
	)
	const half, radius = 0.48, 0.14 // the tile
	return draw(size, func(x, y float64) (color.NRGBA, bool) {
		if !inRoundRect(x, y, half, radius) {
			return color.NRGBA{}, false
		}
		switch h, n, l := network(x, y, 1.3); {
		case h:
			return red, true
		case n:
			return white, true
		case l:
			return link, true
		}
		mix := func(a, b uint8) uint8 { return uint8(float64(a)*(1-y) + float64(b)*y) }
		return color.NRGBA{R: mix(top.R, bottom.R), G: mix(top.G, bottom.G), B: mix(top.B, bottom.B), A: 0xff}, true
	})
}

// templatePNG draws the macOS menu bar icon: the network alone in black,
// enlarged to fill the square. macOS shows a template image black or white to
// suit the menu bar and inverts it when the menu is open.
func templatePNG(size int) []byte {
	black := color.NRGBA{A: 0xff}
	return draw(size, func(x, y float64) (color.NRGBA, bool) {
		h, n, l := network(x, y, 1.25)
		return black, h || n || l
	})
}

// draw renders shade over size×size pixels, 4×4 samples per pixel to smooth the edges.
func draw(size int, shade func(x, y float64) (color.NRGBA, bool)) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	px := 1 / float64(size)
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

// trayIcon is the icon in the format systray takes on this platform; on macOS
// systray shows templatePNG instead.
func trayIcon() []byte {
	if runtime.GOOS == "windows" {
		return iconICO()
	}
	return iconPNG(32)
}
