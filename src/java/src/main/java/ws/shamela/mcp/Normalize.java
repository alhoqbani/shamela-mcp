package ws.shamela.mcp;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Cheap Arabic query normalization, mirror of the Python prototype's normalize.py.
 *
 * Default-toggles equivalence with Shamela's own analyzer: diacritics removed,
 * alef variants merged, ya/waw/ta-marbuta merged, Persian letters mapped to
 * Arabic. The on-disk index already encodes these forms, so a TermQuery on a
 * normalized token reproduces UI hit counts for queries that don't enable any
 * of the four toggles.
 */
public final class Normalize {

    private Normalize() {}

    /** The eight tashkeel marks plus the two extra (alef-superscript, kashida). */
    private static final String DIACRITICS = "ًٌٍَُِّْٰـ";

    /** Maximum number of tokens we accept from a query (Shamela's default panel size). */
    public static final int MAX_TOKENS = 5;

    /** Normalize a single token. Returns the normalized form (may be empty). */
    public static String normalizeToken(String token) {
        if (token == null || token.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(token.length());
        for (int i = 0; i < token.length(); i++) {
            char c = token.charAt(i);
            if (DIACRITICS.indexOf(c) >= 0) continue;
            switch (c) {
                case 'ٱ': // ٱ
                case 'آ': // آ
                case 'أ': // أ
                case 'إ': // إ
                    sb.append('ا');
                    break;
                case 'ى': // ى
                    sb.append('ي');
                    break;
                case 'ؤ': // ؤ
                    sb.append('و');
                    break;
                case 'ة': // ة
                    sb.append('ه');
                    break;
                case 'گ': // گ
                    sb.append('ك');
                    break;
                case 'پ': // پ
                    sb.append('ب');
                    break;
                case 'چ': // چ
                    sb.append('ج');
                    break;
                default:
                    sb.append(c);
                    break;
            }
        }
        String result = sb.toString().trim();
        // Synonym applied by Shamela's CustomAnalyzer when hamza is off:
        // a whole token of "ابن" becomes "بن". After our alef fold above,
        // {ٱ,آ,أ,إ}بن all already collapse to "ابن", so the rule reduces to a
        // single equality check.
        if ("ابن".equals(result)) return "بن";
        return result;
    }

    /** Split, normalize, and drop empty tokens. Caps at MAX_TOKENS. */
    public static List<String> normalizeQuery(String query) {
        if (query == null) return List.of();
        String trimmed = query.trim();
        if (trimmed.isEmpty()) return List.of();
        String[] raw = trimmed.split("\\s+");
        List<String> input = new ArrayList<>(Arrays.asList(raw));
        if (input.size() > MAX_TOKENS) {
            // Join overflow into the last accepted token so users still get a sensible result.
            List<String> head = new ArrayList<>(input.subList(0, MAX_TOKENS - 1));
            String tail = String.join(" ", input.subList(MAX_TOKENS - 1, input.size()));
            head.add(tail);
            input = head;
        }
        List<String> out = new ArrayList<>(input.size());
        for (String tok : input) {
            String norm = normalizeToken(tok);
            if (!norm.isEmpty()) out.add(norm);
        }
        return out;
    }

    /**
     * Normalize text into a parallel form, returning both the normalized chars
     * and an index map back to the original positions. Used by snippet
     * generation: find a match in the normalized version, then map indices
     * back to the original to slice the user-visible snippet.
     *
     * mapping[i] is the index in `text` corresponding to the i-th character of
     * the normalized output. mapping[normalized.length()] = text.length() so
     * `text.substring(mapping[start], mapping[end])` is safe.
     */
    public static record NormalizedHaystack(String normalized, int[] indexMap) {}

    public static NormalizedHaystack normalizeHaystack(String text) {
        if (text == null) return new NormalizedHaystack("", new int[] { 0 });
        StringBuilder out = new StringBuilder(text.length());
        int[] tmp = new int[text.length() + 1];
        int n = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (DIACRITICS.indexOf(c) >= 0) continue;
            char repl;
            switch (c) {
                case 'ٱ':
                case 'آ':
                case 'أ':
                case 'إ':
                    repl = 'ا';
                    break;
                case 'ى':
                    repl = 'ي';
                    break;
                case 'ؤ':
                    repl = 'و';
                    break;
                case 'ة':
                    repl = 'ه';
                    break;
                case 'گ':
                    repl = 'ك';
                    break;
                case 'پ':
                    repl = 'ب';
                    break;
                case 'چ':
                    repl = 'ج';
                    break;
                default:
                    repl = c;
            }
            out.append(repl);
            tmp[n++] = i;
        }
        tmp[n] = text.length();
        int[] indexMap = Arrays.copyOf(tmp, n + 1);
        return new NormalizedHaystack(out.toString(), indexMap);
    }
}
