package codenode.demo;

public final class ConditionalValue {
    private ConditionalValue() {}

    public static String choose(int value, int threshold) {
        return value >= threshold ? "accepted" : "rejected";
    }
}
