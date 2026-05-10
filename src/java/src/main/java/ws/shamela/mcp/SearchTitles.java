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
 * search_titles — search the title/ Lucene index for chapter and section
 * titles. Title docs have id="<book_id>-<title_id>", body=<title text>, parent.
 */
public final class SearchTitles {

    private SearchTitles() {}

    static final String INDEX = "title";

    public static Map<String, Object> run(
            IndexCache indexCache,
            Analyzer morphologyAnalyzer,
            String rawQuery,
            List<String> scopeBookKeys,
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

        Query q = QueryBuilder.build(tokens, List.of("body"), wildcards, morphology, morphologyAnalyzer, scopeBookKeys);
        IndexSearcher searcher = indexCache.searcher(INDEX);
        StoredFields stored = indexCache.storedFields(INDEX);

        int safeMax = Math.max(1, Math.min(maxResults, 100));
        int safeOffset = Math.max(0, offset);
        long total = searcher.count(q);
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
            int bookId, titleId;
            try {
                bookId = Integer.parseInt(idField.substring(0, dash));
                titleId = Integer.parseInt(idField.substring(dash + 1));
            } catch (NumberFormatException e) {
                continue;
            }
            // book_key is indexed but not stored — derive it from id.
            coverage.recordBookKey(idField.substring(0, dash));

            if (seen++ < safeOffset) continue;
            if (results.size() >= safeMax) continue;

            String titleText = nullToEmpty(doc.get("body"));
            String parent = doc.get("parent");

            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("book_id", bookId);
            hit.put("title_id", titleId);
            hit.put("title_text", titleText);
            if (parent != null && !parent.isEmpty()) {
                try { hit.put("parent_id", Integer.parseInt(parent)); }
                catch (NumberFormatException ignore) {}
            }
            results.add(hit);
        }

        Map<String, Object> coverageMap = new LinkedHashMap<>();
        coverageMap.put("by_book_key", coverage.snapshot());
        coverageMap.put("total_seen", coverage.total());

        envelope.put("total_hits", (int) Math.min(total, Integer.MAX_VALUE));
        envelope.put("returned", results.size());
        envelope.put("has_more", (long) (safeOffset + results.size()) < total);
        if ((long) (safeOffset + results.size()) < total) {
            envelope.put("next_offset", safeOffset + results.size());
        }
        envelope.put("coverage", coverageMap);
        envelope.put("results", results);
        return envelope;
    }

    private static String nullToEmpty(String s) { return s == null ? "" : s; }
}
