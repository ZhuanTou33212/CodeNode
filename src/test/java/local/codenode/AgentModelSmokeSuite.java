package local.codenode;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.impl.AgentToolkit;
import local.codenode.config.AgentConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 真实模型冒烟评估（P2-12）：固定任务 + 真实模型 + 工作台模型终态判定。
 *
 * <p>与 {@code AgentEvalSuite}（脚本化 client，验证 harness 逻辑）互补：本套件用真实模型
 * 验证「工具选择与推理质量」，判定依据是工具调用轨迹（timeline）与工作台模型终态，
 * 而非模型自述。默认跳过（CI 无 key）；手动运行：</p>
 * <pre>
 *   mvn test -o -Dtest=AgentModelSmokeSuite -Dcodenode.smoke=true
 *   # 指定配置文件：-Dcodenode.config=config/agent.properties
 * </pre>
 */
@EnabledIfSystemProperty(named = "codenode.smoke", matches = "true")
class AgentModelSmokeSuite {

    private static AgentConfig loadConfig() {
        String override = System.getProperty("codenode.config");
        AgentConfig config = override == null || override.isBlank()
                ? AgentConfig.load()
                : new AgentConfig(Path.of(override));
        config.reload();
        return config;
    }

    private static AgentChatController controller(Path root, WorkflowModel model, AgentConfig config) {
        AgentToolContext context = new AgentToolContext(
                () -> root, () -> model, (level, what, detail) -> true, entry -> {});
        context.setPermissionSupplier(config::permissions);
        AgentToolRegistry registry = AgentToolkit.buildDefaultRegistry(context, config);
        return new AgentChatController(config, registry, context);
    }

    private static void awaitIdle(AgentChatController controller, long timeoutMillis) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (controller.state() != AgentProvider.SessionState.IDLE && System.currentTimeMillis() < deadline) {
            Thread.sleep(100);
        }
        assertEquals(AgentProvider.SessionState.IDLE, controller.state(), "会话应在超时前回到 IDLE");
    }

    private static boolean called(AgentChatController controller, String tool) {
        return controller.timeline().snapshot().steps().stream().anyMatch(s -> tool.equals(s.tool()));
    }

    @Test
    void createNodesReachesWorkbench(@TempDir Path root) throws Exception {
        AgentConfig config = loadConfig();
        assumeTrue(config.isConfigured(), "未配置 Agent API（baseUrl/apiKey），跳过真实模型冒烟");
        WorkflowModel model = new WorkflowModel();
        AgentChatController controller = controller(root, model, config);
        controller.sendMessage(
                "请用 create_nodes 工具在工作台创建 3 个节点并把它们串联起来（connect=true），完成后用中文总结。", events -> {});
        awaitIdle(controller, 240_000);

        assertTrue(called(controller, "create_nodes"), "模型应调用 create_nodes 工具");
        assertTrue(model.nodes().size() >= 3, "工作台应至少有 3 个节点，实际 " + model.nodes().size());
    }

    @Test
    void identifiesCurrentProject() throws Exception {
        AgentConfig config = loadConfig();
        assumeTrue(config.isConfigured(), "未配置 Agent API（baseUrl/apiKey），跳过真实模型冒烟");
        WorkflowModel model = new WorkflowModel();
        Path projectRoot = Path.of(System.getProperty("user.dir", "."));
        AgentChatController controller = controller(projectRoot, model, config);
        controller.sendMessage(
                "请用 project_info 工具识别当前项目的构建系统与入口，完成后用中文总结。", events -> {});
        awaitIdle(controller, 240_000);

        assertTrue(called(controller, "project_info"), "模型应调用 project_info 工具");
    }
}
