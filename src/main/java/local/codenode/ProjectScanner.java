/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.FileVisitor;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import local.codenode.NodeRegistry;

public final class ProjectScanner {
    private static final Set<String> IGNORED_DIRS = Set.of("target", "build", ".git", ".idea", "node_modules", "dist", "out", ".gradle", "cache", ".codenode", ".vscode", ".settings", "logs");
    private static final Set<String> IGNORED_EXTS = Set.of("class", "jar", "war", "log", "tmp");
    private static final Map<String, String> SOURCE_LANGS = Map.of("java", "java", "kt", "kotlin", "py", "python");
    private static final Set<String> ASSET_EXTS = Set.of("json", "png", "xml", "ogg", "txt", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "tga", "dds", "psd", "wav", "mp3", "flac", "aac", "m4a", "opus", "mp4", "avi", "mkv", "mov", "webm", "fbx", "obj", "gltf", "glb", "blend", "stl", "dae", "usd", "usdz", "abc", "ply", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "gradle", "proto", "csv", "md", "html", "css", "scss", "less");
    private static final Pattern PACKAGE_PATTERN = Pattern.compile("^\\s*package\\s+([\\w.]+)\\s*;");
    private static final Pattern IMPORT_PATTERN = Pattern.compile("^\\s*import\\s+([\\w.]+)\\s*;");
    private static final Pattern PY_FROM_PATTERN = Pattern.compile("^\\s*from\\s+([\\w.]+)\\s+import\\b");

    private ProjectScanner() {
    }

    public static boolean isIgnoredDirName(String dirName) {
        return dirName != null && IGNORED_DIRS.contains(dirName);
    }

    public static boolean isIgnoredExt(String ext) {
        return ext != null && IGNORED_EXTS.contains(ext);
    }

    public static String sourceLanguage(String ext) {
        return SOURCE_LANGS.get(ext);
    }

    public static boolean isAssetExt(String ext) {
        return ASSET_EXTS.contains(ext);
    }

    public static ScanResult scan(Path root) throws IOException {
        if (root == null) {
            throw new NoSuchFileException("项目根目录为空");
        }
        final Path absoluteRoot = root.toAbsolutePath().normalize();
        if (!Files.isDirectory(absoluteRoot, new LinkOption[0])) {
            throw new NoSuchFileException("目录不存在: " + String.valueOf(absoluteRoot));
        }
        final ArrayList<SourceFile> sources = new ArrayList<SourceFile>();
        final ArrayList<AssetFile> assets = new ArrayList<AssetFile>();
        final LinkedHashMap<Path, List<String>> importCache = new LinkedHashMap<>();
        Files.walkFileTree(absoluteRoot, (FileVisitor<? super Path>)new SimpleFileVisitor<Path>(){

            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(absoluteRoot) && IGNORED_DIRS.contains(dir.getFileName().toString())) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                String name = file.getFileName().toString();
                String ext = ProjectScanner.extension(name);
                if (IGNORED_EXTS.contains(ext)) {
                    return FileVisitResult.CONTINUE;
                }
                String relative = absoluteRoot.relativize(file.toAbsolutePath().normalize()).toString().replace('\\', '/');
                String language = SOURCE_LANGS.get(ext);
                if (language != null) {
                    List<String> imports = importCache.computeIfAbsent(file, ProjectScanner::readImports);
                    sources.add(new SourceFile(relative, name, language, ProjectScanner.packageOf(file, relative, language), imports));
                } else if (ASSET_EXTS.contains(ext) || !"other".equals(NodeRegistry.classifyExtension(name))) {
                    assets.add(new AssetFile(relative, name, NodeRegistry.classifyExtension(name)));
                }
                return FileVisitResult.CONTINUE;
            }
        });
        sources.sort(Comparator.comparing(SourceFile::relativePath));
        assets.sort(Comparator.comparing(AssetFile::relativePath));
        return new ScanResult(sources, assets);
    }

    private static String extension(String filename) {
        int dot = filename.lastIndexOf(46);
        return dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static List<String> readImports(Path file) {
        ArrayList<String> imports = new ArrayList<String>();
        try {
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            int scanned = Math.min(lines.size(), 300);
            for (int i = 0; i < scanned; ++i) {
                String line = lines.get(i).trim();
                Matcher imp = IMPORT_PATTERN.matcher(line);
                if (imp.find()) {
                    String value = imp.group(1);
                    if (!value.contains(".") || value.startsWith("java.") || value.startsWith("javax.") || value.startsWith("sun.") || value.startsWith("jdk.") || value.startsWith("kotlin.")) continue;
                    imports.add(value);
                    continue;
                }
                Matcher from = PY_FROM_PATTERN.matcher(line);
                if (from.find()) {
                    imports.add(from.group(1));
                    continue;
                }
                if (i < 60 || line.startsWith("import ") || line.startsWith("from ")) {
                    continue;
                }
                break;
            }
        }
        catch (IOException iOException) {
            // empty catch block
        }
        return List.copyOf(imports);
    }

    private static String packageOf(Path file, String relative, String language) {
        if ("python".equals(language)) {
            return "";
        }
        String declared = null;
        try {
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            int scanned = Math.min(lines.size(), 200);
            for (int i = 0; i < scanned; ++i) {
                String line = lines.get(i).trim();
                Matcher matcher = PACKAGE_PATTERN.matcher(line);
                if (matcher.find()) {
                    declared = matcher.group(1);
                } else if (i < 60 || line.startsWith("package ") || line.startsWith("import ")) {
                    continue;
                }
                break;
            }
        }
        catch (IOException lines) {
            // empty catch block
        }
        if (declared != null && !declared.isBlank()) {
            return declared;
        }
        int slash = relative.lastIndexOf(47);
        if (slash <= 0) {
            return "";
        }
        String dir = relative.substring(0, slash);
        for (String prefix : new String[]{"src/main/java/", "src/main/kotlin/", "src/", "app/src/main/java/", "app/src/main/kotlin/"}) {
            if (!dir.startsWith(prefix)) continue;
            return dir.substring(prefix.length()).replace('/', '.');
        }
        return dir.replace('/', '.');
    }

    public record ScanResult(List<SourceFile> sourceFiles, List<AssetFile> assetFiles) {
        public ScanResult {
            sourceFiles = List.copyOf(sourceFiles);
            assetFiles = List.copyOf(assetFiles);
        }

        public int total() {
            return this.sourceFiles.size() + this.assetFiles.size();
        }
    }

    public record AssetFile(String relativePath, String name, String assetType) {
    }

    public record SourceFile(String relativePath, String name, String language, String packageName, List<String> imports) {
    }
}
