package ws.shamela.mcp;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Long-lived helper subprocess. Reads JSON commands one per line from stdin,
 * dispatches, writes JSON responses one per line to stdout.
 *
 * Java side handles only Lucene reads. SQLite reads (master.db catalog,
 * per-book printed-page labels) live on the Node side via sql.js, so this
 * helper does NOT depend on java.sql — Shamela's slim bundled JRE
 * (java.base, java.management, etc., but no java.sql module) can run it.
 *
 * Invocation:
 *   java -cp &lt;Shamela jars + this jar&gt; ws.shamela.mcp.Main &lt;install_root&gt;
 *
 * Exits cleanly on stdin EOF.
 */
public final class Main {

    public static void main(String[] args) {
        if (args.length < 1) {
            System.err.println("usage: java ws.shamela.mcp.Main <install_root>");
            System.exit(2);
        }
        Path installRoot = Paths.get(args[0]);
        Path databaseRoot = installRoot.resolve("database");

        // Force UTF-8 stdout to avoid mojibake on Windows.
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);

        IndexCache indexCache;
        try {
            indexCache = new IndexCache(databaseRoot);
        } catch (Exception e) {
            out.println(Json.encode(Json.obj(
                    "id", "startup",
                    "ok", false,
                    "error", Json.obj(
                            "code", "STARTUP_FAILED",
                            "message", e.getClass().getSimpleName() + ": " + e.getMessage())
            )));
            System.exit(1);
            return;
        }

        // Ready signal — Node ignores unknown ids; useful for diagnostics.
        out.println(Json.encode(Json.obj(
                "id", "ready",
                "ok", true,
                "data", Json.obj(
                        "java_version", System.getProperty("java.version"),
                        "page_docs", safeNumDocs(indexCache, "page"))
        )));

        try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isEmpty()) continue;
                Map<String, Object> response = dispatch(line, indexCache);
                out.println(Json.encode(response));
                out.flush();
            }
        } catch (Exception e) {
            System.err.println("[helper] fatal: " + e);
        } finally {
            indexCache.close();
        }
    }

    private static int safeNumDocs(IndexCache c, String name) {
        try { return c.numDocs(name); } catch (Exception e) { return -1; }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> dispatch(String line, IndexCache indexCache) {
        Map<String, Object> req;
        try {
            req = Json.decodeObject(line);
        } catch (Exception e) {
            return error(null, "BAD_JSON", e.getMessage());
        }
        Object id = req.get("id");
        try {
            String cmd = String.valueOf(req.get("cmd"));
            Object argsObj = req.get("args");
            Map<String, Object> args = argsObj instanceof Map ? (Map<String, Object>) argsObj : new LinkedHashMap<>();
            Object data = switch (cmd) {
                case "ping" -> Json.obj(
                        "pong", Boolean.TRUE,
                        "java_version", System.getProperty("java.version"),
                        "page_docs", safeNumDocs(indexCache, "page"),
                        "book_docs", safeNumDocs(indexCache, "book"),
                        "author_docs", safeNumDocs(indexCache, "author")
                );
                case "search_pages" -> SearchPages.run(
                        indexCache,
                        asString(args.get("query")), asInt(args.get("max_results"), 20));
                case "search_books" -> SearchBooks.run(
                        indexCache,
                        asString(args.get("query")), asInt(args.get("max_results"), 20));
                case "search_authors" -> SearchAuthors.run(
                        indexCache,
                        asString(args.get("query")), asInt(args.get("max_results"), 20));
                default -> throw new IllegalArgumentException("unknown command: " + cmd);
            };
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("id", id);
            resp.put("ok", Boolean.TRUE);
            resp.put("data", data);
            return resp;
        } catch (IllegalArgumentException e) {
            return error(id, "BAD_ARG", e.getMessage());
        } catch (Exception e) {
            return error(id, "INTERNAL", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private static Map<String, Object> error(Object id, String code, String message) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", id);
        resp.put("ok", Boolean.FALSE);
        resp.put("error", Json.obj("code", code, "message", message == null ? "" : message));
        return resp;
    }

    private static String asString(Object o) {
        return o == null ? "" : o.toString();
    }

    private static int asInt(Object o, int defaultValue) {
        if (o == null) return defaultValue;
        if (o instanceof Number n) return n.intValue();
        try {
            return Integer.parseInt(o.toString());
        } catch (NumberFormatException e) {
            return defaultValue;
        }
    }

    private Main() {}
}
