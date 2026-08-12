package local.codenode.project;

import jdk.jfr.consumer.RecordedEvent;
import jdk.jfr.consumer.RecordingFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** JFR 记录摘要：统计执行采样、异常事件和总事件数。 */
public final class TraceCollector {
    private TraceCollector() {}

    public static Map<String, Object> summarizeJfr(Path jfr) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (jfr == null || !Files.isRegularFile(jfr)) {
            result.put("trace", "JFR 文件不存在: " + jfr);
            return result;
        }
        Map<String, Integer> methodSamples = new LinkedHashMap<>();
        List<String> exceptions = new ArrayList<>();
        int events = 0;
        try (RecordingFile recording = new RecordingFile(jfr)) {
            while (recording.hasMoreEvents()) {
                RecordedEvent event = recording.readEvent();
                events++;
                String typeName = event.getEventType().getName();
                if ("jdk.MethodExecutionSample".equals(typeName) || "jdk.ExecutionSample".equals(typeName)) {
                    String methodName = "(unknown)";
                    try {
                        Object method = event.getValue("method");
                        if (method != null) methodName = method.toString();
                    } catch (RuntimeException ignored) {
                        try {
                            Object stack = event.getValue("stackTrace");
                            if (stack != null) methodName = stack.toString();
                        } catch (RuntimeException ignoredAgain) { }
                    }
                    methodSamples.merge(methodName, 1, Integer::sum);
                } else if ("jdk.JavaExceptionThrow".equals(typeName)) {
                    try {
                        Object clazz = event.getValue("exceptionClass");
                        exceptions.add(clazz == null ? "?" : clazz.toString());
                    } catch (RuntimeException ignored) { exceptions.add("?"); }
                }
            }
            List<Map<String, Object>> methods = new ArrayList<>();
            methodSamples.entrySet().stream()
                    .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                    .limit(50)
                    .forEach(e -> methods.add(Map.of("name", e.getKey(), "samples", e.getValue())));
            result.put("methods", methods);
            result.put("exceptions", exceptions);
            result.put("events", events);
            result.put("jfrFile", jfr.toAbsolutePath().normalize().toString());
            if (methodSamples.isEmpty()) result.put("trace", "JFR 记录完成，但未采集到方法采样事件（可能程序运行时间过短）");
            return result;
        } catch (Exception e) {
            result.put("traceError", "JFR 解析失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return result;
        }
    }
}