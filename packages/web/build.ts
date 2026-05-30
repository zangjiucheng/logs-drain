import { $ } from "bun";
import { rm, mkdir, cp } from "node:fs/promises";

const outdir = "./dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Bundle JS/TSX
const jsResult = await Bun.build({
  entrypoints: ["./src/main.tsx"],
  outdir,
  target: "browser",
  minify: true,
  naming: "[dir]/[name]-[hash].[ext]",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

if (!jsResult.success) {
  console.error("JS build failed:", jsResult.logs);
  process.exit(1);
}

const jsFile = jsResult.outputs.find((o) => o.path.endsWith(".js"));
if (!jsFile) {
  console.error("No JS output produced");
  process.exit(1);
}
const jsName = jsFile.path.split("/").pop()!;

// Build CSS via tailwind
const cssOutPath = `${outdir}/main.css`;
await $`bunx @tailwindcss/cli -i ./src/main.css -o ${cssOutPath} --minify`;

// Hash the CSS file for cache busting
const cssBytes = await Bun.file(cssOutPath).arrayBuffer();
const cssHash = Bun.hash(cssBytes).toString(16).slice(0, 8);
const cssHashedName = `main-${cssHash}.css`;
await cp(cssOutPath, `${outdir}/${cssHashedName}`);
await rm(cssOutPath);

// Write index.html
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>logs-drain</title>
    <link rel="stylesheet" href="/${cssHashedName}" />
  </head>
  <body class="bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
    <div id="root"></div>
    <script type="module" src="/${jsName}"></script>
  </body>
</html>
`;
await Bun.write(`${outdir}/index.html`, html);

console.log(`Built ${jsName} + ${cssHashedName}`);
