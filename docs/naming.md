> **Final decision (2026-10-05): `dynamic-monorepo`**, chosen by the maintainer from the research shortlist below plus their own proposals. The working name `dynamic-monorepos` (plural) was renamed to the singular form, which matches the config file name `dynamic-monorepo.config.json`.
> It was free on GitHub Marketplace (slug 404), on npm, and as a GitHub user/org, and a repository search for the name returned 0 results.
> The repo and the Action share the name (`uses: continuous-actions/dynamic-monorepo@v1`), and the Marketplace display name is **Dynamic Monorepo**.
> The research recommendation was `monorepo-impact` (66/80). `dynamic-monorepo` is broader: it describes the outcome (dynamic CI for monorepos) rather than the mechanism, which leaves room for future features such as inference and test impact.
> We also considered `monorepo-actions` and rejected it: a GitHub org called `Monorepo-Actions` already exists, and the name reads as a collection of actions.

# Naming: recommendation for the continuous-actions affected-project planning action

Research date: 2026-10-05. Org: `continuous-actions` (renamed from `OpenMind-SI` on 2026-10-05; GitHub redirects the old URLs).

## Recommendation

**`monorepo-impact`** (repo `continuous-actions/monorepo-impact`, usage `uses: continuous-actions/monorepo-impact@v1`).

Runner-up: **`affected-plan`**.

| Field | Value |
|---|---|
| Repo name | `monorepo-impact` |
| Marketplace `name:` | `Monorepo Impact` (slug `monorepo-impact`, verified free) |
| `description:` (108 chars) | Map changed files to projects, walk the dependency graph, and output affected-project matrices with reasons. |
| Branding icon | `share-2` (Feather; three joined nodes, reads as a dependency graph) |
| Branding color | `blue` |
| Future CLI package | `monorepo-impact` (npm free) |

Why: it names the product's job (the impact of a change across a monorepo), is free on Marketplace, npm and as a GitHub user/org, has no famous repo or tool behind it, and does not borrow Nx/Turborepo's "affected" vocabulary or Terraform's "plan". "Impact" also fits the explain-why feature (impact = reason chain). The `monorepo-` prefix keeps the name product-specific, so sibling tools (security, cost, release) can get their own distinct names under the org.

## Method and evidence

All checks run 2026-10-05:
- Marketplace slug: `curl -o /dev/null -w '%{http_code}' https://github.com/marketplace/actions/<slug>` (404 = free). Probe validated: `checkout`, `paths-filter`, `changed-files` return 200; a nonsense slug returns 404.
- Marketplace similar names: scraped `https://github.com/marketplace?type=actions&query=<term>`.
- npm: `https://registry.npmjs.org/<name>` (404 = free).
- GitHub user/org: `https://api.github.com/users/<name>` (404 = free).
- Repos: `gh api search/repositories?q=<name>+in:name&sort=stars`.

Caveats: Marketplace `name:` uniqueness is only finally confirmed in the publish form; slug availability is the best proxy. No legal trademark search was done; only obvious tool/brand confusion was assessed.

## Brainstorm

Vocabulary: affected, impact, scope, graph, plan, change, dependency, project, monorepo, build, CI, pipeline, matrix, reach, cascade, downstream, ripple, blast radius, fan-out, lineage.

Dropped before scoring:
- `gha-impact`: `gha-` prefix is noise inside Actions; results are unrelated "impact" repos.
- `dependency-cascade`: Marketplace already has `dependency-cascade-query-affected-nodes`.
- `ci-scope`: 990 repo-name hits (CityScope etc.), too vague.
- `build-scope`: implies only builds, not test/deploy.
- `change-map`: 342 hits (OSM `changeset-map`).
- `monorepo-graph`: suggests visualization.
- `impact-plan`: 112 hits, reads as an environmental/social impact plan.
- `monorepo-plan`: sounds like a roadmap.
- `downstream`: npm package and GitHub user both taken.

## Evidence table (ten serious candidates)

| Candidate | Marketplace slug | Similar Marketplace actions | npm | GH user/org | Notable repos / confusion |
|---|---|---|---|---|---|
| `monorepo-impact` | free | none for "monorepo impact" | free | free | `zAx4hub/monorepo-impact-radar` (0 stars), `Win-Technologie/impact-app-monorepo` (2); no conflict |
| `monorepo-scope` | free | none | free | free | `JonMac1978/monorepo-scope-tool` (0); "scope" also means npm scope / OAuth scope |
| `affected-plan` | free | many `nx-affected-*`, `dotnet-affected`, `atmos-affected-stacks` (adjacent) | free | free | none; "plan" evokes `terraform plan` |
| `impact-matrix` | free | none | free | free | generic risk-matrix meaning; ties name to one output |
| `ripple-plan` | free | `pr-ripple`, `ripples-impact` (adjacent) | free | free | Ripple brand halo (XRP, Ripple Labs) |
| `change-graph` | free | none | free | free | 133 hits, mostly GraphQL breaking-change tools (`entria/graphql-find-breaking-changes-cli` 43 stars) |
| `monorepo-affected` | free | many affected-* actions | free | free | echoes Nx `affected`, `AlekseyLeshko/affected-workspaces-github-action` |
| `affected-projects` | free | `nx-affected-projects`, `terraform-affected-projects` (same words) | **taken** | free | `rogiervanstraten/terraform-affected-projects`, `jfandy1982/nx-affected-projects-and-deps` |
| `blast-radius` | free | 12+ `blast-radius-*`, `blastguard-*`, `cross-repo-blast-radius-*` | **taken** | **taken (org)** | `28mm/blast-radius` (2193 stars, Terraform graph viewer), `DataDog/package-blast-radius` |
| `ripple` | free | `pr-ripple`, `ripples-impact` | **taken** | **taken (org, 95 repos)** | `Ripple-TS/ripple` (7404 stars), `XRPLF/rippled` (5218) |

Competitive field (not name collisions): `dorny/paths-filter`, `leanix/nx-affected-dependencies-action` (21 stars), `leonardochaia/dotnet-affected-action` (23), `bmcszk/monorepo-matrix` (1 star; Marketplace slug `monorepo-matrix` returns 200, taken, so any "monorepo-matrix" variant is out), Nx `affected`, Turborepo `--affected`. These are ecosystem-bound (Nx, .NET, Terraform) or path-filter only; none combines a generic declared graph with per-project reasons, so the product is differentiated and the name should not look like a clone of any of them.

## Scoring (each /10)

Mem = memorability, Tech = technical relevance, Uniq = uniqueness, Use = GitHub Action usability, Mkt = Marketplace suitability, Repo = repo name quality, Fut = future expansion, Pron = ease of pronunciation.

| Candidate | Mem | Tech | Uniq | Use | Mkt | Repo | Fut | Pron | Total /80 |
|---|---|---|---|---|---|---|---|---|---|
| **`monorepo-impact`** | 8 | 9 | 8 | 8 | 8 | 8 | 8 | 9 | **66** |
| `affected-plan` | 7 | 8 | 8 | 8 | 7 | 8 | 7 | 9 | 62 |
| `impact-matrix` | 7 | 7 | 8 | 7 | 8 | 7 | 6 | 9 | 59 |
| `ripple-plan` | 8 | 6 | 8 | 7 | 7 | 7 | 7 | 9 | 59 |
| `monorepo-affected` | 6 | 8 | 8 | 7 | 7 | 7 | 6 | 8 | 57 |
| `monorepo-scope` | 6 | 6 | 7 | 7 | 7 | 7 | 7 | 9 | 56 |
| `change-graph` | 6 | 6 | 5 | 6 | 6 | 6 | 6 | 9 | 50 |
| `affected-projects` | 6 | 8 | 3 | 6 | 5 | 6 | 6 | 9 | 49 |
| `blast-radius` | 9 | 6 | 1 | 5 | 2 | 5 | 6 | 9 | 43 |
| `ripple` | 8 | 5 | 1 | 4 | 3 | 3 | 6 | 9 | 39 |

Scores are judgment-based; the evidence table drives Uniq, Mkt and Repo. The top two are the only candidates with both a clear technical meaning and a clean namespace.

## Reasoning

### Why `monorepo-impact` wins
- Technical relevance: "impact" is the established term for "what does this change affect" (impact analysis); it covers the reverse-transitive walk and the explain-why output. "Monorepo" names the domain.
- Namespace: free slug, free npm, no user/org, no notable repo (nearest are 0 to 2 stars).
- Usability: `uses: continuous-actions/monorepo-impact@v1` reads naturally; output names (`affected`, `matrix`, `reasons`) stay free to be precise without the name promising a format.
- Marketplace: "Monorepo Impact" is distinctive and does not use a competitor's name (Nx, Turbo).
- Weakness: "impact" is somewhat generic and a reader may not guess it emits matrices. The description, README tagline and topics cover that.

### Why `affected-plan` is only runner-up
- Pros: matches the term users search (Nx, Turbo); short; free everywhere.
- Cons: borrows another tool's term and risks looking like an Nx clone; "plan" suggests Terraform; about a dozen existing `*-affected-*` Marketplace actions crowd the space.
- It is the fallback if `monorepo-impact` is unavailable at publish time.
- For either name, put "affected" in the description and Marketplace topics to capture that search term without putting it in the name.

### Rejected alternatives
- `blast-radius`: good metaphor but taken on npm and as an org, 2193-star `28mm/blast-radius`, 12+ similar Marketplace actions, and a security connotation that clashes with the planned security action.
- `ripple`: org taken (95 repos), 7404-star `Ripple-TS/ripple`, `XRPLF/rippled`, financial-brand baggage.
- `affected-projects`: npm taken; same-word Marketplace actions.
- `monorepo-scope`: "scope" collides with npm and OAuth scopes; weaker meaning.
- `change-graph`: GraphQL schema-change tooling owns the phrase; implies visualization.
- `impact-matrix`: locks the name to one output; reads as a risk-management artefact.
- `ripple-plan`: cute but vague; Ripple halo; "plan" not core.
- `monorepo-affected`: derivative of Nx's term and an existing action.
- Others: see Brainstorm.

## Decision: Action name vs repo name

Use the same string everywhere: repo `monorepo-impact`, Marketplace slug `monorepo-impact`, future npm `monorepo-impact`, usage `continuous-actions/monorepo-impact@v1`.
- Marketplace display name (`name:` in `action.yml`) is `Monorepo Impact`; it must be globally unique and the slug derives from it, so repo and slug match automatically.
- No `gha-` prefix or `-action` suffix: the repo already lives in the Actions context and `uses:` would read redundantly. Keep `-action` only as a fallback if a clash appears.
- Release tags: moving `v1` major tag plus semver tags (independent of naming).

## Decision: Org

`continuous-actions` is fixed and currently has no repos. The name is deliberately product-specific, not an umbrella like `gha-plan`, `ci-tools` or `pipeline`, so future siblings (security, optimizer, cost, release) can take their own descriptive names. Avoid org-prefixed names (`openmind-*`); the org already appears in `uses:`.

## Pre-publish checklist
1. Create `continuous-actions/monorepo-impact`; re-run the slug probe right before first release (expect 404 from `https://github.com/marketplace/actions/monorepo-impact`).
2. Set `name: Monorepo Impact`, the description above, and `branding: { icon: share-2, color: blue }`.
3. Marketplace category: Continuous integration (plus Utilities). Topics: `monorepo`, `affected`, `dependency-graph`, `github-actions`, `matrix`.
4. Claim npm `monorepo-impact` only when the CLI is real (no squatting).
5. Fallbacks in order: `affected-plan`, `impact-matrix`.

## Sources
- Marketplace probes/searches: https://github.com/marketplace/actions/monorepo-impact (404), https://github.com/marketplace?type=actions&query=affected, https://github.com/marketplace?type=actions&query=ripple, https://github.com/marketplace?type=actions&query=blast+radius
- Taken slug: https://github.com/marketplace/actions/monorepo-matrix
- Repos: https://github.com/28mm/blast-radius, https://github.com/DataDog/package-blast-radius, https://github.com/Ripple-TS/ripple, https://github.com/XRPLF/rippled, https://github.com/leanix/nx-affected-dependencies-action, https://github.com/leonardochaia/dotnet-affected-action, https://github.com/rogiervanstraten/terraform-affected-projects, https://github.com/bmcszk/monorepo-matrix, https://github.com/zAx4hub/monorepo-impact-radar
- npm: https://registry.npmjs.org/affected, https://registry.npmjs.org/blast-radius, https://registry.npmjs.org/ripple
- Orgs: https://github.com/continuous-actions, https://github.com/Blast-Radius, https://github.com/ripple
- Action branding docs: https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions#branding
