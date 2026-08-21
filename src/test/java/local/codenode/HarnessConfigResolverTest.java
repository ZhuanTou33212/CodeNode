package local.codenode;

import local.codenode.config.HarnessConfigResolver;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HarnessConfigResolverTest {
    @Test
    void layersApplyInDeterministicProfileBundlePatchOrder(@TempDir Path root) throws Exception {
        Path configDir = root.resolve("config");
        Path base = configDir.resolve("agent.properties");
        Path profiles = configDir.resolve("harness/profiles");
        Files.createDirectories(profiles);
        Files.writeString(base, "harness.profile=desktop\nvalue=base\n", StandardCharsets.UTF_8);
        Files.writeString(profiles.resolve("desktop.properties"), "value=profile\nprofile.only=yes\n", StandardCharsets.UTF_8);
        Files.writeString(configDir.resolve("bundle.properties"), "value=bundle\nbundle.only=yes\n", StandardCharsets.UTF_8);
        Files.writeString(configDir.resolve("patch.properties"), "value=patch\npatch.only=yes\n", StandardCharsets.UTF_8);

        // Add layer declarations after the base file exists.
        Files.writeString(base, "harness.profile=desktop\nharness.bundles=bundle.properties\nharness.patches=patch.properties\nvalue=base\n", StandardCharsets.UTF_8);
        HarnessConfigResolver.Resolution resolution = HarnessConfigResolver.resolve(base);

        assertEquals("patch", resolution.properties().getProperty("value"));
        assertEquals("yes", resolution.properties().getProperty("profile.only"));
        assertEquals("yes", resolution.properties().getProperty("bundle.only"));
        assertEquals("yes", resolution.properties().getProperty("patch.only"));
        assertEquals(4, resolution.appliedFiles().size());
        assertTrue(resolution.warnings().isEmpty());
    }
}
