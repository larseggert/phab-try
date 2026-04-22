/**
 * Converts icons/icon.svg into PNG files at the sizes required by the extension.
 * Run once after changing the SVG source:  node generate-icons.mjs
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dir = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(dir, "icons", "icon.svg"));

for (const size of [48, 96, 128]) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  const out = join(dir, "icons", `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out}`);
}
