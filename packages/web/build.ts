import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile, execFileSync } from "node:child_process";
import { rm, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const root = import.meta.dirname; // packages/web
const outdir = join(root, "dist");
const entry = join(root, "src/main.tsx");
const cssEntry = join(root, "src/main.css");

const watch = process.argv.includes("--watch");

const require = createRequire(import.meta.url);

/** Resolve the @tailwindcss/cli executable so we can run it under Node. */
function tailwindBin(): string {
  const pkgJsonPath = require.resolve("@tailwindcss/cli/package.json");
  const pkg = require("@tailwindcss/cli/package.json") as {
    bin: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.tailwindcss;
  return join(dirname(pkgJsonPath), rel);
}

const esbuildOptions: esbuild.BuildOptions = {
  entryPoints: [entry],
  outdir,
  bundle: true,
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  minify: !watch,
  // Stable name in watch mode (so index.html stays valid); hashed for prod.
  entryNames: watch ? "[name]" : "[name]-[hash]",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
  },
  metafile: true,
  logLevel: "info",
};

function jsOutputName(metafile: esbuild.Metafile): string {
  const jsPath = Object.keys(metafile.outputs).find((p) => p.endsWith(".js"));
  if (!jsPath) {
    console.error("No JS output produced");
    process.exit(1);
  }
  return basename(jsPath);
}

async function buildCss(): Promise<string> {
  const cssOutPath = join(outdir, "main.css");
  execFileSync(
    process.execPath,
    [tailwindBin(), "-i", cssEntry, "-o", cssOutPath, ...(watch ? [] : ["--minify"])],
    { stdio: "inherit" },
  );
  if (watch) return "main.css"; // stable name in dev

  const cssBytes = await readFile(cssOutPath);
  const cssHash = createHash("sha256").update(cssBytes).digest("hex").slice(0, 8);
  const cssHashedName = `main-${cssHash}.css`;
  await rename(cssOutPath, join(outdir, cssHashedName));
  return cssHashedName;
}

async function writeHtml(jsName: string, cssName: string): Promise<void> {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>logs-drain</title>
    <link rel="stylesheet" href="/${cssName}" />
  </head>
  <body class="bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
    <div id="root"></div>
    <script type="module" src="/${jsName}"></script>
  </body>
</html>
`;
  await writeFile(join(outdir, "index.html"), html);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const cssName = await buildCss();

if (watch) {
  // Rebuild CSS on change in the background.
  const cssChild = execFile(process.execPath, [
    tailwindBin(),
    "-i",
    cssEntry,
    "-o",
    join(outdir, "main.css"),
    "--watch",
  ]);
  cssChild.stderr?.pipe(process.stderr);

  const ctx = await esbuild.context(esbuildOptions);
  const first = await ctx.rebuild();
  await writeHtml(jsOutputName(first.metafile!), cssName);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  const result = await esbuild.build(esbuildOptions);
  const jsName = jsOutputName(result.metafile!);
  await writeHtml(jsName, cssName);
  console.log(`Built ${jsName} + ${cssName}`);
}
