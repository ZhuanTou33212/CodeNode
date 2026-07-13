package codenode.demo;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class JsonNumberTransform {
    private static final Pattern VALUE = Pattern.compile("\\\"value\\\"\\s*:\\s*(-?\\d+)");

    private JsonNumberTransform() {}

    public static String doubleValue(String json) {
        Matcher matcher = VALUE.matcher(json);
        if (!matcher.find()) throw new IllegalArgumentException("JSON must contain an integer value field");
        long value = Long.parseLong(matcher.group(1));
        return "{\"value\":" + (value * 2) + "}";
    }
}
