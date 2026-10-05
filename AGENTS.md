# AGENTS.md

Guidance for AI coding agents.

## Using this action in another repository

If you are setting up CI for a monorepo, read [llms.txt](llms.txt) for concise usage, or the Agent Skill at [skills/dynamic-monorepo/SKILL.md](skills/dynamic-monorepo/SKILL.md). Always guard matrix jobs with the `has_*` outputs.

## Working on this repository

- **Setup:** Node 24 and Yarn 4 (`corepack enable && yarn install`). npm works too.
- **Commands:**
  - `yarn typecheck`
  - `yarn test`: Vitest, end-to-end against the bundled `dist/`.
  - `yarn build`: commit `dist/`, and keep `dist/cli.js` executable.
- **Tests:** prefer end-to-end tests. Every bug fix needs a regression test.
- **Untrusted input:** repository files, git data and config are untrusted. Never run them, and never pass them to a shell.
- **Constraints:** don't add runtime dependencies. Don't mention or compare other actions or tools in docs.
