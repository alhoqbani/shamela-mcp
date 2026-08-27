# Protocol conformance review — the tool surface, measured

Reviewed at `c102902` (v1.3.0, 34 tools) against the MCP specification
revision **2026-07-28**, the OpenAI Apps SDK server reference, and the general
MCP best-practice checklist.

Method: the server was booted over a real transport and the actual
`tools/list` payload inspected field by field, rather than read off the
source. Timings were measured the same way. Nothing here is inferred from
reading code.

**Result: zero spec violations.** Every MUST in the tools specification is
met, and the SHOULDs are met too. What follows is cost and contract quality,
not conformance — but the first item is large enough to matter, and it grows
teeth the moment the tool surface is served to a library consumer over a
network instead of over stdio.

Nothing in this document blocks a release. Items 1 and 2 are worth landing
before the tool surface is exposed anywhere new.

---

## What already holds up

Checked against the live wire payload:

- All 34 tool names match `^[A-Za-z0-9_.-]{1,128}$`, are unique, and carry a
  consistent `shamela_` prefix.
- `manifest.json` and the registered set agree exactly — 34 names, no drift in
  either direction.
- Every tool carries `title`, `description`, an `inputSchema` of
  `type: "object"`, an `outputSchema`, and all four annotation hints. No
  partial descriptors.
- Annotations are honest: `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false` on all 34 — and all 34
  genuinely are read-only queries against local data.
- Tool order is stable across calls. This satisfies a SHOULD that is new in
  2026-07-28: deterministic ordering so clients can cache the list and so
  prompt caches hit.
- No `$schema` dialect stamp anywhere in the payload — the `schemaCompat`
  transport hook does what its comment claims.
- Errors come back as `isError: true` with an actionable code prefix
  (`BOOK_NOT_FOUND`, `INTERNAL`), which is what the spec asks for so a model
  can self-correct.
- Server `instructions` are 2,992 characters and the first 512 stand alone as
  the anti-attribution rules — a property third-party hosts specifically ask
  for.
- Pagination returns the recommended shape: `total_hits`, `returned`,
  `offset`, `has_more`, `next_offset`, over a `total_count` / `returned_count`
  envelope.
- Uses no Roots, no Sampling, no Logging — all three deprecated in
  2026-07-28. Diagnostics already go to `stderr`, which is the recommended
  migration.
- No cross-call state, no handles, no session assumptions. The stateless
  direction the spec just took costs this server nothing.

---

## 1. The tool surface costs about 30,800 tokens to advertise

A live `tools/list` response is **123,176 bytes** of JSON. Every conversation
pays that before the user asks anything.

| Component | Bytes | ≈ tokens | Share |
| --- | ---: | ---: | ---: |
| Input schemas | 70,172 | 17,543 | 57% |
| Descriptions | 27,446 | 6,862 | 22% |
| Output schemas | 16,905 | 4,226 | 14% |
| Names, titles, annotations | 5,615 | 1,404 | 5% |

Token figures are bytes ÷ 4. Arabic in the titles tokenizes worse than that,
so these are floors.

**Nearly half of the payload is literal repetition** — 59,552 redundant bytes,
about 14,900 tokens. The same sub-schema objects are inlined verbatim across
tools:

| Repeated sub-schema | Copies | Bytes each | Wasted |
| --- | ---: | ---: | ---: |
| `scope` (whole object) | 9 | 2,564 | 20,512 |
| `response_format` | 34 | 314 | 10,362 |
| `options` (morphology block) | 4 | 1,611 | 4,833 |
| `scope.period_basis` | 9 | 597 | 4,776 |
| `scope.category_ids` | 10 | 428 | 3,852 |
| `scope.madhhab` | 9 | 397 | 3,176 |
| `scope.downloaded_only` | 10 | 266 | 2,394 |
| `offset` | 10 | 220 | 1,980 |
| `scope.period_from` | 10 | 220 | 1,980 |
| eight more | — | — | 5,687 |

Some of these carry whole paragraphs. `scope.period_basis` spends 597 bytes
explaining that `book_date` is not the year a book was written — a genuinely
important caveat, restated identically nine times. `scope.category_ids`
carries a paragraph of madhhab research method, ten times over. That guidance
is real and it is correct. A tool schema is simply the most expensive place in
the system to keep it: the server `instructions` and `shamela_guide` are both
paid for once.

### What to do

**First, and with no compatibility risk:** trim the prose inside the shared
blocks, and move the method advice into `shamela_guide` and the server
instructions. Cutting `response_format` to one line and the four worst `scope`
descriptions to a sentence each recovers roughly 5–6k tokens — about 18% of
the payload — without changing a single schema *shape*. The snapshot in
`tests/snapshots/tool-schemas.json` makes this safe to do incrementally.

**Second, but field-test it:** `$defs` + `$ref` would collapse most of the
remaining ~9k. Revision 2026-07-28 explicitly blesses this — SEP-2106 loosens
`inputSchema` to any JSON Schema 2020-12 keywords and adds `$ref` resolution
requirements. But older clients may not resolve refs, and this repository
already carries `schemaCompat.ts` because a client rejected our schemas over a
`$schema` stamp. That was found in the field, on the first call, with every
tool unreachable. Do not ship refs on faith.

---

## 2. Two hundred of 527 declared output properties carry no type at all

`outputSchemas.ts` uses `z.unknown()` for most fields, which serializes to a
bare `{}`. The worst case is the one that matters most: in every search tool,
`results` — the actual payload — is declared as

```json
{"type": "array", "items": {}}
```

The schema promises an array and says nothing whatsoever about what is in it.

That inverts the stated purpose of the file. Its own header says the shapes
exist so that "the distinctions this extension exists to keep straight — matn
vs footnote, printed page vs Shamela's automatic count, present on disk vs
merely catalogued — become part of the contract." Every one of those
distinctions lives inside `results[]`, and `results[]` is exactly the part
left untyped. What the schema enforces today is mostly that no undeclared key
appears at the *top* level.

### What to do

Type the `results[]` item for the search and page tools — at minimum
`book_id`, `book_name`, `author_name`, `page_id`, the printed-page label, and
the matn/footnote discriminator. That is the point where the anti-attribution
guarantees stop being prose and start being machine-checkable.

Leave the item objects **open**. The SDK renders top-level output schemas with
`additionalProperties: false` (confirmed on all 34), so a newly returned field
fails the call outright — the trade-off `outputSchemas.ts` already documents
and accepts. Keep that strictness at the top level, but do not extend it
inside `results[]`: a typed-but-open item gets the contract without the
brittleness, and `tests/integration/output-schemas.test.ts` already guards the
level that matters.

---

## 3. One undocumented parameter

`shamela_suggest_download.limit` is the only parameter across all 34 tools
without a `description`. Every other one has it. One line.

---

## 4. Two hazards for library consumers

Neither is a defect today. Both become one the moment this repository exposes
a library surface for an external consumer to register tools against.

**`schemaCompat` is attached to `connect()`, not to the tools.** The `$schema`
stripping works by wrapping `server.connect(transport)` inside `createServer`.
A consumer that registers tools through some future `registerAllTools(server,
deps)` and connects its own transport silently bypasses the hook, and the
draft-07 stamp returns — the exact fault that made every tool unreachable in
the 2.0.0 field test. Whatever the library boundary exports must carry the
stripping with it, and a test must assert its absence on the wire.

**Zod major version.** This repository pins `zod@^3.24.1`. A consumer on
`zod@^4` that passes our shapes into `registerTool` puts two zod majors in one
process with schema objects crossing between them — a well-known failure mode.
This repository owns the shapes, so this repository should decide the version.
Settling it while the boundary is still being designed is far cheaper than
debugging it afterwards.

---

## Not changed, for the record

**Markdown rather than serialized JSON in the text block.** Both the MCP spec
and the Apps SDK suggest returning the serialized JSON in a `TextContent`
block alongside `structuredContent`. We return Arabic markdown there instead.
That wording is a SHOULD aimed at clients which ignore `structuredContent`
entirely; the markdown is better for the model and costs nothing in
conformance. This is a decision, not an oversight.

**Four noun-form tool names.** `shamela_health`, `shamela_guide`,
`shamela_root_stats` and `shamela_research_scope` are noun-form where the
best-practice checklist asks for action-oriented naming. The other 30 comply.
Renaming a tool is a MAJOR bump under our own semver rules, and the names are
clear. Left alone deliberately.

**Thirty-four tools is a lot.** Several overlap by design — `search_pages`,
`search_phrase`, `search_exact`, `search_boolean` and `root_stats` all search
page text with different engines behind them. The guidance is to prefer
comprehensive coverage over a smaller set of workflow tools, and each
description names its siblings and says when to prefer them. No change.

---

## The 2026-07-28 revision itself

Worth stating plainly: **it cannot be targeted today.** The latest TypeScript
SDK, 1.30.0, published 2026-07-27 — one day before the specification — still
reports `LATEST_PROTOCOL_VERSION = "2025-11-25"`. There is no
`server/discover`, no `resultType`, and no per-request `_meta` version
plumbing in it. We are already on the newest SDK that exists.

The revision moves toward where this project already stands. It removes
protocol sessions and the `initialize` handshake entirely, and servers needing
cross-call state must pass explicit handles as ordinary tool arguments. We
have no cross-call state, so there is nothing to unwind.

| 2026-07-28 change | Effect here |
| --- | --- |
| Sessions and `Mcp-Session-Id` removed | None — already stateless |
| `initialize` removed; version in per-request `_meta` | Blocked on SDK; no design change needed |
| `server/discover` now mandatory | Blocked on SDK |
| `resultType` required on all results | Blocked on SDK |
| `ttlMs` + `cacheScope` on list results | Wanted — directly addresses item 1 for network consumers |
| Deterministic `tools/list` ordering (SHOULD) | Already satisfied |
| Roots, Sampling, Logging deprecated | None — uses none of them |
| `$ref` / full 2020-12 keywords allowed | Unblocks item 1's dedup path, once clients catch up |

The action is to watch the SDK, not to build a shim for a revision no client
speaks yet.
