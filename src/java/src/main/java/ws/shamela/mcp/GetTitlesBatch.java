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
 * get_titles_batch — fetch stored title text for a list of (book_id,
 * title_id) pairs. Title docs use id="<book_id>-<title_id>", body=<text>.
 */
public final class GetTitlesBatch {

    private GetTitlesBatch() {}

    public static Map<String, Object> run(
            IndexCache indexCache,
            int bookId,
            List<Integer> titleIds
    ) throws IOException {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("book_id", bookId);
        if (titleIds == null || titleIds.isEmpty()) {
            envelope.put("results", List.of());
            return envelope;
        }
        List<String> ids = new ArrayList<>(titleIds.size());
        for (Integer tid : titleIds) ids.add(bookId + "-" + tid);

        Query q;
        if (ids.size() == 1) {
            q = new TermQuery(new Term("id", ids.get(0)));
        } else {
            List<BytesRef> refs = new ArrayList<>(ids.size());
            for (String id : ids) refs.add(new BytesRef(id));
            q = new TermInSetQuery("id", refs);
        }

        IndexSearcher searcher = indexCache.searcher(SearchTitles.INDEX);
        StoredFields stored = indexCache.storedFields(SearchTitles.INDEX);
        TopDocs top = searcher.search(q, Math.max(1, ids.size()));

        Map<String, String> byKey = new HashMap<>();
        for (ScoreDoc sd : top.scoreDocs) {
            Document doc = stored.document(sd.doc);
            String idField = doc.get("id");
            if (idField == null) continue;
            byKey.put(idField, doc.get("body") == null ? "" : doc.get("body"));
        }

        List<Map<String, Object>> results = new ArrayList<>(titleIds.size());
        for (Integer tid : titleIds) {
            String key = bookId + "-" + tid;
            String text = byKey.get(key);
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("title_id", tid);
            hit.put("title_text", text == null ? "" : text);
            results.add(hit);
        }
        envelope.put("results", results);
        return envelope;
    }
}
