package isomstyle

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// rasterAlong is the length in CSS px of a line-raster tile along its lines;
// any value works since the lines run edge to edge.
const rasterAlong = 4

// Icons returns every image as SVG, keyed by its full style id ("isom:111").
// Images are sized in CSS px at the map scale; canvases are whole pixels so a
// renderer never resamples them.
//
// A fill pattern is drawn in screen pixels whatever the zoom, so a line raster
// also comes once per zoom above lockZoom, drawn at that zoom's magnification
// ("isom:407@z17"); the style picks the one for the zoom (see patternByZoom).
func (s *Spec) Icons() map[string]string {
	out := map[string]string{}
	for key, img := range s.Images {
		out[s.imageID(key)] = s.svg(img, 1)
		if img.LineRaster != nil {
			for _, z := range s.magnifiedZooms() {
				out[s.zoomImageID(key, z)] = s.svg(img, s.magnification(float64(z)))
			}
		}
	}
	return out
}

// SDFImages lists the images a renderer should add as signed distance fields
// (MapLibre's `sdf: true`): the single-colour point symbols, which the style
// magnifies up to 2^(maxZoom-lockZoom) times and colours with icon-color. A
// bitmap would pixelate; a distance field keeps its edges sharp at any size.
func (s *Spec) SDFImages() []string {
	var out []string
	for key, img := range s.Images {
		if img.LineRaster == nil {
			out = append(out, s.imageID(key))
		}
	}
	sort.Strings(out)
	return out
}

// magnifiedZooms are the integer zooms above lockZoom up to maxZoom.
func (s *Spec) magnifiedZooms() []int {
	var out []int
	for z := int(s.Scale.LockZoom) + 1; z <= int(s.Scale.MaxZoom); z++ {
		out = append(out, z)
	}
	return out
}

// magnification is the factor the style draws every dimension at, at zoom z.
func (s *Spec) magnification(z float64) float64 {
	return math.Exp2(math.Max(0, z-s.Scale.LockZoom))
}

func (s *Spec) zoomImageID(key string, z int) string {
	return fmt.Sprintf("%s@z%d", s.imageID(key), z)
}

// color is the single colour the image is drawn in.
func (img Image) color() string {
	switch {
	case img.HalfCircle != nil:
		return img.HalfCircle.Color
	case img.Tick != nil:
		return img.Tick.Color
	default:
		return img.LineRaster.Color
	}
}

// IconsJSON renders Icons as an indented JSON object.
func (s *Spec) IconsJSON() ([]byte, error) { return marshal(s.Icons()) }

func (s *Spec) svg(img Image, factor float64) string {
	px := func(mm float64) float64 { return s.Scale.Px(mm) * factor }
	switch {
	case img.LineRaster != nil:
		r := img.LineRaster
		n, tile := rasterTile(px(r.Spacing))
		step := tile / float64(n)
		var d strings.Builder
		for i := range n {
			at := f((float64(i) + 0.5) * step)
			if r.Angle == 0 {
				fmt.Fprintf(&d, "M0 %sH%d", at, rasterAlong)
			} else {
				fmt.Fprintf(&d, "M%s 0V%d", at, rasterAlong)
			}
		}
		w, h := int(tile), rasterAlong
		if r.Angle == 0 {
			w, h = h, w
		}
		return svgDoc(w, h, fmt.Sprintf(`<path d=%q fill="none" stroke=%q stroke-width="%s"/>`,
			d.String(), r.Color, f(px(r.Width))))
	case img.HalfCircle != nil:
		c := img.HalfCircle
		sw, outer := px(c.Width), px(c.Diameter)
		r := (outer - sw) / 2
		w, h := int(math.Ceil(outer)), int(math.Ceil(r+sw))
		cx, y := float64(w)/2, (float64(h)-r-sw)/2+sw/2
		return svgDoc(w, h, fmt.Sprintf(`<path d="M%s %sA%s %s 0 0 0 %s %s" fill="none" stroke=%q stroke-width="%s"/>`,
			f(cx-r), f(y), f(r), f(r), f(cx+r), f(y), c.Color, f(sw)))
	default:
		t := img.Tick
		length, sw := px(t.Length), px(t.Width)
		w, h := int(math.Ceil(length)), int(math.Ceil(sw))
		x0, y := (float64(w)-length)/2, float64(h)/2
		return svgDoc(w, h, fmt.Sprintf(`<path d="M%s %sH%s" stroke=%q stroke-width="%s"/>`,
			f(x0), f(y), f(x0+length), t.Color, f(sw)))
	}
}

// rasterTile picks the smallest number of line periods whose total length is
// within 0.2% of a whole pixel, so the pattern tiles seamlessly while the
// spacing stays true to the spec.
func rasterTile(spacing float64) (int, float64) {
	for n := 1; n <= 64; n++ {
		total := float64(n) * spacing
		if math.Abs(total-math.Round(total)) <= 0.002*total {
			return n, math.Round(total)
		}
	}
	return 1, math.Max(1, math.Round(spacing))
}

func svgDoc(w, h int, body string) string {
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">%s</svg>`,
		w, h, w, h, body)
}

func f(v float64) string { return strconv.FormatFloat(round(v, 3), 'f', -1, 64) }
