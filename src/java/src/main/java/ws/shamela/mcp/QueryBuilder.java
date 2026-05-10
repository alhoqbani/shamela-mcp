package ws.shamela.mcp;

import java.io.IOException;
import java.util.List;

import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.ConstantScoreQuery;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.TermInSetQuery;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.WildcardQuery;
import org.apache.lucene.queryparser.classic.ParseException;
import org.apache.lucene.queryparser.classic.QueryParser;
import org.apache.lucene.util.BytesRef;

/**
 * Shared query construction for all search commands. Implements the
 * locked behavior in `docs/toggles-implementation.md` §5: per-token MUST,
 * SHOULD over fields, optional WildcardQuery for tokens with `*`/`?`,
 * morphology field swap with QueryParser+Analyzer.stem(). Scope filtering
 * via TermInSetQuery on book_key, AND'd into the outer query.
 */
public final class QueryBuilder {

    private QueryBuilder() {}

    /**
     * Build a compound search query.
     *
     * @param tokens         normalized query tokens (already through Normalize.normalizeQuery)
     * @param fields         the indexed field names to search SHOULD across
     * @param wildcards      true if `*`/`?` should be interpreted via WildcardQuery
     * @param morphology     true if tokens should be parsed with the morphology Analyzer
     * @param morphologyAnalyzer used only when morphology=true
     * @param scopeBookKeys  if non-null and non-empty, AND the query with TermInSetQuery on book_key
     * @return the compound Query, or null if tokens is empty
     */
    public static Query build(
            List<String> tokens,
            List<String> fields,
            boolean wildcards,
            boolean morphology,
            Analyzer morphologyAnalyzer,
            List<String> scopeBookKeys
    ) throws IOException {
        if (tokens.isEmpty()) return null;

        BooleanQuery.Builder outer = new BooleanQuery.Builder();
        for (String tok : tokens) {
            BooleanQuery.Builder inner = new BooleanQuery.Builder();
            inner.setMinimumNumberShouldMatch(1);
            for (String field : fields) {
                Query sub;
                if (morphology) {
                    String fieldName = field;
                    if (!fieldName.startsWith("m_")) fieldName = "m_" + fieldName;
                    sub = parseMorphology(fieldName, tok, morphologyAnalyzer);
                } else if (wildcards && (tok.indexOf('*') >= 0 || tok.indexOf('?') >= 0)) {
                    sub = new WildcardQuery(new Term(field, tok));
                } else {
                    sub = new TermQuery(new Term(field, tok));
                }
                if (sub != null) inner.add(sub, BooleanClause.Occur.SHOULD);
            }
            outer.add(inner.build(), BooleanClause.Occur.MUST);
        }

        Query main = outer.build();
        if (scopeBookKeys != null && !scopeBookKeys.isEmpty()) {
            BooleanQuery.Builder withScope = new BooleanQuery.Builder();
            withScope.add(main, BooleanClause.Occur.MUST);
            withScope.add(buildScopeQuery(scopeBookKeys), BooleanClause.Occur.MUST);
            main = withScope.build();
        }
        return new ConstantScoreQuery(main);
    }

    private static Query parseMorphology(String field, String tok, Analyzer analyzer) {
        // Per docs/toggles-implementation.md §1: stemmed_query = QueryParser(field, stemAnalyzer).parse('"<tok>"').
        try {
            QueryParser parser = new QueryParser(field, analyzer);
            return parser.parse("\"" + tok.replace("\"", "") + "\"");
        } catch (ParseException e) {
            return new TermQuery(new Term(field, tok));
        }
    }

    private static Query buildScopeQuery(List<String> bookKeys) {
        if (bookKeys.size() == 1) {
            return new TermQuery(new Term("book_key", bookKeys.get(0)));
        }
        java.util.List<BytesRef> refs = new java.util.ArrayList<>(bookKeys.size());
        for (String k : bookKeys) refs.add(new BytesRef(k));
        return new TermInSetQuery("book_key", refs);
    }
}
