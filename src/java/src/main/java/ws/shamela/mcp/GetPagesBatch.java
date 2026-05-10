package ws.shamela.mcp;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.lucene.document.Document;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TermInSetQuery;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.TopDocs;
import org.apache.lucene.util.BytesRef;

/**
 * get_pages_batch — fetch stored body/foot/comment for multiple page docs
 * in one query, identified by `<book_id>-<page_id>` keys on the `id` field.
 */
public final class GetPagesBatch {

    private GetPagesBatch() {}

    public static Map<String, Object> run(
            IndexCache indexCache,
            int bookId,
            List<Integer> pageIds
    ) throws IOException {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("book_id", bookId);
        if (pageIds == null || pageIds.isEmpty()) {
            envelope.put("results", List.of());
            return envelope;
        }
        List<String> ids = new ArrayList<>(pageIds.size());
        for (Integer pid : pageIds) ids.add(bookId + "-" + pid);

        Query q;
        if (ids.size() == 1) {
            q = new TermQuery(new Term("id", ids.get(0)));
        } else {
            List<BytesRef> refs = new ArrayList<>(ids.size());
            for (String id : ids) refs.add(new BytesRef(id));
            q = new TermInSetQuery("id", refs);
        }

        IndexSearcher searcher = indexCache.searcher(SearchPages.INDEX);
        StoredFields stored = indexCache.storedFields(SearchPages.INDEX);
        TopDocs top = searcher.search(q, Math.max(1, ids.size()));

        Map<String, Map<String, String>> byKey = new HashMap<>();
        for (ScoreDoc sd : top.scoreDocs) {
            Document doc = stored.document(sd.doc);
            String idField = doc.get("id");
            if (idField == null) continue;
            Map<String, String> rec = new LinkedHashMap<>();
            rec.put("body", nullToEmpty(doc.get("body")));
            rec.put("foot", nullToEmpty(doc.get("foot")));
            rec.put("comment", nullToEmpty(doc.get("comment")));
            byKey.put(idField, rec);
        }

        List<Map<String, Object>> results = new ArrayList<>(pageIds.size());
        for (Integer pid : pageIds) {
            String key = bookId + "-" + pid;
            Map<String, String> rec = byKey.get(key);
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("page_id", pid);
            if (rec == null) {
                hit.put("found", false);
                hit.put("body", "");
                hit.put("foot", "");
                hit.put("comment", "");
            } else {
                hit.put("found", true);
                hit.put("body", rec.get("body"));
                hit.put("foot", rec.get("foot"));
                hit.put("comment", rec.get("comment"));
            }
            results.add(hit);
        }

        envelope.put("results", results);
        return envelope;
    }

    private static String nullToEmpty(String s) { return s == null ? "" : s; }
}
