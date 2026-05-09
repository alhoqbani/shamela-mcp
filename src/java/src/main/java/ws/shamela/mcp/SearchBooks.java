package ws.shamela.mcp;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.lucene.document.Document;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.TopDocs;

/**
 * shamela_search_books — match Arabic tokens against the pre-built `book`
 * index's `body` field (concatenation of book name + author names +
 * bibliography). Snippets sourced from `body_store` (the bibliography text
 * stored separately). Returns minimal hits; Node fills in display names.
 */
public final class SearchBooks {

    private SearchBooks() {}

    static final String INDEX = "book";

    public static Map<String, Object> run(
            IndexCache indexCache,
            String rawQuery,
            int maxResults
    ) throws IOException {
        List<String> tokens = Normalize.normalizeQuery(rawQuery);
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("query", rawQuery == null ? "" : rawQuery);
        envelope.put("normalized_tokens", tokens);

        if (tokens.isEmpty()) {
            envelope.put("total_hits", 0);
            envelope.put("returned", 0);
            envelope.put("results", List.of());
            return envelope;
        }

        BooleanQuery.Builder b = new BooleanQuery.Builder();
        for (String tok : tokens) {
            b.add(new TermQuery(new Term("body", tok)), BooleanClause.Occur.MUST);
        }
        Query q = b.build();

        IndexSearcher searcher = indexCache.searcher(INDEX);
        StoredFields stored = indexCache.storedFields(INDEX);

        int safeMax = Math.max(1, Math.min(maxResults, 100));
        long total = searcher.count(q);
        TopDocs top = searcher.search(q, safeMax);

        List<Map<String, Object>> results = new ArrayList<>(top.scoreDocs.length);
        for (ScoreDoc sd : top.scoreDocs) {
            Document doc = stored.document(sd.doc);
            String idField = doc.get("id");
            if (idField == null) continue;
            int bookId;
            try {
                bookId = Integer.parseInt(idField.trim());
            } catch (NumberFormatException e) {
                continue;
            }

            String biblio = nullToEmpty(doc.get("body_store"));
            String snippet = !biblio.isEmpty() ? Snippet.make(biblio, tokens) : "";

            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("book_id", bookId);
            hit.put("snippet", snippet);
            results.add(hit);
        }

        envelope.put("total_hits", (int) Math.min(total, Integer.MAX_VALUE));
        envelope.put("returned", results.size());
        envelope.put("results", results);
        return envelope;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
