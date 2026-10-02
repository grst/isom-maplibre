import type { FeatureCollection } from "geojson";
import type { GeoJSONSourceSpecification, Map, StyleSpecification } from "maplibre-gl";
import geojsonStyle from "./style.geojson.json" with { type: "json" };
import icons from "./icons.json" with { type: "json" };

/** Pattern and point-symbol SVGs keyed by style image id ("isom:111"), sized
 * in CSS px at 1:10,000. registerIsomIcons() rasterizes them for you. */
export const ICONS: Record<string, string> = icons;

export type IsomTable = keyof typeof geojsonStyle.sources;

/** Source layers the style expects, in definition order; each feature carries
 * a string `isom_code` property ("401.000", "509.000", ...) selecting the ISOM
 * symbol. */
export const DETAIL_TABLES = geojsonStyle.metadata["isom:tables"] as readonly IsomTable[];

/** The generated GeoJSON style (one source per table, the full-detail symbol
 * pass at every zoom, no sprite: registerIsomIcons supplies the images) with
 * the given FeatureCollections attached. Tables left out start empty. */
export function isomGeojsonStyle(
  data?: Partial<Record<IsomTable, FeatureCollection>>,
): StyleSpecification {
  const style = structuredClone(geojsonStyle) as unknown as StyleSpecification;
  for (const t of DETAIL_TABLES) {
    const fc = data?.[t];
    if (fc) (style.sources[t] as GeoJSONSourceSpecification).data = fc;
  }
  return style;
}

/** Image ids the style expects as signed distance fields (`sdf: true`): the
 * point symbols, which it magnifies up to 128x and tints with icon-color. */
export const SDF_ICONS: ReadonlySet<string> = new Set(geojsonStyle.metadata["isom:sdf"] as string[]);

/** One style image, ready for `map.addImage(id, data, { pixelRatio, sdf })`. */
export interface IsomImage {
  data: ImageData;
  pixelRatio: number;
  sdf: boolean;
}

/** Distances an SDF image encodes, in CSS px, either side of the edge: the
 * scale of MapLibre's own glyphs (radius 8, edge at alpha 0.75). */
const SDF_RADIUS = 8;
const SDF_CUTOFF = 0.25;
/** Transparent margin round an SDF symbol, in CSS px: room for the field. */
const SDF_PAD = 3;

/** Draws the image `id` for a map at `pixelRatio`. Patterns become a bitmap at
 * that ratio; the SDF_ICONS become a distance field, which MapLibre renders with
 * sharp edges at any magnification, the way it renders text. */
export async function isomImage(id: string, pixelRatio: number): Promise<IsomImage | undefined> {
  const svg = ICONS[id];
  if (!svg) return undefined;
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const sdf = SDF_ICONS.has(id);
  // An SDF is computed from a supersampled drawing; its resolution bounds how
  // exactly the edge is placed, not how sharp it is drawn.
  const ratio = sdf ? Math.max(4, Math.ceil(pixelRatio)) : Math.max(1, pixelRatio);
  const pad = sdf ? SDF_PAD * ratio : 0;
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * ratio) + 2 * pad;
  c.height = Math.round(img.height * ratio) + 2 * pad;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, pad, pad, img.width * ratio, img.height * ratio);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  if (sdf) toDistanceField(data, SDF_RADIUS * ratio);
  return { data, pixelRatio: ratio, sdf };
}

/** Replaces `data` (any colour, coverage in alpha) by its signed distance field:
 * alpha = 255 - 255 (d / radius + cutoff), d the distance to the edge in image
 * px, negative inside. RGB is set to white; MapLibre tints with icon-color. */
function toDistanceField(data: ImageData, radius: number): void {
  const { width: w, height: h } = data;
  const n = w * h;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = data.data[4 * i + 3] / 255;
    // Squared distances, with partially covered pixels placed sub-pixel at the
    // edge, as TinySDF does for glyphs.
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = FAR;
    } else if (a <= 0) {
      outer[i] = FAR;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, w, h);
  edt(inner, w, h);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    const alpha = Math.round(255 - 255 * (d / radius + SDF_CUTOFF));
    data.data[4 * i] = data.data[4 * i + 1] = data.data[4 * i + 2] = 255;
    data.data[4 * i + 3] = Math.max(0, Math.min(255, alpha));
  }
}

/** Stands for "no edge in reach": large, but finite, so the arithmetic below
 * never meets Infinity - Infinity. */
const FAR = 1e20;

/** 2-D squared Euclidean distance transform in place (Felzenszwalb &
 * Huttenlocher), as in TinySDF. */
function edt(grid: Float64Array, w: number, h: number): void {
  const len = Math.max(w, h);
  const f = new Float64Array(len);
  const z = new Float64Array(len + 1);
  const v = new Uint16Array(len);
  const pass = (offset: number, stride: number, length: number) => {
    v[0] = 0;
    z[0] = -FAR;
    z[1] = FAR;
    f[0] = grid[offset];
    for (let q = 1, k = 0, s = 0; q < length; q++) {
      f[q] = grid[offset + q * stride];
      const q2 = q * q;
      do {
        const r = v[k];
        s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
      } while (s <= z[k] && --k > -1);
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = FAR;
    }
    for (let q = 0, k = 0; q < length; q++) {
      while (z[k + 1] < q) k++;
      const r = v[k];
      grid[offset + q * stride] = f[r] + (q - r) * (q - r);
    }
  };
  for (let x = 0; x < w; x++) pass(x, w, h);
  for (let y = 0; y < h; y++) pass(y * w, 1, w);
}

/** Adds the ISOM pattern/symbol images on demand (fill patterns and point
 * symbols reference them as "isom:<id>"), at the device pixel ratio. Call once
 * right after constructing the Map. */
export function registerIsomIcons(map: Map): void {
  const pending = new Set<string>();
  map.on("styleimagemissing", async ({ id }) => {
    // styleimagemissing refires every frame until the image exists.
    if (!ICONS[id] || pending.has(id) || map.hasImage(id)) return;
    pending.add(id);
    const image = await isomImage(id, Math.max(2, window.devicePixelRatio));
    if (image && !map.hasImage(id)) {
      map.addImage(id, image.data, { pixelRatio: image.pixelRatio, sdf: image.sdf });
    }
  });
}
