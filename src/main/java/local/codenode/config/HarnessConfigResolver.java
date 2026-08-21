package local.codenode.config;

import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/** Deterministic native Java profile/bundle/patch resolver. */
public final class HarnessConfigResolver {
    private HarnessConfigResolver() { }

    public static Resolution resolve(Path baseFile) {
        Path base = baseFile == null ? Path.of("config", "agent.properties") : baseFile;
        Properties merged = new Properties();
        List<Path> applied = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        load(base, merged, applied, warnings, true);

        String profile = value(merged, "harness.profile", "default");
        if (!profile.isBlank() && !"default".equalsIgnoreCase(profile)) {
            Path profileFile = base.getParent() == null ? Path.of("harness", "profiles", profile + ".properties")
                    : base.getParent().resolve("harness").resolve("profiles").resolve(profile + ".properties");
            load(profileFile, merged, applied, warnings, false);
        }

        for (String bundle : list(merged.getProperty("harness.bundles", ""))) {
            load(resolvePath(base, bundle), merged, applied, warnings, false);
        }
        for (String patch : list(merged.getProperty("harness.patches", ""))) {
            load(resolvePath(base, patch), merged, applied, warnings, false);
        }
        return new Resolution(merged, applied, warnings);
    }

    private static void load(Path file, Properties target, List<Path> applied,
                             List<String> warnings, boolean required) {
        if (file == null || !Files.isRegularFile(file)) {
            if (required) warnings.add("基础 Agent 配置不存在：" + file);
            else if (file != null) warnings.add("Harness 配置层不存在，已跳过：" + file);
            return;
        }
        try (InputStreamReader reader = new InputStreamReader(Files.newInputStream(file), StandardCharsets.UTF_8)) {
            Properties layer = new Properties();
            layer.load(reader);
            for (String name : layer.stringPropertyNames()) target.setProperty(name, layer.getProperty(name));
            applied.add(file.toAbsolutePath().normalize());
        } catch (IOException failure) {
            warnings.add("Harness 配置层读取失败，已跳过：" + file + "（" + failure.getMessage() + "）");
        }
    }

    private static Path resolvePath(Path base, String value) {
        Path path = Path.of(value.trim());
        return path.isAbsolute() ? path : (base.getParent() == null ? path : base.getParent().resolve(path));
    }

    private static String value(Properties properties, String key, String fallback) {
        String value = properties.getProperty(key, fallback);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static List<String> list(String value) {
        if (value == null || value.isBlank()) return List.of();
        return java.util.Arrays.stream(value.split(","))
                .map(String::trim).filter(item -> !item.isEmpty()).toList();
    }

    public record Resolution(Properties properties, List<Path> appliedFiles, List<String> warnings) {
        public Resolution {
            Properties copy = new Properties();
            if (properties != null) copy.putAll(properties);
            properties = copy;
            appliedFiles = appliedFiles == null ? List.of() : List.copyOf(appliedFiles);
            warnings = warnings == null ? List.of() : List.copyOf(warnings);
        }
    }
}
