/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitOption;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.attribute.FileAttribute;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public final class LocalCompiler {
    private LocalCompiler() {
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public static RunResult compileAndRun(Map<String, String> sources, String mainClass, List<String> args, long timeoutSeconds) {
        Path work;
        long start = System.currentTimeMillis();
        if (sources == null || sources.isEmpty()) {
            return new RunResult(false, false, -1, "", "没有可编译的源码", 0L);
        }
        try {
            work = Files.createTempDirectory("codenode-compile");
        }
        catch (IOException e) {
            return new RunResult(false, false, -1, "", "无法创建编译目录: " + e.getMessage(), 0L);
        }
        try {
            ArrayList<Path> javaFiles = new ArrayList<Path>();
            for (Map.Entry<String, String> entry : sources.entrySet()) {
                String rel = entry.getKey() == null ? "" : entry.getKey();
                Path target = work.resolve(rel.replace('/', File.separatorChar));
                if (target.getParent() != null) {
                    Files.createDirectories(target.getParent());
                }
                Files.writeString(target, entry.getValue() == null ? "" : entry.getValue(), StandardCharsets.UTF_8);
                if (!rel.endsWith(".java")) continue;
                javaFiles.add(target);
            }
            if (javaFiles.isEmpty()) {
                return new RunResult(false, false, -1, "", "没有 .java 源码可编译", LocalCompiler.elapsed(start));
            }
            List<String> compileErrors = LocalCompiler.compileWithToolProvider(javaFiles);
            if (!compileErrors.isEmpty()) {
                return new RunResult(false, false, -1, "", String.join("\n", compileErrors), LocalCompiler.elapsed(start));
            }
            if (mainClass == null || mainClass.isBlank()) {
                return new RunResult(true, true, 0, "编译成功（未指定主类，未运行）", "", LocalCompiler.elapsed(start));
            }
            RunResult runResult = LocalCompiler.runJava(work, mainClass, args, timeoutSeconds, start);
            return runResult;
        }
        catch (Exception e) {
            return new RunResult(false, false, -1, "", "编译/运行失败: " + e.getMessage(), LocalCompiler.elapsed(start));
        }
        finally {
            LocalCompiler.deleteRecursively(work);
        }
    }

    private static List<String> compileWithToolProvider(List<Path> javaFiles) throws IOException {
        ArrayList<String> errors = new ArrayList<String>();
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            return LocalCompiler.compileWithJavac(javaFiles);
        }
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)){
            Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromPaths(javaFiles);
            Boolean success = compiler.getTask(null, fm, diagnostics, List.of("-encoding", "UTF-8", "-d", javaFiles.getFirst().getParent().toString()), null, units).call();
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
                if (d.getKind() != Diagnostic.Kind.ERROR) continue;
                String source = d.getSource() == null ? "?" : d.getSource().getName();
                errors.add(source + ":" + d.getLineNumber() + ": " + d.getMessage(null));
            }
            if (Boolean.TRUE.equals(success)) {
                return List.of();
            }
        }
        return errors;
    }

    private static List<String> compileWithJavac(List<Path> javaFiles) throws IOException {
        ArrayList<String> command = new ArrayList<String>();
        command.add(LocalCompiler.javacBin());
        command.add("-encoding");
        command.add("UTF-8");
        command.add("-d");
        command.add(javaFiles.getFirst().getParent().toString());
        for (Path f : javaFiles) {
            command.add(f.toString());
        }
        ProcessResult result = LocalCompiler.run(command, Path.of(".", new String[0]), 60L);
        if (result.exitCode == 0) {
            return List.of();
        }
        ArrayList<String> errors = new ArrayList<String>();
        if (result.output != null && !result.output.isBlank()) {
            errors.add(result.output.trim());
        }
        return errors;
    }

    private static RunResult runJava(Path classDir, String mainClass, List<String> args, long timeoutSeconds, long start) {
        ArrayList<String> command = new ArrayList<String>();
        command.add(LocalCompiler.javaBin());
        command.add("-cp");
        command.add(classDir.toString());
        command.add(mainClass);
        if (args != null) {
            command.addAll(args);
        }
        ProcessResult result = LocalCompiler.run(command, classDir, Math.max(5L, timeoutSeconds));
        String output = result.output == null ? "" : result.output.trim();
        boolean ok = result.exitCode == 0;
        return new RunResult(ok, true, result.exitCode, ok ? output : "", ok ? "" : output, LocalCompiler.elapsed(start));
    }

    private static ProcessResult run(List<String> command, Path dir, long timeoutSeconds) {
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(dir.toFile());
        builder.redirectErrorStream(true);
        try {
            int exitCode;
            Process process = builder.start();
            StringBuilder out = new StringBuilder();
            Thread reader = new Thread(() -> {
                try (InputStream in = process.getInputStream();){
                    int read;
                    byte[] buffer = new byte[4096];
                    while ((read = in.read(buffer)) >= 0) {
                        out.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
                    }
                }
                catch (IOException iOException) {
                    // empty catch block
                }
            });
            reader.setDaemon(true);
            reader.start();
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(2L, TimeUnit.SECONDS);
                exitCode = -1;
                out.append("\n…（运行超时，已强制终止）");
            } else {
                exitCode = process.exitValue();
            }
            reader.join(500L);
            return new ProcessResult(exitCode, out.toString());
        }
        catch (Exception e) {
            return new ProcessResult(-1, "启动进程失败: " + e.getMessage());
        }
    }

    private static String javaBin() {
        String home = System.getProperty("java.home", "");
        return home + File.separator + "bin" + File.separator + "java" + (LocalCompiler.isWindows() ? ".exe" : "");
    }

    private static String javacBin() {
        String home = System.getProperty("java.home", "");
        return home + File.separator + "bin" + File.separator + "javac" + (LocalCompiler.isWindows() ? ".exe" : "");
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    private static long elapsed(long start) {
        return System.currentTimeMillis() - start;
    }

    private static void deleteRecursively(Path dir) {
        if (dir == null || !Files.exists(dir, new LinkOption[0])) {
            return;
        }
        try (Stream<Path> stream = Files.walk(dir, new FileVisitOption[0]);){
            stream.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                }
                catch (Exception exception) {
                    // empty catch block
                }
            });
        }
        catch (IOException iOException) {
            // empty catch block
        }
    }

    public record RunResult(boolean ok, boolean compiled, int exitCode, String output, String error, long durationMs) {
    }

    private record ProcessResult(int exitCode, String output) {
    }
}
