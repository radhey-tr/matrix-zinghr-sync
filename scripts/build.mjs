/**
 * Production build.
 *
 * Bundles our own sources to plain ESM so deployment needs no
 * --experimental-strip-types. Every runtime dependency stays external:
 * better-sqlite3 because it is a native module whose prebuilt binary lives in
 * node_modules, and the rest because CJS packages doing dynamic require() of
 * node builtins (undici does) cannot be bundled into ESM.
 *
 * node_modules therefore ships alongside dist/ -- unavoidable for the native
 * module in any case.
 *
 * Migrations are copied to dist/migrations. src/db/index.ts resolves them
 * relative to its own module directory, which is src/db/ unbundled and dist/
 * bundled — so the same line works either way with nothing to configure.
 */
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

for (const [entry, out] of [['src/main.ts', 'dist/main.js'], ['src/cli.ts', 'dist/cli.js']]) {
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external,
    logLevel: 'info',
  });
}

cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
console.log('migrations copied to dist/migrations');
console.log('external (must be present in node_modules):', external.join(', '));
