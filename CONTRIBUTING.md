# Contributing

Thanks for helping! The project values being **small, fast, deterministic and understandable**.
Before you propose a new option or feature, check that it solves a real problem for monorepo CI users.

## Development

You need Node.js 24 or later and git. The project uses **Yarn 4**. The version is pinned with `packageManager` in `package.json`, and `corepack enable` provides it.

```bash
corepack enable
yarn install
yarn typecheck   # TypeScript 7
yarn test        # Vitest: end-to-end tests drive dist/index.js against real temporary git repos
yarn build       # bundles src/ into dist/index.js (commit the result)
yarn bench       # synthetic benchmarks
```

Prefer npm? `npm install` and `npm run <script>` work too. `yarn.lock` is the canonical lockfile, so don't commit a `package-lock.json`.

`dist/index.js` is committed because GitHub runs actions straight from the repository.
CI fails if `dist/` doesn't match a fresh build.

## Guidelines

- Prefer end-to-end tests (`tests/e2e.test.ts`) that run the bundled action the way the runner does.
- Every bug fix needs a regression test.
- Don't add runtime dependencies without discussing it in an issue first.
- Never pass untrusted strings to a shell. Use `execFile` with argument arrays.
- Keep outputs backwards compatible within a major version.

## Releasing

1. Update `CHANGELOG.md` and run `yarn build`.
2. Tag `vX.Y.Z`, create a GitHub release, and publish it to the Marketplace.
3. Move the major tag: `git tag -f v1 && git push -f origin v1`.
