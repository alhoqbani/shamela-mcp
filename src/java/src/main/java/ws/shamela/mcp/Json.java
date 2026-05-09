package ws.shamela.mcp;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tiny hand-rolled JSON encoder/decoder. We avoid pulling in Jackson or Gson
 * to keep the helper jar small (the project ships with Lucene+sqlite-jdbc on
 * the classpath; adding a JSON lib would be the third-largest dependency).
 *
 * Only encodes/decodes the shapes our protocol uses:
 *   - encode: Map, List, String, Number, Boolean, null, nested.
 *   - decode: object/array/string/number/boolean/null with standard JSON
 *     escapes. No exotic Unicode escape edge cases beyond the basic
 *     four-hex-digit form.
 *
 * Throws JsonException on parse failure.
 */
public final class Json {

    private Json() {}

    public static class JsonException extends RuntimeException {
        public JsonException(String msg) { super(msg); }
    }

    // ------------------------------------------------------------------
    // Encoding
    // ------------------------------------------------------------------
    public static String encode(Object value) {
        StringBuilder sb = new StringBuilder();
        writeValue(sb, value);
        return sb.toString();
    }

    private static void writeValue(StringBuilder sb, Object value) {
        if (value == null) { sb.append("null"); return; }
        if (value instanceof String s) { writeString(sb, s); return; }
        if (value instanceof Number n) { sb.append(formatNumber(n)); return; }
        if (value instanceof Boolean b) { sb.append(b ? "true" : "false"); return; }
        if (value instanceof Map<?, ?> m) { writeObject(sb, m); return; }
        if (value instanceof Iterable<?> it) { writeArray(sb, it); return; }
        // Fallback: stringify
        writeString(sb, value.toString());
    }

    private static String formatNumber(Number n) {
        if (n instanceof Double d) {
            if (d.isNaN() || d.isInfinite()) return "null";
            // Avoid trailing ".0" for integer-valued doubles.
            if (d == Math.floor(d) && !Double.isInfinite(d)) return Long.toString(d.longValue());
            return d.toString();
        }
        if (n instanceof Float f) {
            if (f.isNaN() || f.isInfinite()) return "null";
            if (f == Math.floor(f) && !Float.isInfinite(f)) return Long.toString(f.longValue());
            return f.toString();
        }
        return n.toString();
    }

    private static void writeObject(StringBuilder sb, Map<?, ?> m) {
        sb.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> e : m.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            writeString(sb, e.getKey().toString());
            sb.append(':');
            writeValue(sb, e.getValue());
        }
        sb.append('}');
    }

    private static void writeArray(StringBuilder sb, Iterable<?> it) {
        sb.append('[');
        boolean first = true;
        for (Object v : it) {
            if (!first) sb.append(',');
            first = false;
            writeValue(sb, v);
        }
        sb.append(']');
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ------------------------------------------------------------------
    // Decoding
    // ------------------------------------------------------------------
    public static Object decode(String s) {
        Parser p = new Parser(s);
        p.skipWs();
        Object v = p.readValue();
        p.skipWs();
        if (p.pos < p.src.length()) {
            throw new JsonException("trailing characters at offset " + p.pos);
        }
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> decodeObject(String s) {
        Object v = decode(s);
        if (!(v instanceof Map)) throw new JsonException("expected object, got " + (v == null ? "null" : v.getClass().getSimpleName()));
        return (Map<String, Object>) v;
    }

    private static final class Parser {
        final String src;
        int pos;

        Parser(String src) { this.src = src; this.pos = 0; }

        void skipWs() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }

        Object readValue() {
            skipWs();
            if (pos >= src.length()) throw new JsonException("unexpected end of input");
            char c = src.charAt(pos);
            switch (c) {
                case '{': return readObject();
                case '[': return readArray();
                case '"': return readString();
                case 't': case 'f': return readBool();
                case 'n': return readNull();
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return readNumber();
                    throw new JsonException("unexpected char '" + c + "' at " + pos);
            }
        }

        Map<String, Object> readObject() {
            expect('{');
            Map<String, Object> out = new LinkedHashMap<>();
            skipWs();
            if (peek() == '}') { pos++; return out; }
            while (true) {
                skipWs();
                String key = readString();
                skipWs();
                expect(':');
                Object value = readValue();
                out.put(key, value);
                skipWs();
                char c = peek();
                if (c == ',') { pos++; continue; }
                if (c == '}') { pos++; return out; }
                throw new JsonException("expected ',' or '}' at " + pos);
            }
        }

        java.util.List<Object> readArray() {
            expect('[');
            java.util.List<Object> out = new java.util.ArrayList<>();
            skipWs();
            if (peek() == ']') { pos++; return out; }
            while (true) {
                Object v = readValue();
                out.add(v);
                skipWs();
                char c = peek();
                if (c == ',') { pos++; continue; }
                if (c == ']') { pos++; return out; }
                throw new JsonException("expected ',' or ']' at " + pos);
            }
        }

        String readString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (pos >= src.length()) throw new JsonException("dangling escape");
                    char esc = src.charAt(pos++);
                    switch (esc) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            if (pos + 4 > src.length()) throw new JsonException("bad \\u escape");
                            int cp = Integer.parseInt(src.substring(pos, pos + 4), 16);
                            sb.append((char) cp);
                            pos += 4;
                            break;
                        default: throw new JsonException("bad escape \\" + esc);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new JsonException("unterminated string");
        }

        Object readNumber() {
            int start = pos;
            if (peek() == '-') pos++;
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') pos++;
                else break;
            }
            String num = src.substring(start, pos);
            if (num.contains(".") || num.contains("e") || num.contains("E")) {
                return Double.parseDouble(num);
            }
            try {
                long l = Long.parseLong(num);
                if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) return (int) l;
                return l;
            } catch (NumberFormatException e) {
                return Double.parseDouble(num);
            }
        }

        Boolean readBool() {
            if (src.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
            if (src.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
            throw new JsonException("expected true/false at " + pos);
        }

        Object readNull() {
            if (src.startsWith("null", pos)) { pos += 4; return null; }
            throw new JsonException("expected null at " + pos);
        }

        char peek() {
            if (pos >= src.length()) throw new JsonException("unexpected end of input");
            return src.charAt(pos);
        }

        void expect(char c) {
            if (pos >= src.length() || src.charAt(pos) != c) throw new JsonException("expected '" + c + "' at " + pos);
            pos++;
        }
    }

    /** Convenience: build a {"key": value, ...} map preserving insertion order. */
    public static Map<String, Object> obj(Object... kv) {
        if (kv.length % 2 != 0) throw new IllegalArgumentException("kv must have even length");
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put(kv[i].toString(), kv[i + 1]);
        }
        return m;
    }

    /** Convenience: build an immutable List from varargs. */
    public static List<Object> arr(Object... items) {
        return List.of(items);
    }
}
