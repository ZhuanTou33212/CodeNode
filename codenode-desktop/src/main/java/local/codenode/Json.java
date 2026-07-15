package local.codenode;

import java.util.*;

/** Small dependency-free JSON codec for the local queue protocol. */
public final class Json {
    private Json() {}

    public static String stringify(Object value) {
        StringBuilder out = new StringBuilder();
        write(value, out, 0);
        return out.append('\n').toString();
    }

    private static void write(Object value, StringBuilder out, int depth) {
        if (value == null) { out.append("null"); return; }
        if (value instanceof String s) { quote(s, out); return; }
        if (value instanceof Number || value instanceof Boolean) { out.append(value); return; }
        if (value instanceof Map<?, ?> map) {
            out.append("{\n"); int i = 0;
            for (var entry : map.entrySet()) {
                if (i++ > 0) out.append(",\n");
                indent(out, depth + 1); quote(String.valueOf(entry.getKey()), out); out.append(": "); write(entry.getValue(), out, depth + 1);
            }
            out.append('\n'); indent(out, depth); out.append('}'); return;
        }
        if (value instanceof Collection<?> values) {
            out.append('['); int i = 0;
            for (Object item : values) { if (i++ > 0) out.append(", "); write(item, out, depth); }
            out.append(']'); return;
        }
        throw new IllegalArgumentException("Unsupported JSON value: " + value.getClass());
    }

    private static void quote(String s, StringBuilder out) {
        out.append('"');
        for (char c : s.toCharArray()) switch (c) {
            case '"' -> out.append("\\\""); case '\\' -> out.append("\\\\"); case '\b' -> out.append("\\b");
            case '\f' -> out.append("\\f"); case '\n' -> out.append("\\n"); case '\r' -> out.append("\\r"); case '\t' -> out.append("\\t");
            default -> { if (c < 0x20) out.append(String.format("\\u%04x", (int)c)); else out.append(c); }
        }
        out.append('"');
    }
    private static void indent(StringBuilder out, int depth) { out.append("  ".repeat(depth)); }

    public static Object parse(String json) { return new Parser(json).parse(); }
    @SuppressWarnings("unchecked") public static Map<String,Object> object(String json) { return (Map<String,Object>) parse(json); }

    private static final class Parser {
        private final String s; private int i;
        Parser(String s) { this.s = s; }
        Object parse() { Object v = value(); ws(); if (i != s.length()) fail("Trailing data"); return v; }
        Object value() {
            ws(); if (i >= s.length()) fail("Unexpected end"); char c = s.charAt(i);
            if (c == '{') return object(); if (c == '[') return array(); if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return true; } if (s.startsWith("false", i)) { i += 5; return false; }
            if (s.startsWith("null", i)) { i += 4; return null; } return number();
        }
        Map<String,Object> object() {
            i++; Map<String,Object> map = new LinkedHashMap<>(); ws(); if (take('}')) return map;
            do { ws(); String key = string(); ws(); need(':'); map.put(key, value()); ws(); } while (take(',')); need('}'); return map;
        }
        List<Object> array() { i++; List<Object> list = new ArrayList<>(); ws(); if (take(']')) return list; do { list.add(value()); ws(); } while (take(',')); need(']'); return list; }
        String string() {
            need('"'); StringBuilder out = new StringBuilder();
            while (i < s.length()) { char c = s.charAt(i++); if (c == '"') return out.toString(); if (c != '\\') { out.append(c); continue; }
                if (i >= s.length()) fail("Bad escape"); char e = s.charAt(i++); switch (e) {
                    case '"','\\','/' -> out.append(e); case 'b' -> out.append('\b'); case 'f' -> out.append('\f'); case 'n' -> out.append('\n'); case 'r' -> out.append('\r'); case 't' -> out.append('\t');
                    case 'u' -> { if (i + 4 > s.length()) fail("Bad unicode"); out.append((char)Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    default -> fail("Bad escape"); }
            } fail("Unclosed string"); return "";
        }
        Number number() { int start = i; while (i < s.length() && "-+0123456789.eE".indexOf(s.charAt(i)) >= 0) i++; String n = s.substring(start, i); try { if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.valueOf(n); return Long.valueOf(n); } catch (Exception e) { fail("Bad number"); return 0; } }
        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        boolean take(char c) { if (i < s.length() && s.charAt(i) == c) { i++; return true; } return false; }
        void need(char c) { if (!take(c)) fail("Expected " + c); }
        void fail(String message) { throw new IllegalArgumentException(message + " at " + i); }
    }
}
