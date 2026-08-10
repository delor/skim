// Rasterize promo/src/*.svg to promo/png/*.png at 1280x800.
// Run from the repo root so @resvg/resvg-js resolves from node_modules:
//   node promo/render.mjs
import { Resvg } from '@resvg/resvg-js';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const outDir = join(here, 'png');
await mkdir(outDir, { recursive: true });

const files = (await readdir(srcDir)).filter((f) => f.endsWith('.svg')).sort();
for (const file of files) {
  const svg = await readFile(join(srcDir, file), 'utf8');
  // Each SVG declares its own size (store screenshots are 1280x800; promo
  // tiles and the Shorts backdrop differ). Render at exactly that size.
  const m = svg.match(/<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
  if (!m) throw new Error(`${file}: missing width/height on <svg>`);
  const [width, height] = [Number(m[1]), Number(m[2])];
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Inter',
      sansSerifFamily: 'Inter',
      serifFamily: 'DejaVu Serif',
      monospaceFamily: 'DejaVu Sans Mono',
    },
  });
  const png = resvg.render();
  if (png.width !== width || png.height !== height) {
    throw new Error(`${file}: unexpected size ${png.width}x${png.height}, wanted ${width}x${height}`);
  }
  const out = join(outDir, file.replace(/\.svg$/, '.png'));
  await writeFile(out, png.asPng());
  console.log(`${file} -> ${out} (${png.width}x${png.height})`);
}
