package local.codenode;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

/**
 * 固定（确定性）文件类型检测：扩展名 + magic bytes 交叉验证，文本/二进制判定。
 *
 * <p>与 {@link FileContentAnalyzer#detectLanguage} 的纯扩展名猜测不同，本类读取文件头部
 * 字节（最多 16 字节）做硬校验：.class 必须是 CAFEBABE、PNG 必须是 89504E47 等。
 * 判定结果供 AI 决定解析策略：文本可读、二进制必须跳过或用专用工具。</p>
 */
public final class FileTypeDetector {

    private FileTypeDetector() {}

    /** 文件大类：决定 AI 用哪种方式解析。 */
    public enum FileKind {
        /** 源码/文本，可 read_file 并做语法级摘要。 */
        SOURCE,
        /** 标记文本（JSON/XML/YAML/MD/属性），可 read_file 并做结构摘要。 */
        MARKUP,
        /** 文档/资产（图片/音视频/字体/office）。 */
        ASSET,
        /** 二进制（字节码/归档/库），禁止 read_file。 */
        BINARY,
        /** 无法识别。 */
        UNKNOWN
    }

    public record TypeInfo(String extension, String mime, FileKind kind, String description, boolean text) {}

    /** 常见二进制 magic bytes（16 进制前缀，大写）。 */
    private static final String[][] MAGIC = {
        {"CAFEBABE", "application/java-vm", "Java 字节码 (.class)"},
        {"89504E470D0A1A0A", "image/png", "PNG 图片"},
        {"FFD8FF", "image/jpeg", "JPEG 图片"},
        {"474946383761", "image/gif", "GIF 图片"},
        {"474946383961", "image/gif", "GIF 图片"},
        {"25504446", "application/pdf", "PDF 文档"},
        {"504B0304", "application/zip", "ZIP 归档（含 .jar/.cnode/.docx/.xlsx/.pptx）"},
        {"504B0506", "application/zip", "ZIP 空归档"},
        {"504B0708", "application/zip", "ZIP 分卷"},
        {"7F454C46", "application/elf", "ELF 可执行/共享库"},
        {"CFFAEDFE", "application/mach-o", "Mach-O 可执行（arm64）"},
        {"FEEDFACE", "application/mach-o", "Mach-O 可执行（32 位）"},
        {"FEEDFACF", "application/mach-o", "Mach-O 可执行（64 位）"},
        {"4D5A", "application/x-dosexec", "PE/Windows 可执行"},
        {"53514C697465", "application/vnd.sqlite3", "SQLite 数据库"},
        {"1F8B08", "application/gzip", "gzip 压缩文件"},
        {"52617221", "application/x-rar", "RAR 归档"},
        {"377ABCAF271C", "application/x-7z-compressed", "7-Zip 归档"},
        {"494433", "audio/mpeg", "MP3 音频"},
        {"4F676753", "application/ogg", "Ogg 容器"},
        {"66747970", "application/mp4", "MP4/MOV 容器（ftyp）"},
        {"424D", "image/bmp", "BMP 图片"},
        {"49492A00", "image/tiff", "TIFF 图片（小端）"},
        {"4D4D002A", "image/tiff", "TIFF 图片（大端）"},
        {"000001BA", "video/mpeg", "MPEG 视频"},
        {"000001B3", "video/mpeg", "MPEG 视频"},
        {"1A45DFA3", "video/x-matroska", "MKV/WebM 容器"},
        {"3C3F786D6C", "application/xml", "XML 文档"},
    };

    private static final int MAGIC_BYTES = 16;

    /**
     * 检测文件类型：先读 magic bytes，再结合扩展名给出最终判定。
     * 失败（不存在/读不了）时按扩展名降级。
     */
    public static TypeInfo detect(Path file) {
        String name = file.getFileName() == null ? "" : file.getFileName().toString();
        String ext = extensionOf(name);
        try (InputStream in = Files.newInputStream(file)) {
            byte[] head = in.readNBytes(MAGIC_BYTES);
            String hex = hex(head);
            // 1) magic bytes 优先（能识别的二进制/文档）
            for (String[] magic : MAGIC) {
                if (hex.startsWith(magic[0])) {
                    return new TypeInfo(ext, magic[1], kindOf(ext, magic[1]), magic[2], false);
                }
            }
            // 2) 文本判定：无 NUL 且能按 UTF-8 解码
            if (isText(head, hex)) {
                String language = FileContentAnalyzer.detectLanguage(name);
                boolean markup = language.equals("json") || language.equals("xml") || language.equals("yaml")
                        || language.equals("markdown") || language.equals("properties");
                return new TypeInfo(ext, mimeOf(language), markup ? FileKind.MARKUP : FileKind.SOURCE,
                        language.equals("unknown") ? "文本文件（扩展名未知）" : language + " 源码/文本", true);
            }
            // 3) 二进制但 magic 未收录
            return new TypeInfo(ext, "application/octet-stream", FileKind.BINARY, "二进制文件（未知格式）", false);
        } catch (IOException e) {
            // 读不了 → 按扩展名降级
            String language = FileContentAnalyzer.detectLanguage(name);
            if (!language.equals("unknown") && !language.equals(name.isEmpty() ? "" : ext)) {
                return new TypeInfo(ext, mimeOf(language), FileKind.SOURCE, language + " 源码/文本", true);
            }
            return new TypeInfo(ext, "application/octet-stream", FileKind.UNKNOWN, "无法读取", false);
        }
    }

    /** 文本判定：头部无 NUL 字节、非零字节占比高、可 UTF-8 解码。 */
    static boolean isText(byte[] head, String hex) {
        if (head.length == 0) return true;
        int nonAscii = 0;
        for (byte b : head) {
            if (b == 0) return false; // NUL 是二进制强信号
            if (b < 0) nonAscii++;
        }
        if (nonAscii > head.length / 3) return false; // 大量非 ASCII 高位字节 → 大概率二进制
        try {
            new String(head, java.nio.charset.StandardCharsets.UTF_8);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 || dot == name.length() - 1 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02X", b));
        return sb.toString();
    }

    private static String mimeOf(String language) {
        return switch (language) {
            case "java" -> "text/x-java-source";
            case "python" -> "text/x-python";
            case "javascript" -> "text/javascript";
            case "typescript" -> "text/typescript";
            case "json" -> "application/json";
            case "xml", "html" -> "text/xml";
            case "yaml" -> "text/yaml";
            case "markdown" -> "text/markdown";
            case "css" -> "text/css";
            case "sql" -> "application/sql";
            case "properties" -> "text/x-java-properties";
            default -> "text/plain";
        };
    }

    /** 已知二进制扩展名在 magic 未命中时仍归为二进制；zip 类扩展名沿用 magic 的 zip 判定。 */
    private static FileKind kindOf(String ext, String magicMime) {
        if (magicMime.equals("application/zip")) {
            // .cnode/.jar/.docx 等 zip 容器保持 BINARY（AI 不得 read_file）
            return FileKind.BINARY;
        }
        return switch (ext) {
            case "png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "ico",
                 "mp3", "mp4", "wav", "ogg", "flac", "mov", "avi", "mkv", "webm",
                 "pdf", "class", "jar", "zip", "gz", "rar", "7z", "exe", "dll", "so", "dylib",
                 "ttf", "otf", "woff", "woff2", "eot" -> FileKind.BINARY;
            default -> FileKind.ASSET;
        };
    }
}
