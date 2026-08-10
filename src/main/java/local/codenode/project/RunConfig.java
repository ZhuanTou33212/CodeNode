package local.codenode.project;

import java.nio.file.Path;

/**
 * 运行配置模型（Stage4.8 4.4 RunConfig，对标 IntelliJ Run/Debug Configurations）。
 * kind 决定如何启动：入口类 / JAR / Gradle 任务 / Maven 目标。
 */
public record RunConfig(
        String name,
        Kind kind,
        String mainClass,
        String jarPath,
        String jdkHome,
        java.util.List<String> vmArgs,
        java.util.List<String> programArgs,
        Path workingDir,
        java.util.List<String> beforeLaunch,
        boolean trace) {

    public enum Kind { MAIN_CLASS, JAR_APPLICATION, GRADLE_TASK, MAVEN_GOAL }

    public RunConfig {
        vmArgs = vmArgs == null ? java.util.List.of() : java.util.List.copyOf(vmArgs);
        programArgs = programArgs == null ? java.util.List.of() : java.util.List.copyOf(programArgs);
        beforeLaunch = beforeLaunch == null ? java.util.List.of() : java.util.List.copyOf(beforeLaunch);
    }

    public static RunConfig forMainClass(Path root, String mainClass) {
        return new RunConfig(mainClass, Kind.MAIN_CLASS, mainClass, null, null,
                java.util.List.of(), java.util.List.of(), root, java.util.List.of("compile"), false);
    }

    public static RunConfig forGradleTask(Path root, String task) {
        return new RunConfig(task, Kind.GRADLE_TASK, task, null, null,
                java.util.List.of(), java.util.List.of(), root, java.util.List.of(), false);
    }
}
