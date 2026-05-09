# shamela-mcpb — Claude Code Context

This repo packages a Maktabah al-Shamela 4 search server as an `.mcpb` (MCP Bundle) for one-double-click install into Claude Desktop. It is **code-only** by design — no findings, no spec, no rationale lives here.

## Build commands

```powershell
npm install                 # one time per checkout
npm run build               # esbuild Node + gradle Java helper
npm run smoke               # 5 canonical queries; exits 0 on pass
.\scripts\pack.ps1          # produces shamela-mcp-<version>.mcpb at repo root
```

## Hard rules

1. **No docs in this repo.** README + LICENSE + this CLAUDE.md are the only text files. Decision records, findings, and specs live in the source/investigation repo (`Downloads\shamela-mcp\docs\`).
2. **Read-only access to Shamela's data.** All SQLite opens use `mode=ro`, all Lucene reads via `DirectoryReader`. Never write to `<install>/database/` or `<install>/app/`.
3. **No copying of Shamela's code.** This repo's clean-room boundary is the search engine spec. Reference the spec; write fresh code.
4. **Lucene + AlKhalil are NOT bundled.** They come from the user's Shamela install at runtime via classpath. We bundle our own helper jar (~50 KB) plus sqlite-jdbc (which Shamela does not ship).
5. **AlKhalil-Analyzer-2.1.jar and shamela-misc-1.0.0.jar must be present in `src/java/libs/` for the Java helper to compile.** That folder is gitignored. Populate from the local Shamela install:
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
