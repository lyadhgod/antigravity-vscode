// Build script for the extension bundle.
//
// VS Code loads a single CommonJS entry point (`dist/extension.js`). esbuild
// bundles the whole `src/` graph into that file in milliseconds. `vscode` is
// marked external because the editor injects it at runtime — it must never be
// bundled. Node built-ins stay external too (platform "node"). The native
// ConPTY backend used on Windows (`@lydell/node-pty-win32-*`, #1/#2) is loaded
// by a guarded runtime require through a variable, so esbuild leaves it alone;
// it ships as a real folder under `node_modules/` in the VSIX.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info"
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
