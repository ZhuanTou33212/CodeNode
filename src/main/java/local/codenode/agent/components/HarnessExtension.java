package local.codenode.agent.components;

/**
 * 可由外部 JAR 通过 {@link java.util.ServiceLoader} 发现的 harness 扩展。
 *
 * <p>扩展只负责向装配器注册组件；是否启用由 agent.properties 中的组件名称决定。
 * 这样安装新的模型、工具源、提示词、压缩器或监听器时，不需要修改 CodeNode 主程序。</p>
 */
public interface HarnessExtension {

    /** 稳定的扩展名称，用于日志与诊断。 */
    String name();

    /** 向装配器注册一个或多个组件。 */
    void register(HarnessAssembler assembler);
}
