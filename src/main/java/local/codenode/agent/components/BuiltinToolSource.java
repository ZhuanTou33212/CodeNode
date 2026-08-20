package local.codenode.agent.components;

import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.impl.AgentToolkit;

/**
 * 内置工具源：把 {@code AgentToolkit} 的全部 30+ 内置工具注册进注册表。
 * 白名单过滤（tools.enabled / tools.disabled）由装配器统一在最后执行。
 */
public final class BuiltinToolSource implements ToolSource {

    @Override
    public String name() {
        return "builtin";
    }

    @Override
    public void registerInto(AgentToolRegistry registry) {
        AgentToolkit.registerAllInto(registry);
    }
}
