package local.codenode.agent.tools.impl;

import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;

/** 文件搜索类工具共用的目录忽略与二进制检测。 */
final class ToolFiles {
    private static final Set<String> IGNORED_DIRS = Set.of(
        "target", "build", ".git", ".idea", "node_modules", "dist", "out", ".gradle", "cache"
    );
    private static final Set<String> BINARY_EXTS = Set.of(
        "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "tga", "dds", "psd", "ico", "icns",
        "jar", "class", "war", "zip", "gz", "7z", "rar", "exe", "dll", "so", "dylib", "a", "o", "obj", "lib",
        "mp3", "wav", "ogg", "flac", "m4a", "mp4", "avi", "mkv", "mov", "webm", "ttf", "otf", "woff", "woff2", "eot",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "db", "sqlite", "bin", "dat"
    );

    private ToolFiles() {}

    static boolean shouldSkipDir(Path dir) {
        return IGNORED_DIRS.contains(dir.getFileName().toString());
    }

    static boolean isBinary(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        return BINARY_EXTS.contains(ext);
    }
}
