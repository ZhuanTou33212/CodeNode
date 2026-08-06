package local.codenode.agent.tools;

import java.util.Map;

/** 工具元数据：名称、说明、输入 JSON Schema（OpenAI function 兼容的 parameters 结构）。 */
public record AgentToolSpec(String name, String description, Map<String, Object> inputSchema) {}
