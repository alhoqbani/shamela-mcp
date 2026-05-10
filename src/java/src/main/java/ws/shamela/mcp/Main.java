package ws.shamela.mcp;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.lucene.analysis.Analyzer;

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

    /** Lazy holder for ws.shamela.MorphologyAnalyzer (no-arg constructor). */
    private static volatile Analyzer morphologyAnalyzer = null;
    private static synchronized Analyzer morphologyAnalyzer() {
        if (morphologyAnalyzer != null) return morphologyAnalyzer;
        try {
            Class<?> cls = Class.forName("ws.shamela.MorphologyAnalyzer");
            morphologyAnalyzer = (Analyzer) cls.getDeclaredConstructor().newInstance();
            return morphologyAnalyzer;
        } catch (Throwable t) {
            throw new IllegalStateException(
                "MorphologyAnalyzer unavailable: " + t.getClass().getSimpleName() + ": " + t.getMessage(), t);
        }
    }

    private static void rejectPreservation(Map<String, Object> options) {
        if (options == null) return;
        for (String k : List.of("preserve_diacritics", "preserve_hamza", "preserve_digits")) {
            Object v = options.get(k);
            if (v instanceof Boolean b && b) {
                throw new IllegalStateException(
                    "OPTION_NOT_SUPPORTED:" + k + ":Option '" + k + "' is not currently supported.");
            }
        }
    }

    private static void requireNoConflict(Map<String, Object> options) {
        if (options == null) return;
        boolean morph = boolFlag(options, "morphology");
        boolean wild = boolFlag(options, "wildcards");
        if (morph && wild) {
            throw new IllegalStateException(
                "OPTION_CONFLICT::morphology and wildcards cannot be combined.");
        }
    }

    private static boolean boolFlag(Map<String, Object> options, String key) {
        Object v = options == null ? null : options.get(key);
        return v instanceof Boolean ? (Boolean) v : false;
    }

    @SuppressWarnings("unchecked")
    private static List<String> asStringList(Object o) {
        if (!(o instanceof List<?> list)) return null;
        List<String> out = new ArrayList<>(list.size());
        for (Object e : list) if (e != null) out.add(String.valueOf(e));
        return out;
    }

    @SuppressWarnings("unchecked")
    private static List<Integer> asIntList(Object o) {
        if (!(o instanceof List<?> list)) return null;
        List<Integer> out = new ArrayList<>(list.size());
        for (Object e : list) {
            if (e instanceof Number n) out.add(n.intValue());
            else if (e instanceof String s) {
                try { out.add(Integer.parseInt(s.trim())); } catch (NumberFormatException ignore) {}
            }
        }
        return out;
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
                case "search_pages" -> {
                    Map<String, Object> opts = (Map<String, Object>) args.getOrDefault("options", new LinkedHashMap<>());
                    rejectPreservation(opts);
                    requireNoConflict(opts);
                    yield SearchPages.run(
                            indexCache,
                            boolFlag(opts, "morphology") ? morphologyAnalyzer() : null,
                            asString(args.get("query")),
                            asStringList(args.get("scope_book_keys")),
                            asInt(args.get("max_results"), 20),
                            asInt(args.get("offset"), 0),
                            boolFlag(opts, "morphology"),
                            boolFlag(opts, "wildcards"),
                            asStringList(opts.get("search_in")));
                }
                case "search_titles" -> {
                    Map<String, Object> opts = (Map<String, Object>) args.getOrDefault("options", new LinkedHashMap<>());
                    rejectPreservation(opts);
                    requireNoConflict(opts);
                    yield SearchTitles.run(
                            indexCache,
                            boolFlag(opts, "morphology") ? morphologyAnalyzer() : null,
                            asString(args.get("query")),
                            asStringList(args.get("scope_book_keys")),
                            asInt(args.get("max_results"), 20),
                            asInt(args.get("offset"), 0),
                            boolFlag(opts, "morphology"),
                            boolFlag(opts, "wildcards"));
                }
                case "search_books" -> {
                    Map<String, Object> opts = (Map<String, Object>) args.getOrDefault("options", new LinkedHashMap<>());
                    rejectPreservation(opts);
                    requireNoConflict(opts);
                    yield SearchBooks.run(
                            indexCache,
                            boolFlag(opts, "morphology") ? morphologyAnalyzer() : null,
                            asString(args.get("query")),
                            asStringList(args.get("scope_book_keys")),
                            asInt(args.get("max_results"), 20),
                            asInt(args.get("offset"), 0),
                            boolFlag(opts, "morphology"),
                            boolFlag(opts, "wildcards"));
                }
                case "search_authors" -> {
                    Map<String, Object> opts = (Map<String, Object>) args.getOrDefault("options", new LinkedHashMap<>());
                    rejectPreservation(opts);
                    requireNoConflict(opts);
                    yield SearchAuthors.run(
                            indexCache,
                            boolFlag(opts, "morphology") ? morphologyAnalyzer() : null,
                            asString(args.get("query")),
                            asInt(args.get("max_results"), 20),
                            asInt(args.get("offset"), 0),
                            boolFlag(opts, "morphology"),
                            boolFlag(opts, "wildcards"));
                }
                case "search_quran" -> SearchQuran.run(
                        indexCache,
                        asString(args.get("query")),
                        asInt(args.get("max_results"), 20),
                        asInt(args.get("offset"), 0),
                        boolFlag(args.get("options") instanceof Map<?,?> m
                                ? (Map<String,Object>) m : new LinkedHashMap<>(), "wildcards"));
                case "get_aya" -> GetAya.run(indexCache, asInt(args.get("aya_id"), 0));
                case "resolve" -> Resolve.run(
                        indexCache,
                        asString(args.get("query")),
                        asString(args.get("type")),
                        asInt(args.get("limit"), 5));
                case "get_pages_batch" -> GetPagesBatch.run(
                        indexCache,
                        asInt(args.get("book_id"), 0),
                        asIntList(args.get("page_ids")));
                case "get_titles_batch" -> GetTitlesBatch.run(
                        indexCache,
                        asInt(args.get("book_id"), 0),
                        asIntList(args.get("title_ids")));
                default -> throw new IllegalArgumentException("unknown command: " + cmd);
            };
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("id", id);
            resp.put("ok", Boolean.TRUE);
            resp.put("data", data);
            return resp;
        } catch (IllegalStateException e) {
            // Used by rejectPreservation / requireNoConflict to signal mapped error codes.
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.startsWith("OPTION_NOT_SUPPORTED:")) {
                String[] parts = msg.split(":", 3);
                return error(id, "OPTION_NOT_SUPPORTED", parts.length >= 3 ? parts[2] : msg);
            }
            if (msg.startsWith("OPTION_CONFLICT:")) {
                String[] parts = msg.split(":", 3);
                return error(id, "OPTION_CONFLICT", parts.length >= 3 ? parts[2] : msg);
            }
            return error(id, "INTERNAL", msg);
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
