package ws.shamela.mcp;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import org.apache.lucene.document.Document;
import org.apache.lucene.index.StoredFields;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.TopDocs;

/** get_aya — fetch the body/amiri/majma renderings for a single aya_id. */
public final class GetAya {

    private GetAya() {}

    public static Map<String, Object> run(IndexCache indexCache, int ayaId) throws IOException {
        IndexSearcher searcher = indexCache.searcher(SearchQuran.INDEX);
        StoredFields stored = indexCache.storedFields(SearchQuran.INDEX);
        TopDocs top = searcher.search(new TermQuery(new Term("id", String.valueOf(ayaId))), 1);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("aya_id", ayaId);
        if (top.scoreDocs.length == 0) {
            out.put("found", false);
            out.put("body", null);
            out.put("amiri", null);
            out.put("majma", null);
            return out;
        }
        Document doc = stored.document(top.scoreDocs[0].doc);
        out.put("found", true);
        out.put("body", doc.get("body"));
        out.put("amiri", doc.get("amiri"));
        out.put("majma", doc.get("majma"));
        return out;
    }
}
