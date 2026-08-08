/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools.impl;

import java.util.LinkedHashMap;
import java.util.Map;
import local.codenode.WorkflowDslService;
import local.codenode.WorkflowModel;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;

public final class WriteAnalysisMdTool {
    private WriteAnalysisMdTool() {
    }

    public static void register(AgentToolRegistry registry) {
        registry.register("write_analysis_md", "把项目分析结果写成 Markdown 分析节点（FILE 节点 + md 代码槽）。content 缺省时自动调用架构解码（decodeArchitecture）从画布生成完整项目分析架构；也可直接传 content。name 为节点名称（默认「项目分析」）；relativePath 为文件路径（默认 analysis/<时间戳>.md）。返回节点 id，可被后续节点调用。", Map.of("type", "object", "properties", Map.of("content", Map.of("type", "string", "description", "分析内容（markdown），缺省自动生成项目架构"), "name", Map.of("type", "string", "description", "节点名称，默认「项目分析」"), "relativePath", Map.of("type", "string", "description", "文件相对路径，默认 analysis/<时间戳>.md"), "regenerate", Map.of("type", "boolean", "description", "缺省 content 时是否重新从画布生成架构，默认 true"))), WriteAnalysisMdTool::execute);
    }

    static AgentToolResult execute(AgentToolContext context, Map<String, Object> arguments) {
        String name = WriteAnalysisMdTool.stringArg(arguments, "name", "项目分析");
        String content = WriteAnalysisMdTool.stringArg(arguments, "content", "");
        if (content.isEmpty() && !(arguments.get("content") instanceof String)) {
            Boolean b;
            boolean regenerate;
            Object object = arguments.get("regenerate");
            boolean bl = regenerate = !(object instanceof Boolean) || (b = (Boolean)object) != false;
            if (regenerate) {
                WorkflowModel model2 = context.model();
                if (model2 == null) {
                    return AgentToolResult.error("当前没有可用的工作台模型");
                }
                content = new WorkflowDslService().decodeArchitecture(model2).markdown();
            }
        }
        if (content.isBlank()) {
            return AgentToolResult.error("没有可写入的分析内容（content 为空且无法自动生成架构）");
        }
        String relativePath = WriteAnalysisMdTool.stringArg(arguments, "relativePath", "analysis/" + System.currentTimeMillis() + ".md");
        String mdContent = content;
        String[] nodeId = new String[]{""};
        context.mutateWorkbench(model -> {
            WorkflowModel.Node mdNode = model.addFileNode(120, 120, name, relativePath);
            mdNode.parentScopeId = "";
            mdNode.category = "项目分析";
            mdNode.classificationKey = "analysis.default";
            WorkflowModel.CodeSlot slot = model.ensureFileSlot(mdNode);
            slot.language = "markdown";
            slot.activeCode = mdContent;
            ++slot.activeRevision;
            nodeId[0] = mdNode.id;
        });
        if (nodeId[0].isBlank()) {
            return AgentToolResult.error("没有创建分析节点（工作台不可用）");
        }
        context.audit("write_analysis_md name=" + name + " path=" + relativePath + " chars=" + mdContent.length());
        LinkedHashMap<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("nodeId", nodeId[0]);
        data.put("name", name);
        data.put("relativePath", relativePath);
        data.put("chars", mdContent.length());
        data.put("preview", mdContent.length() > 400 ? mdContent.substring(0, 400) + "…" : mdContent);
        return AgentToolResult.ok("已写入分析节点 " + name + "（" + mdContent.length() + " 字符）→ " + nodeId[0], data);
    }

    private static String stringArg(Map<String, Object> arguments, String key, String fallback) {
        Object value = arguments.get(key);
        if (value == null || "null".equals(String.valueOf(value))) {
            return fallback;
        }
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? fallback : text;
    }
}
