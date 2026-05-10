package ws.shamela.mcp;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.document.Document;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TopDocs;

/**
 * search_pages — page body/foot/comment search with scope filtering, options
 * (morphology, wildcards, search_in), pagination, and coverage aggregation.
 * See docs/architecture.md and docs/ipc-protocol.md.
 */
public final class SearchPages {

    private SearchPages() {}

    static final String INDEX = "page";

    public static Map<String, Object> run(
            IndexCache indexCache,
            Analyzer morphologyAnalyzer,
            String rawQuery,
            List<String> scopeBookKeys,
            int maxResults,
            int offset,
            boolean morphology,
            boolean wildcards,
            List<String> searchIn
    ) throws IOException {
        List<String> tokens = Normalize.normalizeQuery(rawQuery);
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("query", rawQuery == null ? "" : rawQuery);
        envelope.put("normalized_tokens", tokens);
        envelope.put("offset", offset);

        if (tokens.isEmpty()) {
            envelope.put("total_hits", 0);
            envelope.put("returned", 0);
            envelope.put("has_more", false);
            envelope.put("scope_count", scopeBookKeys == null ? -1 : scopeBookKeys.size());
            envelope.put("coverage", emptyCoverage());
            envelope.put("results", List.of());
            return envelope;
        }

        // Query target fields based on search_in.
        List<String> fields = effectiveFields(searchIn);

        Query q = QueryBuilder.build(tokens, fields, wildcards, morphology, morphologyAnalyzer, scopeBookKeys);
        IndexSearcher searcher = indexCache.searcher(INDEX);
        StoredFields stored = indexCache.storedFields(INDEX);

        int safeMax = Math.max(1, Math.min(maxResults, 100));
        int safeOffset = Math.max(0, offset);
        long total = searcher.count(q);
        // Fetch enough hits to skip `offset`. Lucene's searchAfter is more efficient
        // for deep pagination but we rely on a single search with limit =
        // offset + safeMax, capped at COVERAGE_CAP so we don't OOM on huge totals.
        int fetch = Math.min(safeOffset + safeMax, 5_000);
        TopDocs top = searcher.search(q, fetch);

        Coverage coverage = new Coverage();
        List<Map<String, Object>> results = new ArrayList<>();
        int seen = 0;
        for (ScoreDoc sd : top.scoreDocs) {
            Document doc = stored.document(sd.doc);
            String idField = doc.get("id");
            if (idField == null) continue;
            int dash = idField.indexOf('-');
            if (dash < 0) continue;
            int bookId, pageId;
            try {
                bookId = Integer.parseInt(idField.substring(0, dash));
                pageId = Integer.parseInt(idField.substring(dash + 1));
            } catch (NumberFormatException e) {
                continue;
            }
            // Derive bookKey from id since book_key is indexed (for scope filtering)
            // but not stored. Streams through every hit, capped at COVERAGE_CAP inside.
            coverage.recordBookKey(idField.substring(0, dash));

            if (seen++ < safeOffset) continue;
            if (results.size() >= safeMax) continue;

            String body = fields.contains("body") ? nullToEmpty(doc.get("body")) : "";
            String foot = fields.contains("foot") ? nullToEmpty(doc.get("foot")) : "";
            String comment = fields.contains("comment") ? nullToEmpty(doc.get("comment")) : "";

            List<String> matchedIn = new ArrayList<>(3);
            String snippetBody = "";
            String snippetFoot = "";
            String snippetComment = "";
            if (!body.isEmpty() && containsAny(body, tokens)) {
                matchedIn.add("body");
                snippetBody = Snippet.make(body, tokens);
            }
            if (!foot.isEmpty() && containsAny(foot, tokens)) {
                matchedIn.add("foot");
                snippetFoot = Snippet.make(foot, tokens);
            }
            if (!comment.isEmpty() && containsAny(comment, tokens)) {
                matchedIn.add("comment");
                snippetComment = Snippet.make(comment, tokens);
            }

            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("book_id", bookId);
            hit.put("page_id", pageId);
            hit.put("matched_in", matchedIn);
            hit.put("snippet_body", snippetBody);
            hit.put("snippet_foot", snippetFoot);
            hit.put("snippet_comment", snippetComment);
            results.add(hit);
        }

        Map<String, Object> coverageMap = new LinkedHashMap<>();
        coverageMap.put("by_book_key", coverage.snapshot());
        coverageMap.put("total_seen", coverage.total());
        coverageMap.put("at_cap", coverage.atCap());

        envelope.put("total_hits", (int) Math.min(total, Integer.MAX_VALUE));
        envelope.put("returned", results.size());
        envelope.put("has_more", (long) (safeOffset + results.size()) < total);
        if ((long) (safeOffset + results.size()) < total) {
            envelope.put("next_offset", safeOffset + results.size());
        }
        envelope.put("scope_count", scopeBookKeys == null ? -1 : scopeBookKeys.size());
        envelope.put("coverage", coverageMap);
        envelope.put("results", results);
        return envelope;
    }

    private static List<String> effectiveFields(List<String> searchIn) {
        if (searchIn == null || searchIn.isEmpty()) return List.of("body", "foot");
        List<String> out = new ArrayList<>();
        for (String f : searchIn) {
            if ("body".equals(f) || "foot".equals(f) || "comment".equals(f)) {
                if (!out.contains(f)) out.add(f);
            }
        }
        if (out.isEmpty()) return List.of("body", "foot");
        return out;
    }

    private static boolean containsAny(String text, List<String> normalizedTokens) {
        if (text == null || text.isEmpty()) return false;
        String norm = Normalize.normalizeHaystack(text).normalized();
        for (String tok : normalizedTokens) {
            if (tok == null || tok.isEmpty()) continue;
            String stripped = tok.replace("*", "").replace("?", "");
            if (stripped.isEmpty()) continue;
            if (norm.contains(stripped)) return true;
        }
        return false;
    }

    private static String nullToEmpty(String s) { return s == null ? "" : s; }

    private static Map<String, Object> emptyCoverage() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("by_book_key", new LinkedHashMap<>());
        m.put("total_seen", 0);
        m.put("at_cap", false);
        return m;
    }
}
