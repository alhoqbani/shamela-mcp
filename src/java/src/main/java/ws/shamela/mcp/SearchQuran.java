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
import org.apache.lucene.search.WildcardQuery;

/**
 * search_quran — query the pre-built aya/ Lucene index.
 * Aya docs (per docs/architecture.md): id=<aya_id>, body=<emlaa text>,
 * amiri=<Othmani Amiri>, majma=<KFQPC>. We search the `body` (emlaa) field
 * by default since that's the user-typed orthography.
 */
public final class SearchQuran {

    private SearchQuran() {}

    static final String INDEX = "aya";

    public static Map<String, Object> run(
            IndexCache indexCache,
            String rawQuery,
            int maxResults,
            int offset,
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

        BooleanQuery.Builder b = new BooleanQuery.Builder();
        for (String tok : tokens) {
            Query sub;
            if (wildcards && (tok.indexOf('*') >= 0 || tok.indexOf('?') >= 0)) {
                sub = new WildcardQuery(new Term("body", tok));
            } else {
                sub = new TermQuery(new Term("body", tok));
            }
            b.add(sub, BooleanClause.Occur.MUST);
        }
        Query q = b.build();

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
            int ayaId;
            try { ayaId = Integer.parseInt(idField.trim()); }
            catch (NumberFormatException e) { continue; }
            String body = nullToEmpty(doc.get("body"));
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("aya_id", ayaId);
            hit.put("body", body);
            hit.put("snippet_body", body.isEmpty() ? "" : Snippet.make(body, tokens));
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
