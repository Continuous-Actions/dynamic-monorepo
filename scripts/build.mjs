// Bundles src/main.ts and its single runtime dependency into dist/index.js.
import { build } from 'esbuild';
import { statSync } from 'node:fs';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  banner: { js: '// dynamic-monorepos — https://github.com/OpenMind-SI/dynamic-monorepos (MIT). Generated file, do not edit.' },
  logLevel: 'warning',
});
console.log(`dist/index.js: ${statSync('dist/index.js').size} bytes`);
