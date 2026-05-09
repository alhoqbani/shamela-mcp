# v1.0 Build Decisions

Every non-trivial decision logged with: what, alternatives, why.

---

## D-001: Tool inventory expanded from 13 to 20

**What:** Ship 20 tools in v1.0 instead of the 13 in `PROMPT-MCPB-V1.0.md`.

**Alternatives considered:**
- Ship the 13 from the prompt as-is.
- Ship 13 + 4 quran tools only.
- Ship 13 + 8 extras (also include cover image fetch).

**Why:** The user explicitly authorized expansion ("you are not limited to the 13 tools suggested"). Audit of the reverse-engineered Python (`engine.py`, `dbmanager.py`) revealed seven low-effort, high-leverage additions:

1. `shamela_search_quran` + `shamela_get_aya` — pre-built `aya/` Lucene index ships zero-config; Quran is core to Islamic research.
2. `shamela_get_tafseer_of_aya` + `shamela_get_books_for_hadith` — `service/tafseer.db` and `service/hadeeth.db` ship with the catalog and provide cross-reference joins essential for research-mode work.
3. `shamela_list_downloaded_books` — tells the LLM which subset of the 8,589-book catalog is actually searchable on the user's machine.
4. `shamela_get_book_parts` + `shamela_get_page_services` — per-book SQLite trivia that enables multi-volume navigation and pivoting from a page → ayat/hadith/isnad it touches.

Cover image fetch (`cover.db`) was not selected — UX polish only, no research value. Hadith narrator search (`S1.db` cipher) deferred to v1.1 — cipher work is a separate scope.

---

## D-002: Same repo, no `1.0.0` tag until tests pass

**What:** v1.0 work happens on `main` of `Downloads\shamela-mcpb`. Existing `0.0.1` git tag stays. `1.0.0` tag is the final gate after every Phase 3 assertion and the install test pass.

**Alternatives considered:**
- New repo `shamela-mcpb-v1`.
- Same repo, branch `v1`.

**Why:** User decision (locked). Single repo, single history. The `0.0.1` tag is the rollback point if v1.0 has regressions.

---

## D-003: Migrate to `registerTool` from deprecated `server.tool`

**What:** All 20 tools register via `server.registerTool(name, config, handler)`. Step 1 of Phase 2D is a no-behavior-change migration of v0.0.1's three tools to `registerTool`, verified by re-running the v0.0.1 smoke test.

**Alternatives considered:**
- Keep `server.tool` since v0.0.1 already uses it and it's not removed.

**Why:** mcp-builder explicitly says "DO NOT use: Old deprecated APIs such as `server.tool()`". `registerTool` enables `outputSchema` (typed structured output) and `annotations` (readOnlyHint, etc.) which the skill mandates.

---

## D-004: Author stays `فاعل خير`

**What:** Manifest author and LICENSE copyright stay `فاعل خير`. Same as v0.0.1.

**Alternatives considered:**
- Switch to real name (Hamoud Alhoqbani) for the public release.

**Why:** User decision (locked). Anonymous attribution for a Shamela-derived MCPB.

---

## D-005: Package name stays `shamela-mcpb`, not `shamela-mcp-server`

**What:** `package.json.name` stays `shamela-mcpb`.

**Alternatives considered:**
- Rename to `shamela-mcp-server` per mcp-builder's recommended `{service}-mcp-server` convention.

**Why:** v0.0.1 already shipped under `shamela-mcpb`. The package name describes what it is — an MCPB (MCP Bundle) artifact — not a generic MCP server project. The MCP server's logical name in the manifest stays `"shamela"`. Renaming the npm package would create a needless break for any downstream tooling that pins the v0.0.1 name.

---

## D-006: docs/ allowed in v1.0 repo (v0.0.1 rule relaxed)

**What:** v1.0 ships with a `docs/` directory at the repo root containing four investigation docs + `v1-architecture.md` + `roadmap-v1.1.md` + `ipc-protocol.md`.

**Alternatives considered:**
- Keep all v1.0 docs in the source-investigation repo at `Downloads\shamela-mcp\`.

**Why:** v0.0.1's "no docs" rule was tied to the friend-test scope ("ship the .mcpb only"). v1.0 is a much larger build with investigations whose outputs need to be co-located with the code they justify. The architectural rationale (subprocess vs. java-bridge) stays in the source-investigation repo as the historical record; new investigations specific to v1.0 features live with v1.0 code.

---

## D-007: Status files committed (not gitignored)

**What:** `PROGRESS.md`, `TODO.md`, `DECISIONS.md`, `BLOCKERS.md`, `TEST-RESULTS.md` are committed to the repo so the user can review the build's audit trail in `git log`.

**Alternatives considered:**
- Gitignore them (treat as local-only scratch).
- Keep them in the source-investigation repo.

**Why:** The user explicitly wants to "review the night's work" via these files. Committing them makes the audit trail durable and reviewable through normal git tooling.
