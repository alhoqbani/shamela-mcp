# shamela-mcpb — Claude Code Context

This repo packages a Maktabah al-Shamela 4 search server as an `.mcpb` (MCP Bundle) for install into Claude Desktop. Architecture, IPC contract, citation format, and roadmap live in [docs/](docs/).

## Build commands

All scripts are Node-based (no PowerShell) so they run on Windows + macOS + Linux:

```bash
npm install                 # one time per checkout
npm run build               # esbuild Node + javac Java helper
npm run build:lib           # tsc → dist/lib (the importable library; also runs on npm install)
npm run test                # unit + integration suite (vitest)
npm run smoke               # exercise every tool against the local Shamela install
npm run benchmark           # Mode 1 + Mode 2 workflow simulations
npm run pack                # full chain: build:server + build:java + mcpb pack
npm run release             # cut a release: pre-flight + pack + tag + GitHub Release
npm run release:dry         # run all pre-flight checks, skip pack/tag/publish
```

`build:java` requires JDK 21+ (`javac` + `jar`). It searches PATH, then `JAVA_HOME`,
then platform defaults: Eclipse Adoptium / Microsoft / Oracle / Corretto on Windows,
`/usr/libexec/java_home -v 21` on macOS, `/usr/lib/jvm/*` on Linux. Set `JAVA_HOME`
explicitly if your JDK is in a non-standard location.

### On macOS

Shamela installs to `~/Library/Application Support/Shamela` — capital S, no `4`,
unlike the Windows `shamela4`. `build:java` finds it there without help.

It ships a **JRE only** (`java`, no `javac`), so the helper still needs a real
JDK to compile:

```bash
brew install openjdk@21          # the temurin@21 cask needs sudo; this does not
cp ~/Library/Application\ Support/Shamela/app/lucene/2/AlKhalil-Analyzer-2.1.jar src/java/libs/
cp ~/Library/Application\ Support/Shamela/app/lucene/2/shamela-misc-1.0.0.jar   src/java/libs/
npm run build:java && npm run test
```

No `JAVA_HOME` and no `PATH` export. `openjdk@21` is keg-only — Homebrew does
not symlink it, and `/usr/libexec/java_home` cannot see it — so `build:java`
probes the Homebrew prefixes directly.

Note that macOS ships `/usr/bin/javac` as a **stub**: it exists, it resolves on
`PATH`, and it fails on invocation with "Unable to locate a Java Runtime". Any
check of the form "is javac on PATH" therefore succeeds on a Mac with no JDK at
all. `build:java` runs `javac -version` on each candidate instead of testing for
the file, and that is why. Do not weaken it back to an existence check.

**Integration tests must not assume an incomplete library.** Never hardcode a
book id to mean "not downloaded" (use `findNotDownloadedBookId` from
`tests/fixtures/shared.ts`) and never cap pagination below `catalog.bookCount()`.
Both mistakes pass on a partial install and fail on a full one — see
[docs/review-1.3.0.md](docs/review-1.3.0.md).

## Branching — `main` is protected

**Nothing is pushed to `main` directly. Every change goes through a pull
request**, including the maintainer's own and including one-line fixes.
Protection is enforced on GitHub, not by convention: a PR is required, it
applies to administrators, the `unit` check must pass, and force-pushes and
deletions are refused.

```bash
git checkout -b <type>/<short-name>
# … work, commit …
git push -u origin <type>/<short-name>
gh pr create --fill
```

Required approvals is deliberately **0**. GitHub does not let you approve your
own pull request, so any higher number would leave a solo maintainer unable to
merge anything. The gate here is the PR itself — a reviewable diff and a green
CI run before code reaches `main` — not a second pair of eyes.

If a push to `main` is rejected, that is the protection doing its job. Open a
PR; do not look for a way around it.

Tags are not covered by branch protection, so `npm run release` still pushes
`v*` and publishes normally.

## Release workflow

Releases publish a `.mcpb` to GitHub Releases on this repo. The flow is
**manual on the developer machine** — CI can't build the helper jar
without the user's Shamela install (which we can't ship for clean-room
reasons).

### When the user says "ship a release" / "cut a release" / "publish"

**Claude decides the semver bump using the rules below.** Don't ask the user
which bump to use unless the change is genuinely ambiguous. State the chosen
bump and rationale in one sentence before proceeding, so the user can override
if they disagree.

The release is one command: `npm run release`. Before running it, Claude
must do the version bump — **on a branch, through a PR**, because `main` is
protected and the old "commit and push" step is now refused:

1. Read the current version from `manifest.json` (single source of truth).
2. Decide the bump per the rules below; compute the new version `X.Y.Z`.
3. Update **both** `manifest.json` and `package.json` to `X.Y.Z`.
4. **Write `docs/release-notes/vX.Y.Z.md`** — in Arabic, as prose for a reader.
   First line is an H1 carrying the release title:
   `# vX.Y.Z — <عنوان عربي موجز>`. `docs/release-notes/v1.3.0.md` is the model.
5. Branch, commit `release: vX.Y.Z — <one-line summary>`, push the branch,
   open a PR, and merge it once CI is green.
6. `git checkout main && git pull`, then `npm run release`.

**Release notes are written, never generated.** The readers of this project
read Arabic, and every release has been written in Arabic. `--generate-notes`
produced an English list of PR titles for v1.3.0 — which also missed the four
new tools entirely, because they arrived as commits rather than as pull
requests, and announced the maintainer as a first-time contributor to his own
repository. Pre-flight step 9 now refuses to publish without the file, and
refuses a file with no Arabic in it.

**Claude does not run the final step.** `npm run release` publishes to the world and is
effectively irreversible — users download the artifact. Claude prepares
everything up to it (merge, `npm run release:dry` until all nine checks pass,
`npm run pack` + `npm run verify:mcpb` so there is a bundle to test), then hands
the command over. Do not reach for `git tag` / `gh release create` to work
around this.

`npm run release` runs nine pre-flight checks (clean tree, on main, in sync
with origin, version consistency, tag unused, commits since last tag, vitest
green, gh authenticated, Arabic release notes present) and refuses on any failure. After pre-flight: packs
the `.mcpb`, creates an annotated tag, pushes it, and publishes a GitHub
Release with the `.mcpb` attached and auto-generated notes from commits since
the last release.

### Semver decision rules (Claude follows these autonomously)

Inspect every commit since the most recent `v*` tag
(`git log <last-tag>..HEAD --oneline`) and pick the **highest** category
that any commit falls into:

**MAJOR (X.0.0)** — breaks existing callers. Every user must update.
- Removed a tool from the registered set
- Renamed a tool
- Removed an input parameter, OR added a new REQUIRED input parameter (no default)
- Removed a field from `structuredContent`, OR changed an existing field's type
- Changed tool semantics so the same input now returns materially different results
  (e.g. a search returns different hits, a citation formats differently)

**MINOR (x.Y.0)** — adds capability, backward compatible.
- Added a new tool
- Added a new optional input parameter (with a sensible default)
- Added a new field to `structuredContent` alongside existing fields
- New search options, new scope filter dimensions, new citation styles
- Performance improvement that meaningfully changes latency tier (e.g. 10s → 1s)

**PATCH (x.y.Z)** — fix or invisible-to-user change.
- Bug fix that makes the tool behave the way the docstring already promised
- Documentation / docstring text update (LLM-facing prompts count — they
  don't change the JSON API)
- Internal refactor, test additions, build/CI/script changes
- Performance improvement with no observable difference to the caller
- Dependency bumps (without behavior change)

**No bump needed at all** — don't release.
- Only docs/test/build commits, AND no fixes to code that ships in `dist/`
  (e.g. README typo, CLAUDE.md edit, GitHub Actions tweak)
- Note: even one bug-fix commit triggers at least a patch release.

**Edge cases — ask the user instead of guessing:**
- A "fix" that changes behavior in a way some users could reasonably have
  depended on (e.g. today's strict `downloaded` flag — books that used to
  report `true` now report `false`). Argue patch (it was a bug), but flag it.
- A new tool that supersedes an old one but the old one isn't removed yet —
  could be minor or could be major-with-deprecation.
- Anything where the commit messages are unclear about user-visible impact.

### Worked example — today's situation (post-1.0.0)

Commits since `v1.0.0` (none yet, so since the latest `main`):
- `test:` install vitest pyramid → patch (test infra, no shipped code)
- `fix:` search_books scope → patch
- `fix:` get_book.downloaded strict → patch (was a bug — flag to user since
  it's the borderline case)
- `docs:` drop hardcoded book 9942 → patch (LLM-facing prompt fix)
- `build:` cross-platform pack pipeline → patch (build only)
- `build:` add npm run release → patch (tooling only)

Highest category: **patch**. Bump `1.0.0 → 1.0.1`. Commit
`release: v1.0.1 — bug fixes + cross-platform build`. Run `npm run release`.

### First-time setup (per machine)

```bash
winget install GitHub.cli   # Windows
# brew install gh           # macOS
# apt install gh            # Linux
gh auth login               # interactive — opens browser
```

To preview the pre-flight checks without actually releasing:
`npm run release:dry`.

## Hard rules

1. **Read-only access to Shamela's data.** All SQLite opens are read-only via sql.js, all Lucene reads via `DirectoryReader`. Never write to `<install>/database/` or `<install>/app/`.
2. **No copying of Shamela's code.** Clean-room boundary is the search engine spec. Reference the spec; write fresh code.
3. **Lucene + AlKhalil are NOT bundled.** They come from the user's Shamela install at runtime via classpath. We bundle our own helper jar (~45 KB).
4. **AlKhalil-Analyzer-2.1.jar and shamela-misc-1.0.0.jar must be present in `src/java/libs/` for the Java helper to compile.** That folder is gitignored. Populate from the local Shamela install:
   ```powershell
   Copy-Item C:\shamela4\app\lucene\2\AlKhalil-Analyzer-2.1.jar     src\java\libs\
   Copy-Item C:\shamela4\app\lucene\2\shamela-misc-1.0.0.jar        src\java\libs\
   ```
   (Adjust the source path if Shamela is installed elsewhere.)

## Path resolution priority (`src/server/paths.ts`)

For Windows users, the Shamela install location is user-chosen at install time. Resolution probes in order:

1. Env var `SHAMELA_INSTALL_ROOT` (set by Claude Desktop from `user_config.shamela_install_folder` per the manifest).
2. Windows registry — both `HKLM\…\Uninstall\*` and `HKCU\…\Uninstall\*`, including the `WOW6432Node` mirror, matching `DisplayName` containing "Shamela" or "المكتبة الشاملة"; returns `InstallLocation`.
3. Common locations: `C:\shamela4`, `C:\Program Files\shamela4`, `C:\Program Files (x86)\shamela4`, `%LOCALAPPDATA%\shamela4`, `%USERPROFILE%\shamela4`, `%USERPROFILE%\Desktop\shamela4`, `D:\shamela4` … `F:\shamela4`.

Accepts either an install root (with `database/` and `app/` siblings) or a `database/` folder directly. Throws `SHAMELA_NOT_FOUND` listing every path checked on failure.

## The library boundary (`registerAllTools`)

This repo is both a `.mcpb` extension and a library that `shamela-mcp-server`
pins as a git dependency. One tool surface serves both, so keep the split
intact:

| File | Role |
| --- | --- |
| `src/server/db.ts` | `ShamelaDb` — the only way any code here opens SQLite. |
| `src/server/sqljs.ts` | The sql.js implementation. Takes the wasm bytes; never decides where they came from. |
| `src/server/backend.ts` | `ShamelaDeps` (paths + db + helper) → `BackendProvider`. Everything host-specific is in that one interface. |
| `src/server/register.ts` | `registerAllTools(server, deps)` — the public API. The 34 `registerTool` calls live here. |
| `src/server/index.ts` | The library's export surface. Re-exports only; no logic. |
| `src/server/entry.ts` | The extension: the `.wasm` import, sql.js, `JavaHelper`, stdio, `main()`. esbuild's entry point. |

Rules that keep it working:

- **No `sql.js` import outside `sqljs.ts`, and no `.wasm` import outside
  `entry.ts`.** A consumer with a native SQLite driver must never load either.
- **Tools depend on the `Helper` interface, not on `JavaHelper`.** A host may
  run the search engine somewhere else entirely.
- **`registerAllTools` is the API other repos use.** `createServer(getBackend)`
  stays for tests and for hosts that already own a `Backend`.
- **`tests/unit/library-boundary.test.ts` is the contract test.** It
  registers all 34 tools with a stub db and a stub helper — no install, no
  wasm, no JVM. It is a *unit* test on purpose: CI has none of those, and this
  is what another repository builds on. If it ever needs a real anything, the
  boundary has leaked.
- **Two builds, one source tree:** `dist/index.js` (esbuild, for the `.mcpb`)
  and `dist/lib/` (tsc via `tsconfig.lib.json`, for `import`). `prepare` runs
  the second so a git install builds it in the consumer.
- **`zod` and `@modelcontextprotocol/sdk` are peer dependencies, and zod stays
  on 3.** Zod 4 makes the SDK emit input schemas without
  `additionalProperties: false` — a wire change on all 34 tools. See
  [docs/decisions.md](docs/decisions.md) §١٣ before touching either version.

## Testing rules (NEVER violate)

1. **No code without tests.** Every new function, tool, or module ships with at least one test in the same commit. PRs without tests are incomplete.

2. **Run the full test suite after every iteration.** Before declaring any change complete, run `npm run test` and confirm everything passes. If a test you didn't intend to touch starts failing, you've introduced a regression — find it before continuing.

3. **Bug reports become regression tests.** When the user (or a contributor) reports a bug, the fix has two parts in one commit:
   - First, write a failing test that reproduces the bug.
   - Then, fix the bug. The test now passes.
   - Commit both together with a message that references the bug.
     This guarantees the bug never silently returns.

4. **Test at the right layer.** Pure functions get unit tests in `tests/unit/`. Code that touches Lucene / SQLite / the JVM gets integration tests in `tests/integration/`. Don't write integration tests for logic that could be unit-tested — they're slower and they make the failure point harder to find.

5. **Tests must run from a clean checkout.** A new contributor cloning this repo should be able to run `npm install && npm run test` and see all tests pass (assuming a Shamela install is present and the helper jar is built). Don't write tests that depend on machine-specific state, half-built indexes, or "well, you have to do X first."

6. **Test assertions are not optional.** Every test must actually verify something — `expect(x).toBe(y)`, not "the code ran without throwing." A test without an assertion is a false confidence-builder.

7. **Don't disable tests to ship.** If a test fails, fix the test or fix the code; don't `.skip` it. Skipped tests rot. The only acceptable use of `.skip` is when a feature is genuinely deferred (e.g., `preserve_*` toggles awaiting v1.1) — and even then, prefer a passing test that asserts the deferral via `OPTION_NOT_SUPPORTED`.

8. **Smoke tests are not unit tests.** `tests/smoke.ts` is a fast end-to-end gut-check. It still exists and still runs. But it does not replace fine-grained tests — it complements them.

## Test commands

```powershell
npm run test                # run all tests (unit + integration)
npm run test:unit           # fast — no JVM, no SQLite
npm run test:integration    # slower — needs Shamela install + book 9942
npm run test:watch          # watch mode for development
npm run test:coverage       # generate coverage report (HTML in coverage/)
npm run smoke               # the legacy fast smoke check (stays for now)
```

## Test layer reference

| Layer       | Directory                      | What it tests                             | Speed   |
| ----------- | ------------------------------ | ----------------------------------------- | ------- |
| Unit        | `tests/unit/`                  | Pure functions, no I/O                    | ms      |
| Integration | `tests/integration/`           | Real Lucene / SQLite / JVM / MCP protocol | seconds |
| Smoke       | `tests/smoke.ts`               | End-to-end sanity check                   | seconds |
| Benchmark   | `tests/benchmark.ts`           | Mode 1 / Mode 2 workflow simulations      | minutes |

## Best practices for this project

- **Arabic text in tests:** save `.test.ts` files as UTF-8 without BOM. Don't use `ا`-style escapes when literal Arabic is clearer; reserve escapes for non-printing characters.
- **JVM startup is the slow part.** Integration tests share one JVM via `tests/fixtures/shared.ts`. The vitest config sets `isolate: false` and `fileParallelism: false` so module-level singleton caching survives across files. Don't spawn a fresh helper per test.
- **Lucene results depend on indexed data.** Tests that assert hit counts (e.g. `9` for "الكلام") are anchored to **book 9942 alone** — the canonical fixture documented in `tests/fixtures/shared.ts`. If you add fixture books, document them there.
- **Don't test Shamela's behavior — test ours.** A test that asserts "Lucene tokenizes correctly" is testing Apache Lucene. We assume Lucene works. We test that *our* code calls Lucene correctly and handles the results correctly.
- **Time-sensitive data:** none. No need for clock mocking. If a future feature needs time, mock with `vi.useFakeTimers()`.
- **Coverage is a tool, not a goal.** ~80% line coverage on pure modules is a healthy floor. Don't chase 100% by writing tests for trivial getters; do chase coverage for any function with branching logic.
- **CI status:** `.github/workflows/test.yml` runs `test:unit` on push. That now
  includes the catalogue, scope-resolution and page-reading paths, because
  `tests/fixtures/synthetic-library.ts` fabricates a whole `database/` tree —
  master.db, per-book files in every bucket spelling, the service DBs — at test
  time. What still cannot run there is anything reading page TEXT or chapter
  TITLES: those come from Shamela's Lucene indexes, read out of the user's own
  install, and no fixture substitutes for them. The fixture's schema is pinned
  from both sides: `tests/unit/synthetic-library.test.ts` checks the generated
  files, `tests/integration/fixture-shape.test.ts` checks the real ones, so a
  schema change in Shamela fails on a maintainer's machine before the fixture
  can start lying to CI.
- **The `.wasm` import lives in `src/server/entry.ts` and nowhere else.** It is
  the extension's own entry point, and the only module esbuild's
  `--loader:.wasm=binary` has to resolve. Shared code takes a `ShamelaDb`
  (`src/server/db.ts`) instead of calling sql.js, so tests build the sql.js
  implementation from a wasm read off disk (`getDb()` in
  `tests/fixtures/shared.ts`) and vitest needs no `.wasm` stub plugin. If you
  ever move that import back into shared code, you re-break every consumer that
  is not esbuild — including the test runner.
