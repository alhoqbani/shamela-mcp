# shamela-mcpb — Claude Code Context

This repo packages a Maktabah al-Shamela 4 search server as an `.mcpb` (MCP Bundle) for install into Claude Desktop. Architecture, IPC contract, citation format, and roadmap live in [docs/](docs/).

## Build commands

All scripts are Node-based (no PowerShell) so they run on Windows + macOS + Linux:

```bash
npm install                 # one time per checkout
npm run build               # esbuild Node + javac Java helper
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
must do the version bump:

1. Read the current version from `manifest.json` (single source of truth).
2. Decide the bump per the rules below; compute the new version `X.Y.Z`.
3. Update **both** `manifest.json` and `package.json` to `X.Y.Z`.
4. `git commit -am "release: vX.Y.Z — <one-line summary>"` and push.
5. `npm run release`.

`npm run release` runs eight pre-flight checks (clean tree, on main, in sync
with origin, version consistency, tag unused, commits since last tag, vitest
green, gh authenticated) and refuses on any failure. After pre-flight: packs
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
- **CI status:** `.github/workflows/test.yml` runs unit tests on push. Integration tests need a Shamela install — deferred to a future runner spec.
- **The `.wasm` stub:** `vitest.config.ts` ships an inline plugin that returns an empty `Uint8Array` for any `.wasm` import. This shields tests from the esbuild-only `import sqlWasm from "sql.js/dist/sql-wasm.wasm"` in `src/server/index.ts`. Tests load the real wasm via `fs.readFileSync` in the shared fixture. Don't remove the plugin without understanding both code paths.
