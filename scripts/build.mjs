// Bundles the Action (dist/index.js) and the CLI (dist/cli.js). Each is a single
// self-contained ESM file: nothing is installed at runtime.
import { build } from 'esbuild';
import { statSync } from 'node:fs';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
};
const banner = '// dynamic-monorepos (MIT) https://github.com/OpenMind-SI/dynamic-monorepos. Generated file, do not edit.';

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/index.js', banner: { js: banner } });
await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', banner: { js: `#!/usr/bin/env node\n${banner}` } });
for (const f of ['dist/index.js', 'dist/cli.js']) console.log(`${f}: ${statSync(f).size} bytes`);
