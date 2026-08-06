package local.codenode.util;

import local.codenode.Json;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;

/**
 * 资源组（ASSET_BUNDLE）v2 bundleData 数据模型的单一事实来源：
 * 分类、成员 id 推导、v2 构建/解析与 v1 降级展示。
 *
 * <p>v2 顶层结构：{@code schemaVersion=2, memberCount, categoryStats, updatedAt, members[]}。
 * 成员项：{@code name, relativePath, category, size, checksum(crc32 hex), id}。</p>
 */
public final class BundleDataUtil {

    public static final int SCHEMA_VERSION = 2;
    public static final String DEFAULT_CATEGORY = "other";

    /** 标准资源包分类（Minecraft 资源包目录，其余归入 other）。 */
    public static final List<String> CATEGORIES = List.of(
        "models", "textures", "blockstates", "lang", "recipes", "loot_tables", "tags"
    );

    /** 单个资源组成员。 */
    public record BundleMember(String name, String relativePath, String category,
                               long size, String checksum, String id) {}

    /** v2 bundleData 的只读视图，供展示缓存使用。 */
    public record BundleView(int schemaVersion, int memberCount,
                             Map<String, Integer> categoryStats, String updatedAt,
                             List<BundleMember> members) {
        public BundleView {
            members = members == null ? List.of() : List.copyOf(members);
            Map<String, Integer> copy = new LinkedHashMap<>();
            if (categoryStats != null) copy.putAll(categoryStats);
            categoryStats = Collections.unmodifiableMap(copy);
        }
    }

    private BundleDataUtil() {}

    /** 按资源包目录结构对相对路径分类（单一事实来源，可单测）。 */
    public static String categorizeAssetPath(String relativePath) {
        if (relativePath == null) return DEFAULT_CATEGORY;
        String normalized = relativePath.replace('\\', '/');
        while (normalized.startsWith("./")) normalized = normalized.substring(2);
        for (String category : CATEGORIES) {
            if (normalized.contains("/" + category + "/") || normalized.startsWith(category + "/")) {
                return category;
            }
        }
        return DEFAULT_CATEGORY;
    }

    /** 成员稳定 id：sha256(category + ":" + relativePath) 前 16 位十六进制。 */
    public static String memberId(String category, String relativePath) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest((category + ":" + relativePath).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash, 0, 8);
        } catch (Exception e) {
            return Integer.toHexString((category + ":" + relativePath).hashCode());
        }
    }

    /** 从相对路径取文件名。 */
    public static String nameOf(String relativePath) {
        if (relativePath == null) return "";
        String normalized = relativePath.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        return slash < 0 ? normalized : normalized.substring(slash + 1);
    }

    /** 资源组成员目录分类 → 可落盘的 NodeRegistry 资产类型（保证 classificationKey 合法）。 */
    public static String assetTypeForCategory(String category) {
        return switch (category) {
            case "models" -> "model";
            case "textures" -> "texture";
            case "blockstates", "lang", "recipes", "loot_tables", "tags" -> "other";
            default -> "other";
        };
    }

    /** 读取文件并计算 crc32 十六进制摘要。 */
    public static String crc32Hex(Path file) throws IOException {
        CRC32 crc = new CRC32();
        byte[] buffer = new byte[8192];
        try (InputStream in = Files.newInputStream(file)) {
            int read;
            while ((read = in.read(buffer)) >= 0) crc.update(buffer, 0, read);
        }
        return Long.toHexString(crc.getValue());
    }

    /** 由磁盘根目录 + 相对路径列表构建 v2 bundleData（root 为 null 时不读磁盘，size/checksum 留空）。 */
    public static String buildV2BundleData(Path root, List<String> relativePaths) {
        List<BundleMember> members = new ArrayList<>();
        if (relativePaths != null) {
            for (String rel : relativePaths) {
                if (rel == null || rel.isBlank()) continue;
                String category = categorizeAssetPath(rel);
                long size = 0;
                String checksum = "";
                if (root != null) {
                    Path file = root.resolve(rel);
                    if (Files.isRegularFile(file)) {
                        try {
                            size = Files.size(file);
                            checksum = crc32Hex(file);
                        } catch (IOException ignored) {}
                    }
                }
                members.add(new BundleMember(nameOf(rel), rel, category, size, checksum, memberId(category, rel)));
            }
        }
        return buildV2BundleData(members);
    }

    /** 由成员列表构建 v2 bundleData JSON 字符串。 */
    public static String buildV2BundleData(List<BundleMember> members) {
        List<BundleMember> sorted = members == null ? List.of()
            : members.stream().sorted(Comparator.comparing(BundleMember::relativePath)).toList();
        Map<String, Integer> categoryStats = new LinkedHashMap<>();
        for (BundleMember member : sorted) categoryStats.merge(member.category(), 1, Integer::sum);
        List<Map<String, Object>> memberJson = new ArrayList<>();
        for (BundleMember member : sorted) {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("name", member.name());
            value.put("relativePath", member.relativePath());
            value.put("category", member.category());
            value.put("size", member.size());
            value.put("checksum", member.checksum());
            value.put("id", member.id());
            memberJson.add(value);
        }
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("schemaVersion", SCHEMA_VERSION);
        root.put("memberCount", sorted.size());
        root.put("categoryStats", categoryStats);
        root.put("updatedAt", Instant.now().toString());
        root.put("members", memberJson);
        return Json.stringify(root);
    }

    /** 解析 v2 bundleData；schemaVersion 缺失或为 1 时自动降级到 v1 视图。 */
    public static BundleView parseV2(String bundleData) {
        if (bundleData == null || bundleData.isBlank()) return emptyView();
        try {
            Map<String, Object> root = Json.object(bundleData);
            int schemaVersion = root.get("schemaVersion") instanceof Number number ? number.intValue() : 1;
            List<BundleMember> members = new ArrayList<>();
            Object rawMembers = root.get("members");
            if (rawMembers instanceof List<?> list) {
                for (Object item : list) {
                    if (!(item instanceof Map<?, ?> map)) continue;
                    members.add(memberFromMap(map));
                }
            }
            int memberCount = root.get("memberCount") instanceof Number number ? number.intValue() : members.size();
            Map<String, Integer> stats = new LinkedHashMap<>();
            Object rawStats = root.get("categoryStats");
            if (rawStats instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (entry.getValue() instanceof Number number) stats.put(String.valueOf(entry.getKey()), number.intValue());
                }
            } else {
                for (BundleMember member : members) stats.merge(member.category(), 1, Integer::sum);
            }
            String updatedAt = String.valueOf(root.getOrDefault("updatedAt", ""));
            return new BundleView(schemaVersion, memberCount, stats, updatedAt, members);
        } catch (RuntimeException e) {
            return emptyView();
        }
    }

    /** legacy v1（{@code {"files":[{"path":...,"type":...}]}）降级为展示视图：按路径推导分类、补齐 id。 */
    public static BundleView downgradeV1(String bundleData) {
        if (bundleData == null || bundleData.isBlank()) return emptyView();
        try {
            Map<String, Object> root = Json.object(bundleData);
            List<BundleMember> members = new ArrayList<>();
            Object rawFiles = root.get("files");
            if (rawFiles instanceof List<?> list) {
                for (Object item : list) {
                    if (!(item instanceof Map<?, ?> map)) continue;
                    Object pathObj = map.get("path");
                    String rel = pathObj == null ? "" : String.valueOf(pathObj);
                    if (rel.isBlank() || "null".equals(rel)) continue;
                    String category = categorizeAssetPath(rel);
                    members.add(new BundleMember(nameOf(rel), rel, category, 0, "", memberId(category, rel)));
                }
            }
            Map<String, Integer> stats = new LinkedHashMap<>();
            for (BundleMember member : members) stats.merge(member.category(), 1, Integer::sum);
            return new BundleView(1, members.size(), stats, "", members);
        } catch (RuntimeException e) {
            return emptyView();
        }
    }

    private static BundleMember memberFromMap(Map<?, ?> map) {
        Object relObj = map.get("relativePath");
        String rel = relObj == null ? "" : String.valueOf(relObj);
        Object catObj = map.get("category");
        String category = catObj == null ? categorizeAssetPath(rel) : String.valueOf(catObj);
        if ("null".equals(category)) category = categorizeAssetPath(rel);
        Object nameObj = map.get("name");
        String name = nameObj == null || "null".equals(String.valueOf(nameObj)) ? nameOf(rel) : String.valueOf(nameObj);
        long size = map.get("size") instanceof Number number ? number.longValue() : 0;
        Object checksumObj = map.get("checksum");
        String checksum = checksumObj == null || "null".equals(String.valueOf(checksumObj)) ? "" : String.valueOf(checksumObj);
        Object idObj = map.get("id");
        String id = idObj == null || "null".equals(String.valueOf(idObj)) ? memberId(category, rel) : String.valueOf(idObj);
        return new BundleMember(name, rel, category, size, checksum, id);
    }

    private static BundleView emptyView() {
        return new BundleView(1, 0, Map.of(), "", List.of());
    }
}
