import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

const entries = {
  "background/service-worker": "src/background/service-worker.ts",
  "content/page-hook": "src/content/page-hook.ts",
  "content/leetcode-content": "src/content/leetcode-content.ts",
  "popup/popup": "src/popup/popup.ts",
  "options/options": "src/options/options.ts",
};

const staticFiles = [
  ["manifest.json", "manifest.json"],
  ["icons", "icons"],
  ["src/ui/base.css", "ui/base.css"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/options/options.html", "options/options.html"],
  ["src/options/options.css", "options/options.css"],
];

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: Object.fromEntries(Object.entries(entries)),
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome111",
  platform: "browser",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
};

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    const dest = join(dist, to);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(root, from), dest, { recursive: true, filter: (src) => !src.endsWith(".DS_Store") });
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{ name: "copy-static", setup: (b) => b.onEnd(() => copyStatic()) }],
  });
  await ctx.watch();
  console.log("Watching for changes. Reload the extension in chrome://extensions after each rebuild.");
} else {
  await build(options);
  await copyStatic();
  console.log(`Built extension into ${dist}`);
}
