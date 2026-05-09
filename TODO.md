# v1.0 TODO

## Phase 0 — Investigation

- [ ] 0.1 Toggle + wildcard implementation → `docs/toggles-implementation.md`
- [ ] 0.2 Scope filter composition → `docs/scope-implementation.md`
- [ ] 0.3 Catalog + citation reality check → `docs/catalog-survey.md`
- [ ] 0.4 Citation format → `docs/citation-format.md`

## Phase 1 — Architecture

- [ ] 1.1 Lock tool inventory + decisions → `docs/v1-architecture.md`
- [ ] 1.2 Lock IPC additions → `docs/ipc-protocol.md`

## Phase 2 — Build (in dependency order)

- [ ] 2.1 Migrate v0.0.1 tools to `registerTool` (no behavior change)
- [ ] 2.2 `src/server/constants.ts` (CHARACTER_LIMIT, DEFAULT_LIMIT, MAX_LIMIT)
- [ ] 2.3 `src/server/schemas.ts` (PaginationInput, ResponseFormatInput)
- [ ] 2.4 `src/server/format.ts` (markdown/JSON renderers + truncation)
- [ ] 2.5 Catalog extensions (`booksByAuthor`, `booksByCategory`, `categoryPath`, `downloadedBookIds`, `CatalogScope`)
- [ ] 2.6 Citation formatters (`formatShamelaCitation`, `formatShortCitation`, `formatFullCitation`)
- [ ] 2.7 Tool: `shamela_list_categories`
- [ ] 2.8 Tool: `shamela_resolve` (helper `resolve` + Node tool)
- [ ] 2.9 Tool: `shamela_get_book`
- [ ] 2.10 Tool: `shamela_get_author`
- [ ] 2.11 Tool: `shamela_get_citation`
- [ ] 2.12 Tool: `shamela_search_authors` (expanded)
- [ ] 2.13 Tool: `shamela_search_books` (expanded)
- [ ] 2.14 `pages.ts` extensions (`getPagesRange`, `getToc`, `getAncestorChain`, `getSection`, `getBookParts`, `getPageServices`)
- [ ] 2.15 Tool: `shamela_get_page`
- [ ] 2.16 Tool: `shamela_get_toc`
- [ ] 2.17 Helper command: `get_pages_batch`
- [ ] 2.18 Tool: `shamela_get_pages_range`
- [ ] 2.19 Tool: `shamela_get_book_section`
- [ ] 2.20 Helper command: `search_titles`; Tool: `shamela_search_titles`
- [ ] 2.21 Helper command: `search_pages_v2` (scope/options/coverage); Tool: `shamela_search_pages` (expanded)
- [ ] 2.22 Helper command: `search_quran`; Tool: `shamela_search_quran`
- [ ] 2.23 Helper command: `get_aya`; Tool: `shamela_get_aya`
- [ ] 2.24 `src/server/services.ts`; Tool: `shamela_get_tafseer_of_aya`
- [ ] 2.25 Tool: `shamela_get_books_for_hadith`
- [ ] 2.26 Tool: `shamela_list_downloaded_books`
- [ ] 2.27 Tool: `shamela_get_book_parts`
- [ ] 2.28 Tool: `shamela_get_page_services`

## Phase 3 — Tests

- [ ] 3.1 Smoke tests (~25 assertions) for all 20 tools → `tests/smoke.ts`
- [ ] 3.2 All smoke tests pass against Shamela's bundled JRE 21.0.10

## Phase 4 — Evaluation

- [ ] 4.1 `tests/evaluation.xml` — 10 read-only complex questions (mcp-builder format)
- [ ] 4.2 `tests/benchmark.ts` — Mode 1 (≤5 calls) + Mode 2 (≤50 calls) narrative benchmarks
- [ ] 4.3 Both benchmarks pass; results logged to `TEST-RESULTS.md`

## Phase 5 — Polish + ship

- [ ] 5.1 README.md rewrite for v1.0 (Arabic-first, 11 sections, both workflows, 5 example queries)
- [ ] 5.2 `docs/roadmap-v1.1.md`
- [ ] 5.3 manifest.json: bump version to 1.0.0, add all 20 tools, update display_name/description
- [ ] 5.4 Pack `shamela-mcp-1.0.0.mcpb`
- [ ] 5.5 Self-install test in Claude Desktop; all 20 tools visible; Mode 1 query works
- [ ] 5.6 Final commit + git tag `1.0.0`
