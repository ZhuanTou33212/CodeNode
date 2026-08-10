package local.codenode.project;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 运行时轨迹采集摘要（Stage4.7 最小实现）：解析 JFR 记录文件，统计方法执行采样
 * 与异常事件。通过反射访问 jdk.jfr（避免 jpackage 精简运行时缺模块导致类加载失败）。
 */
public final class TraceCollector {
    private TraceCollector() {}

    /** 解析 .jfr 文件，返回 { methods: [{name, samples}], exceptions: [...], events }。 */
    public static Map<String, Object> summarizeJfr(Path jfr) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (jfr == null || !java.nio.file.Files.isRegularFile(jfr)) {
            result.put("trace", "JFR 文件不存在: " + jfr);
            return result;
        }
        try {
            Class<?> recordingFileClass = Class.forName("jdk.jfr.RecordingFile");
            Class<?> recordedEventClass = Class.forName("jdk.jfr.consumer.RecordedEvent");
            Constructor<?> ctor = recordingFileClass.getConstructor(Path.class);
            Object recordingFile = ctor.newInstance(jfr);
            Method readEvent = recordingFileClass.getMethod("readEvent");
            Method getEventType = recordedEventClass.getMethod("getEventType");
            Method getName = Class.forName("jdk.jfr.EventType").getMethod("getName");
            Method getValue = recordedEventClass.getMethod("getValue", String.class);
            Method getMethod = recordedEventClass.getMethod("getMethod");

            Map<String, Integer> methodSamples = new LinkedHashMap<>();
            List<String> exceptions = new ArrayList<>();
            int events = 0;
            Object event;
            while ((event = readEvent.invoke(recordingFile)) != null) {
                events++;
                Object type = getEventType.invoke(event);
                String typeName = String.valueOf(getName.invoke(type));
                if ("jdk.MethodExecutionSample".equals(typeName) || "jdk.ExecutionSample".equals(typeName)) {
                    String methodName = String.valueOf(getValue.invoke(event, "method"));
                    methodSamples.merge(methodName, 1, Integer::sum);
                } else if ("jdk.JavaExceptionThrow".equals(typeName)) {
                    Object clazz = getValue.invoke(event, "exceptionClass");
                    exceptions.add(clazz == null ? "?" : clazz.toString());
                }
            }
            try {
                Method close = recordingFileClass.getMethod("close");
                close.invoke(recordingFile);
            } catch (Exception ignored) {}

            List<Map<String, Object>> methods = new ArrayList<>();
            methodSamples.entrySet().stream()
                    .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                    .limit(50)
                    .forEach(e -> methods.add(Map.of("name", e.getKey(), "samples", e.getValue())));
            result.put("methods", methods);
            result.put("exceptions", exceptions);
            result.put("events", events);
            if (methodSamples.isEmpty()) {
                result.put("trace", "JFR 记录完成，但未采集到方法采样事件（可能程序运行时间过短）");
            }
            return result;
        } catch (ClassNotFoundException e) {
            result.put("trace", "运行时缺少 jdk.jfr 模块，无法解析 JFR（降级为仅进程输出）");
            return result;
        } catch (Exception e) {
            result.put("traceError", "JFR 解析失败: " + e.getMessage());
            return result;
        }
    }
}
