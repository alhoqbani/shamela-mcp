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
 * resolve — combined autocomplete against s_book/ and s_author/ indexes.
 * Per spec §1.5/§1.6 the s_book/s_author indexes are pre-built n-gram indexes
 * shipped with every Shamela install. They use field "single" for s_book and
 * "author" for s_author (per the Importer code in engine.py).
 */
public final class Resolve {

    private Resolve() {}

    public static Map<String, Object> run(
            IndexCache indexCache,
            String rawQuery,
            String type,
            int limit
    ) throws IOException {
        List<String> tokens = Normalize.normalizeQuery(rawQuery);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("query", rawQuery == null ? "" : rawQuery);
        out.put("normalized_tokens", tokens);
        out.put("books", List.of());
        out.put("authors", List.of());
        if (tokens.isEmpty()) return out;

        int safe = Math.max(1, Math.min(limit, 20));
        boolean wantBooks = type == null || "any".equals(type) || "book".equals(type);
        boolean wantAuthors = type == null || "any".equals(type) || "author".equals(type);

        if (wantBooks) {
            out.put("books", lookup(indexCache, "s_book", "single", tokens, safe));
        }
        if (wantAuthors) {
            out.put("authors", lookup(indexCache, "s_author", "author", tokens, safe));
        }
        return out;
    }

    private static List<Map<String, Object>> lookup(
            IndexCache indexCache, String indexName, String field, List<String> tokens, int limit
    ) throws IOException {
        BooleanQuery.Builder b = new BooleanQuery.Builder();
        for (String tok : tokens) {
            b.add(new TermQuery(new Term(field, tok)), BooleanClause.Occur.MUST);
        }
        Query q = b.build();
        IndexSearcher searcher = indexCache.searcher(indexName);
        StoredFields stored = indexCache.storedFields(indexName);
        TopDocs top = searcher.search(q, limit);
        List<Map<String, Object>> out = new ArrayList<>();
        for (ScoreDoc sd : top.scoreDocs) {
            Document doc = stored.document(sd.doc);
            String id = doc.get("id");
            if (id == null) continue;
            int parsed;
            try { parsed = Integer.parseInt(id.trim()); }
            catch (NumberFormatException e) { continue; }
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("id", parsed);
            hit.put("score", sd.score);
            out.add(hit);
        }
        return out;
    }
}
