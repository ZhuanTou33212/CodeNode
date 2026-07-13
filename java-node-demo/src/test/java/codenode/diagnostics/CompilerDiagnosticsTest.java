package codenode.diagnostics;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

class CompilerDiagnosticsTest {
    @Test
    void returnsStructuredFileLineColumnAndCode() throws Exception {
        Path root = Files.createTempDirectory("codenode-diagnostics-");
        Path source = root.resolve("Broken.java");
        Files.writeString(source, "public class Broken { void run( { }\n", java.nio.charset.StandardCharsets.UTF_8);
        CompilerDiagnostics.Result result = CompilerDiagnostics.compile(List.of(source), root.resolve("classes"));
        assertFalse(result.success());
        assertTrue(result.diagnostics().stream().anyMatch(item -> item.file() != null && item.line() > 0 && item.column() > 0 && !item.code().isBlank()));
    }

    @Test
    void compilesValidSource() throws Exception {
        Path root = Files.createTempDirectory("codenode-diagnostics-ok-");
        Path source = root.resolve("Valid.java");
        Files.writeString(source, "public class Valid { public static int value() { return 7; } }\n", java.nio.charset.StandardCharsets.UTF_8);
        CompilerDiagnostics.Result result = CompilerDiagnostics.compile(List.of(source), root.resolve("classes"));
        assertTrue(result.success());
        assertTrue(Files.exists(root.resolve("classes/Valid.class")));
    }
}
