package codenode.diagnostics;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/** Compiles Java sources and preserves structured compiler diagnostics. */
public final class CompilerDiagnostics {
    private CompilerDiagnostics() {}

    public static Result compile(List<Path> sources, Path outputDirectory) throws IOException {
        Objects.requireNonNull(sources, "sources");
        Objects.requireNonNull(outputDirectory, "outputDirectory");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            throw new IllegalStateException("A full JDK is required; JavaCompiler is unavailable.");
        }
        Files.createDirectories(outputDirectory);
        DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
        try (StandardJavaFileManager manager = compiler.getStandardFileManager(collector, null, null)) {
            manager.setLocationFromPaths(javax.tools.StandardLocation.CLASS_OUTPUT, List.of(outputDirectory));
            Iterable<? extends JavaFileObject> units = manager.getJavaFileObjectsFromPaths(sources);
            boolean success = Boolean.TRUE.equals(compiler.getTask(null, manager, collector,
                    List.of("-encoding", "UTF-8"), null, units).call());
            List<DiagnosticItem> diagnostics = new ArrayList<>();
            for (Diagnostic<? extends JavaFileObject> diagnostic : collector.getDiagnostics()) {
                diagnostics.add(new DiagnosticItem(
                        diagnostic.getKind().name(),
                        diagnostic.getCode(),
                        diagnostic.getSource() == null ? null : Path.of(diagnostic.getSource().toUri()).toString(),
                        diagnostic.getLineNumber(),
                        diagnostic.getColumnNumber(),
                        diagnostic.getMessage(null)));
            }
            return new Result(success, diagnostics);
        }
    }

    public record Result(boolean success, List<DiagnosticItem> diagnostics) {}

    public record DiagnosticItem(String severity, String code, String file, long line, long column, String message) {}
}
