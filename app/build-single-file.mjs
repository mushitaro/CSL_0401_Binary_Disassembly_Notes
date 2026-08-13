/**
 * Fold the built viewer into one self-contained HTML file.
 *
 *   npm run build:single   ->  dist-single/mss54hp-parameter-tree.html
 *
 * The result opens straight from the filesystem: no server, no install, no
 * network. Everything is inlined - the JS bundle, the stylesheet, the 4 MB
 * parameter graph and all 644 decompiled listings - because a page opened over
 * file:// cannot fetch its siblings, and a page pasted into a chat or an email
 * has no siblings at all.
 *
 * Run `npm run build` first; this reads its output.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const out = join(here, "dist-single");
const data = join(here, "public", "data");

/** `</script` anywhere inside a JSON island would close the tag early. */
function safeJson(text) {
  return text.replace(/<\/(script)/gi, "<\\/$1");
}

function readAssets() {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const files = readdirSync(join(dist, "assets"));
  const js = files.filter((f) => f.endsWith(".js"));
  const css = files.filter((f) => f.endsWith(".css"));
  if (js.length !== 1 || css.length > 1) {
    throw new Error(
      `expected a single JS bundle and at most one stylesheet, found ${js.length} and ${css.length}`,
    );
  }
  return {
    title: (html.match(/<title>([^<]*)<\/title>/) ?? [, "MSS54HP"])[1],
    favicon: (html.match(/<link rel="icon"[^>]*>/) ?? [""])[0],
    js: readFileSync(join(dist, "assets", js[0]), "utf8"),
    css: css.length ? readFileSync(join(dist, "assets", css[0]), "utf8") : "",
  };
}

function readDecompiled() {
  const map = {};
  for (const bank of readdirSync(join(data, "decomp"))) {
    const dir = join(data, "decomp", bank);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".txt")) continue;
      map[`${bank}/${file.slice(0, -4)}`] = readFileSync(join(dir, file), "utf8");
    }
  }
  return map;
}

const assets = readAssets();
const graph = readFileSync(join(data, "graph.json"), "utf8");
const decomp = readDecompiled();

const page = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${assets.favicon}
    <title>${assets.title}</title>
    <style>${assets.css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script id="graph-data" type="application/json">${safeJson(graph)}</script>
    <script id="decomp-data" type="application/json">${safeJson(JSON.stringify(decomp))}</script>
    <script type="module">${assets.js}</script>
  </body>
</html>
`;

mkdirSync(out, { recursive: true });
const target = join(out, "mss54hp-parameter-tree.html");
writeFileSync(target, page);

const mb = (n) => (n / 1e6).toFixed(1);
console.log(`graph      ${mb(graph.length)} MB`);
console.log(`decompiled ${Object.keys(decomp).length} listings`);
console.log(`js + css   ${mb(assets.js.length + assets.css.length)} MB`);
console.log(`wrote ${target} (${mb(page.length)} MB)`);
