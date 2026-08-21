package local.codenode.agent.cordis;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Stable compatibility contract published by every Cordis plugin. */
public record CordisPluginManifest(String id, String version, Set<String> dependencies,
                                   Set<String> requiredServices, Set<String> providedServices,
                                   String minRuntimeVersion, String maxRuntimeVersion,
                                   String contractVersion) {
    public CordisPluginManifest {
        id = requireText(id, "id");
        version = normalizeVersion(version);
        dependencies = normalizeSet(dependencies);
        requiredServices = normalizeSet(requiredServices);
        providedServices = normalizeSet(providedServices);
        minRuntimeVersion = normalizeOptionalVersion(minRuntimeVersion);
        maxRuntimeVersion = normalizeOptionalVersion(maxRuntimeVersion);
        contractVersion = Objects.requireNonNull(contractVersion, "contractVersion").trim();
        if (contractVersion.isBlank()) throw new IllegalArgumentException("contractVersion is blank");
    }

    public CordisPluginManifest(String id, String version, Set<String> dependencies,
                                Set<String> requiredServices, Set<String> providedServices,
                                String minRuntimeVersion, String maxRuntimeVersion) {
        this(id, version, dependencies, requiredServices, providedServices,
                minRuntimeVersion, maxRuntimeVersion, CordisContracts.VERSION);
    }

    public static CordisPluginManifest forPlugin(CordisPlugin plugin) {
        return new CordisPluginManifest(plugin.id(), "0.1.0", plugin.dependencies(),
                plugin.requiredServices(), Set.of(), "", "", CordisContracts.VERSION);
    }

    public boolean compatibleWith(String runtimeVersion) {
        String actual = normalizeVersion(runtimeVersion);
        return (minRuntimeVersion.isBlank() || compare(actual, minRuntimeVersion) >= 0)
                && (maxRuntimeVersion.isBlank() || compare(actual, maxRuntimeVersion) <= 0);
    }

    public Map<String, Object> toMap() {
        LinkedHashMap<String, Object> value = new LinkedHashMap<>();
        value.put("id", id);
        value.put("version", version);
        value.put("dependencies", List.copyOf(dependencies));
        value.put("requiredServices", List.copyOf(requiredServices));
        value.put("providedServices", List.copyOf(providedServices));
        value.put("minRuntimeVersion", minRuntimeVersion);
        value.put("maxRuntimeVersion", maxRuntimeVersion);
        value.put("contractVersion", contractVersion);
        return value;
    }

    private static String requireText(String value, String name) {
        String normalized = Objects.requireNonNull(value, name).trim();
        if (normalized.isEmpty()) throw new IllegalArgumentException(name + " is blank");
        return normalized;
    }

    private static String normalizeVersion(String value) {
        String normalized = value == null || value.isBlank() ? "0.1.0" : value.trim();
        if (!normalized.matches("\\d+(\\.\\d+){0,2}")) {
            throw new IllegalArgumentException("invalid version: " + value);
        }
        return normalized;
    }

    private static String normalizeOptionalVersion(String value) {
        return value == null || value.isBlank() ? "" : normalizeVersion(value);
    }

    private static Set<String> normalizeSet(Set<String> values) {
        LinkedHashSet<String> normalized = new LinkedHashSet<>();
        if (values != null) for (String value : values) if (value != null && !value.isBlank()) normalized.add(value.trim());
        return Set.copyOf(normalized);
    }

    private static int compare(String left, String right) {
        int[] a = parts(left); int[] b = parts(right);
        for (int i = 0; i < 3; i++) if (a[i] != b[i]) return Integer.compare(a[i], b[i]);
        return 0;
    }

    private static int[] parts(String value) {
        int[] result = new int[3];
        String[] tokens = value.split("\\.");
        for (int i = 0; i < tokens.length && i < 3; i++) result[i] = Integer.parseInt(tokens[i]);
        return result;
    }
}
