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

/** search_authors — author bio search with options. No scope (authors aren't scoped). */
public final class SearchAuthors {

    private SearchAuthors() {}

    static final String INDEX = "author";

    public static Map<String, Object> run(
            IndexCache indexCache,
            Analyzer morphologyAnalyzer,
            String rawQuery,
            int maxResults,
            int offset,
            boolean morphology,
            boolean wildcards
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
            envelope.put("results", List.of());
            return envelope;
        }

        Query q = QueryBuilder.build(tokens, List.of("body"), wildcards, morphology, morphologyAnalyzer, null);
        IndexSearcher searcher = indexCache.searcher(INDEX);
        StoredFields stored = indexCache.storedFields(INDEX);

        int safeMax = Math.max(1, Math.min(maxResults, 100));
        int safeOffset = Math.max(0, offset);
        long total = searcher.count(q);
        int fetch = Math.min(safeOffset + safeMax, 5_000);
        TopDocs top = searcher.search(q, fetch);

        List<Map<String, Object>> results = new ArrayList<>();
        int seen = 0;
        for (ScoreDoc sd : top.scoreDocs) {
            if (seen++ < safeOffset) continue;
            if (results.size() >= safeMax) continue;
            Document doc = stored.document(sd.doc);
            String idField = doc.get("id");
            if (idField == null) continue;
            int authorId;
            try { authorId = Integer.parseInt(idField.trim()); }
            catch (NumberFormatException e) { continue; }

            String bio = nullToEmpty(doc.get("body_store"));
            String snippet = !bio.isEmpty() ? Snippet.make(bio, tokens) : "";

            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("author_id", authorId);
            hit.put("snippet", snippet);
            results.add(hit);
        }

        envelope.put("total_hits", (int) Math.min(total, Integer.MAX_VALUE));
        envelope.put("returned", results.size());
        envelope.put("has_more", (long) (safeOffset + results.size()) < total);
        if ((long) (safeOffset + results.size()) < total) {
            envelope.put("next_offset", safeOffset + results.size());
        }
        envelope.put("results", results);
        return envelope;
    }

    private static String nullToEmpty(String s) { return s == null ? "" : s; }
}
