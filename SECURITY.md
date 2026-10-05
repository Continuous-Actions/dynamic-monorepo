# Security policy

## Reporting a vulnerability

Please **do not** open a public issue. Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/OpenMind-SI/dynamic-monorepo/security/advisories/new).
We aim to acknowledge reports within 3 working days.

## Supported versions

| Version | Supported |
| --- | --- |
| v1.x | Yes |

## Recommendations for users

- Pin the action by full commit SHA (`uses: OpenMind-SI/dynamic-monorepo@<sha> # v1.x.y`), or at least to the `v1` tag.
- Grant only `contents: read`. The action needs no other permission and uses no token.
- Pass matrix values to scripts through `env:` instead of `${{ }}` interpolation inside `run:`.

## Threat model

The configuration file, git history and file names are treated as untrusted. See
[docs/decisions.md#security-model](docs/decisions.md#security-model) for the controls in place.
