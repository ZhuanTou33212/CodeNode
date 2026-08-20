package local.codenode.agent.components;

import java.util.function.Function;

/**
 * 系统提示分段组件（对应 DeepSeek Harness 的 context / prompt 组装）。
 *
 * <p>每段有一个配置名（如 {@code role} / {@code file_rules}）与一个渲染函数；
 * {@link PromptAssembler} 按 {@code harness.prompt_sections} 配置选择与排序。
 * 动态段（记忆、知识、任务清单）每次渲染时读取最新状态。</p>
 */
public abstract class PromptSection {

    private final String name;

    protected PromptSection(String name) {
        this.name = name;
    }

    /** 配置里引用的段名。 */
    public final String name() {
        return name;
    }

    /** 渲染本段文本；无可渲染内容时返回空串。 */
    public abstract String render(PromptContext ctx);

    public static PromptSection of(String name, Function<PromptContext, String> renderer) {
        return new PromptSection(name) {
            @Override
            public String render(PromptContext ctx) {
                return renderer.apply(ctx);
            }
        };
    }
}
