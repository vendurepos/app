import { CATALOGUE, type CatalogueProduct } from './catalogue';

// Flat catalogue pictures for the demo store, drawn in code so the demo makes no image request. Each is a 160x160
// square: a mid-saturation category tint, the product in that hue's darker ink (and a between shade for flavours),
// and white highlights. No text, gradients or shadows; the tile rounds the corners.

type Category = CatalogueProduct['category'];
type Tint = { bg: string; ink: string; mid: string };
type Draw = (t: Tint) => string;

// Per category: background tint, object ink, and the between shade that tells flavours of one kind apart.
const TINTS: Record<Category, Tint> = {
  Coffee: { bg: '#C47A45', ink: '#4F2812', mid: '#87481F' },
  Drinkware: { bg: '#3E9B95', ink: '#134844', mid: '#24716B' },
  Apparel: { bg: '#5F67BE', ink: '#232966', mid: '#3D4495' },
  Stationery: { bg: '#D2A333', ink: '#5E430B', mid: '#97701A' },
  Gifts: { bg: '#CF6882', ink: '#651D30', mid: '#9C3F57' },
};
// Highlight colour.
const W = '#fff';

const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"/>`;
const circle = (cx: number, cy: number, r: number, fill: string) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const shape = (d: string, fill: string) => `<path d="${d}" fill="${fill}"/>`;
const line = (d: string, stroke: string, width: number, extra = '') =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
const group = (transform: string, body: string) => `<g transform="${transform}">${body}</g>`;
const dots = (points: number[][], r: number, fill: string) => points.map(([x, y]) => circle(x, y, r, fill)).join('');

const bean = (x: number, y: number, scale: number, fill: string, seam: string) =>
  group(`translate(${x} ${y}) rotate(-30) scale(${scale})`, `<ellipse rx="10" ry="14" fill="${fill}"/>${line('M1-12C-6-4 6 4-1 12', seam, 2.5)}`);
const coffeeBag = (fill: string, label: string) =>
  shape('M52 50H108L116 130H44Z', fill) + rect(50, 36, 60, 16, fill, 3) + line('M58 44H102', W, 2.5) + label;
const mug = (t: Tint, body: string, handle: string, width: number) => line(handle, t.ink, width) + body;
const sock = (fill: string) => shape('M56 36H80V92L102 108A13 13 0 0 1 88 128L60 108A14 14 0 0 1 56 98Z', fill) + rect(56, 36, 24, 12, W);
const pencil = (x: number, y: number, fill: string, end: string, t: Tint) =>
  shape(`M${x} ${y + 16}L${x + 8} ${y}L${x + 16} ${y + 16}Z`, W) + shape(`M${x + 5} ${y + 6}L${x + 8} ${y}L${x + 11} ${y + 6}Z`, t.ink)
  + rect(x, y + 16, 16, 70, fill) + rect(x, y + 86, 16, 10, end);
const roll = (x: number, y: number, fill: string, core: string, t: Tint) => circle(x, y, 24, fill) + circle(x, y, 13, core) + circle(x, y, 8, t.bg);
const round = (cx: number, cy: number, r: number, stroke: string, width: number, extra = '') =>
  line(`M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`, stroke, width, extra);

// One drawing per catalogue slug.
const DRAWINGS: Record<string, Draw> = {
  'espresso-beans': t => coffeeBag(t.ink, circle(80, 94, 21, W) + bean(80, 94, 1, t.ink, W)),
  'decaf-coffee': t => coffeeBag(t.mid, circle(80, 94, 21, W) + bean(80, 94, 1, t.mid, W)),
  'filter-coffee': t => coffeeBag(t.ink, rect(50, 80, 60, 28, W) + bean(68, 94, 0.75, t.ink, W) + bean(92, 94, 0.75, t.ink, W)),
  'house-blend': t => coffeeBag(t.ink, bean(80, 92, 1.6, W, t.ink)),
  'cold-brew': t => rect(68, 30, 24, 10, t.mid, 2) + rect(70, 38, 20, 18, t.ink) + rect(58, 52, 44, 80, t.ink, 10)
    + rect(58, 80, 44, 30, W) + bean(80, 95, 0.8, t.ink, W) + rect(64, 58, 5, 16, W, 2.5),
  'chocolate-biscuits': t => circle(98, 66, 30, t.mid) + dots([[90, 52], [110, 62], [100, 78]], 3.5, t.ink)
    + circle(68, 96, 34, t.ink) + dots([[58, 90], [78, 84], [70, 110], [88, 104], [52, 108]], 4, t.mid) + line('M42 92A26 26 0 0 1 58 72', W, 4),
  'tally-fixture-mug': t => mug(t, rect(46, 50, 56, 68, t.ink, 8) + rect(55, 60, 7, 38, W, 3.5), 'M100 66H108A14 14 0 0 1 108 94H100', 9),
  'enamel-cup': t => mug(t, rect(42, 62, 66, 52, t.ink, 8) + rect(40, 56, 70, 10, W, 5)
    + dots([[56, 80], [72, 96], [90, 82], [96, 102], [58, 104]], 2.5, W), 'M106 72H112A12 12 0 0 1 112 96H106', 6),
  'travel-tumbler': t => shape('M58 52H102L96 132H64Z', t.ink) + shape('M60 80H100L98 100H62Z', t.mid) + rect(54, 36, 52, 16, t.mid, 5)
    + rect(70, 40, 20, 4, W, 2) + rect(65, 58, 5, 16, W, 2.5),
  'espresso-cup': t => mug(t, rect(30, 110, 100, 10, t.ink, 5) + shape('M52 72H104V86A26 26 0 0 1 52 86Z', t.ink)
    + rect(58, 78, 6, 16, W, 3), 'M104 80H110A9 9 0 0 1 110 98H100', 6),
  'glass-carafe': t => shape('M54 34H106L87 78L110 130H50L73 78Z', t.mid) + shape('M62.4 102H97.6L110 130H50Z', t.ink)
    + shape('M64 64H96L99 92H61Z', t.ink) + line('M63 78H97', W, 3) + line('M62 42L68 56', W, 4),
  'water-bottle': t => round(80, 30, 7, t.mid, 4) + rect(66, 32, 28, 18, t.mid, 4) + rect(58, 46, 44, 88, t.ink, 14)
    + rect(58, 94, 44, 10, t.mid) + rect(65, 56, 6, 28, W, 3),
  'tally-t-shirt': t => shape('M60 40Q80 56 100 40L118 46L134 70L116 82L108 72V126H52V72L44 82L26 70L42 46Z', t.ink)
    + line('M64 45Q80 57 96 45', W, 3),
  'tally-hoodie': t => shape('M58 46L42 52L30 112L44 114L52 80V128H108V80L116 114L130 112L118 52L102 46Z', t.ink)
    + shape('M56 50Q58 26 80 26Q102 26 104 50Q80 64 56 50Z', t.mid) + shape('M62 100H98L104 120H56Z', t.mid) + line('M74 56V74M86 56V74', W, 3),
  'cotton-beanie': t => circle(80, 50, 11, t.mid) + shape('M44 100V92A36 36 0 0 1 116 92V100Z', t.ink) + rect(40, 96, 80, 24, t.mid, 5)
    + line('M54 101V115M67 101V115M80 101V115M93 101V115M106 101V115', t.ink, 3) + line('M54 84A28 28 0 0 1 68 66', W, 4),
  'canvas-apron': t => line('M66 52Q80 24 94 52', t.ink, 5) + line('M46 84L28 96M114 84L132 96', t.ink, 5)
    + shape('M62 48H98V66Q100 76 114 78V134H46V78Q60 76 62 66Z', t.ink) + rect(62, 96, 36, 22, t.mid, 3) + line('M80 98V116', W, 2),
  'cotton-socks': t => group('translate(12 -6)', sock(t.mid)) + group('translate(-12 4)', sock(t.ink)),
  'tally-cap': t => shape('M92 94Q128 88 144 104Q126 116 92 110Z', t.mid) + shape('M30 106C30 70 48 58 72 58C96 58 114 70 114 106Z', t.ink)
    + line('M72 60C62 74 60 90 62 106', t.mid, 3) + circle(72, 58, 5, t.mid) + line('M42 92A30 30 0 0 1 52 74', W, 4),
  'notebook': t => rect(46, 32, 68, 96, t.ink, 5) + rect(54, 32, 4, 96, t.mid) + rect(100, 32, 5, 96, W)
    + shape('M76 126H86V142L81 137L76 142Z', t.mid),
  'postcard-set': t => group('rotate(-10 80 80)', rect(34, 48, 92, 62, t.mid, 3)) + rect(34, 54, 92, 62, W, 3) + rect(104, 62, 14, 18, t.ink, 2)
    + line('M84 64V106', t.mid, 2) + line('M92 92H116M92 102H116', t.mid, 2.5) + line('M44 70H74M44 80H70M44 90H74', t.ink, 3),
  'pencil-set': t => pencil(48, 30, t.ink, t.mid, t) + pencil(72, 40, t.mid, t.ink, t) + pencil(96, 26, t.ink, t.mid, t),
  'rollerball-pen': t => group('rotate(-40 80 80)', shape('M36 74L22 80L36 86Z', t.ink) + rect(34, 72, 80, 16, t.ink, 8)
    + rect(38, 72, 18, 16, t.mid) + rect(100, 70, 38, 20, t.mid, 8) + rect(108, 63, 26, 5, W, 2.5) + line('M66 76H94', W, 3)),
  'weekly-planner': t => rect(40, 40, 80, 92, t.ink, 5) + rect(48, 50, 64, 74, W, 2) + line('M80 56V118', t.mid, 2)
    + line('M56 64H74M86 64H104M56 80H74M86 80H104M56 96H74M86 96H104M56 112H74', t.mid, 3)
    + [54, 67, 80, 93, 106].map(x => rect(x - 2, 32, 4, 16, W, 2)).join(''),
  'washi-tape-set': t => roll(56, 64, t.ink, W, t) + roll(104, 64, t.mid, W, t) + roll(80, 106, W, t.ink, t),
  'tote-bag': t => line('M62 64V50A18 18 0 0 1 98 50V64', t.ink, 6) + shape('M42 62H118L112 132H48Z', t.ink)
    + rect(64, 86, 32, 26, t.mid, 3) + line('M48 72H112', W, 2.5),
  'limited-print': t => rect(36, 32, 88, 96, t.ink) + rect(46, 42, 68, 76, W) + shape('M52 112L72 80L86 98L96 88L108 112Z', t.mid)
    + circle(94, 62, 8, t.ink),
  'gift-card': t => rect(28, 46, 104, 68, t.ink, 8) + rect(56, 46, 10, 68, t.mid) + shape('M61 66L44 56V76ZM61 66L78 56V76Z', W)
    + circle(61, 66, 5, W) + line('M88 98H118', W, 4),
  'leather-keyring': t => round(80, 56, 16, t.ink, 6) + group('rotate(-16 84 96)', rect(66, 64, 36, 64, t.ink, 12) + circle(84, 76, 5, t.bg)
    + `<rect x="72" y="88" width="24" height="34" rx="6" fill="none" stroke="${W}" stroke-width="2" stroke-dasharray="4 3"/>`),
  'cork-coaster-set': t => circle(98, 66, 32, t.mid) + round(98, 66, 24, t.ink, 2, ' stroke-dasharray="4 4"')
    + circle(68, 96, 34, t.ink) + round(68, 96, 26, W, 2.5, ' stroke-dasharray="4 4"'),
  'gift-wrapping': t => rect(42, 72, 76, 56, t.ink) + rect(38, 60, 84, 16, t.mid, 3) + rect(74, 60, 12, 68, W)
    + shape('M80 60C62 38 50 52 66 60ZM80 60C98 38 110 52 94 60Z', W),
};

// A plainer picture per category, for a product without its own drawing.
const CATEGORY_DRAWINGS: Record<Category, Draw> = {
  Coffee: t => bean(80, 80, 2.6, t.ink, W),
  Drinkware: t => shape('M54 40H106L98 128H62Z', t.mid) + shape('M58 80H102L98 128H62Z', t.ink) + rect(62, 48, 5, 24, W, 2.5),
  Apparel: t => line('M88 40A8 8 0 1 0 80 48V58L34 94H126L80 58', t.ink, 6),
  Stationery: t => group('rotate(45 80 80)', pencil(72, 32, t.ink, t.mid, t)),
  Gifts: t => line('M98 62Q112 40 128 46', t.ink, 3) + group('rotate(-35 80 80)', shape('M38 62H98L120 80L98 98H38Z', t.ink) + circle(100, 80, 5, t.bg)),
};

// Not ";utf8,": react-native-web's Image percent-encodes such a URI's payload again, and the picture never loads.
const uri = (t: Tint, draw: Draw) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="${t.bg}"/>${draw(t)}</svg>`);

/** The demo's picture for a category, used for any product without its own. */
export function demoCategoryImage(category: Category): string {
  return uri(TINTS[category], CATEGORY_DRAWINGS[category]);
}

/** The demo's picture for a catalogue product, by slug; an unknown slug gets its category's picture (Gifts' tag if none is given). */
export function demoProductImage(slug: string, category?: Category): string {
  const product = CATALOGUE.find(product => product.slug === slug);
  return product ? uri(TINTS[product.category], DRAWINGS[product.slug]) : demoCategoryImage(category ?? 'Gifts');
}
