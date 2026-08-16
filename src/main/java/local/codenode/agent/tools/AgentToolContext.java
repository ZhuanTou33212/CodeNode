/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.concurrent.atomic.AtomicBoolean;
import local.codenode.agent.PermissionMemory;
import local.codenode.agent.AgentResultStore;
import local.codenode.agent.AgentSessionScope;
import local.codenode.agent.MemoryStore;
import local.codenode.agent.SoftwareInfoProvider;
import local.codenode.agent.knowledge.KnowledgeGraph;
import local.codenode.agent.TaskManager;
import local.codenode.agent.SubagentManager;
import local.codenode.WorkflowModel;

public final class AgentToolContext {
    private final Supplier<Path> projectRootSupplier;
    private final Supplier<WorkflowModel> modelSupplier;
    private final ConfirmationHandler confirmation;
    private final AuditLogger audit;
    private final WorkbenchApplier workbenchApplier;
    private final Consumer<WorkbenchMutator> workbenchMutator;
    private final Runnable saveAction;
    private final Runnable undoAction;
    private final Runnable redoAction;
    private final UiAction uiAction;
    private QuestionHandler questionHandler;
    private Supplier<List<Map<String, Object>>> conversationSupplier;
    private FileChangeNotifier fileChangeNotifier;
    private SoftwareInfoProvider softwareInfoProvider;
    private java.util.function.Supplier<String> permissionSupplier = () -> "";
    /** 会话级可变状态（ThreadLocal 绑定）：工具停止标志与权限确认记忆，按对话 tab 隔离。 */
    private final ThreadLocal<AgentSessionScope> sessionScope = new ThreadLocal<>();
    /** 无会话绑定时的共享兜底（如 MCP bridge 等非会话场景）。 */
    private final AtomicBoolean sharedToolStopRequested = new AtomicBoolean(false);
    private final PermissionMemory sharedPermissionMemory = new PermissionMemory();
    private volatile boolean rememberApprovals = true;
    private final AgentResultStore resultStore = new AgentResultStore();
    private final MemoryStore memoryStore = new MemoryStore();
    private Supplier<KnowledgeGraph> knowledgeGraphSupplier = KnowledgeGraph::new;
    private Supplier<TaskManager> taskManagerSupplier = TaskManager::new;
    private final ThreadLocal<SubagentManager> subagentManager = new ThreadLocal<>();

    public AgentToolContext(Supplier<Path> projectRootSupplier, Supplier<WorkflowModel> modelSupplier, ConfirmationHandler confirmation, AuditLogger audit) {
        this(projectRootSupplier, modelSupplier, confirmation, audit, null, null, null, null, null);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier, Supplier<WorkflowModel> modelSupplier, ConfirmationHandler confirmation, AuditLogger audit, WorkbenchApplier workbenchApplier) {
        this(projectRootSupplier, modelSupplier, confirmation, audit, workbenchApplier, null, null, null, null);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier, Supplier<WorkflowModel> modelSupplier, ConfirmationHandler confirmation, AuditLogger audit, WorkbenchApplier workbenchApplier, Consumer<WorkbenchMutator> workbenchMutator) {
        this(projectRootSupplier, modelSupplier, confirmation, audit, workbenchApplier, workbenchMutator, null, null, null);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier, Supplier<WorkflowModel> modelSupplier, ConfirmationHandler confirmation, AuditLogger audit, WorkbenchApplier workbenchApplier, Consumer<WorkbenchMutator> workbenchMutator, Runnable saveAction, Runnable undoAction, Runnable redoAction) {
        this(projectRootSupplier, modelSupplier, confirmation, audit, workbenchApplier, workbenchMutator, saveAction, undoAction, redoAction, null);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier, Supplier<WorkflowModel> modelSupplier, ConfirmationHandler confirmation, AuditLogger audit, WorkbenchApplier workbenchApplier, Consumer<WorkbenchMutator> workbenchMutator, Runnable saveAction, Runnable undoAction, Runnable redoAction, UiAction uiAction) {
        this.projectRootSupplier = projectRootSupplier == null ? () -> Path.of(".", new String[0]) : projectRootSupplier;
        this.modelSupplier = modelSupplier == null ? () -> null : modelSupplier;
        this.confirmation = confirmation;
        this.audit = audit;
        this.workbenchApplier = workbenchApplier;
        this.workbenchMutator = workbenchMutator;
        this.saveAction = saveAction;
        this.undoAction = undoAction;
        this.redoAction = redoAction;
        this.uiAction = uiAction;
    }

    public Path projectRoot() {
        Path root = this.projectRootSupplier.get();
        return root == null ? Path.of(".", new String[0]) : root;
    }

    public WorkflowModel model() {
        return this.modelSupplier.get();
    }
    public WorkflowModel snapshotWorkbench() {
        WorkflowModel current = model();
        return current == null ? null : current.deepCopy();
    }

    public void restoreWorkbench(WorkflowModel snapshot) {
        if (snapshot != null && this.workbenchApplier != null) {
            this.workbenchApplier.applyToWorkbench(snapshot.deepCopy());
        }
    }

    /** 请求用户确认（旧签名，低风险默认询问）。 */
    public boolean confirm(String message) {
        if (this.confirmation == null) {
            audit("确认处理器缺失，默认拒绝（fail-closed）：" + message);
            return false;
        }
        return this.confirmation.confirm(ConfirmationLevel.WRITE, message, "");
    }

    /**
     * 分级确认：仅高风险（delete/execute/git 危险命令/跨目录/超出请求范围）需要用户确认；
     * 低风险（项目内 write_file 等）默认放行。确认文案用自然语言解释"在做什么"。
     */
    public boolean confirm(ConfirmationLevel level, String what, String detail) {
        if (!systemEnabled()) return false;
        String category = switch (level) {
            case UI -> "ui";
            case WRITE -> "write";
            case HIGH -> "execute";
            case LOW -> "read";
        };
        String mode = permissionMode(category);
        if (mode.matches("deny|disabled|off")) return false;
        if (mode.matches("allow|enabled") || level == ConfirmationLevel.LOW) return true;
        String signature = PermissionMemory.signature(projectRoot().toAbsolutePath().normalize() + "|" + category + ":" + level, what + "\n" + detail);
        if (rememberApprovals) {
            Boolean remembered = permissionMemory().get(signature);
            if (remembered != null) return remembered;
        }
        if (this.confirmation == null) {
            // fail-closed：无确认处理器时拒绝而非放行（原实现 null 直接放行）
            audit("确认处理器缺失，默认拒绝（fail-closed）：level=" + level + " what=" + what);
            return false;
        }
        boolean allowed = this.confirmation.confirm(level, what, detail);
        if (rememberApprovals) permissionMemory().remember(signature, allowed);
        return allowed;
    }

    public void setPermissionSupplier(java.util.function.Supplier<String> supplier) { this.permissionSupplier = supplier == null ? () -> "" : supplier; }
    private String permissionMode(String category) {
        String raw = permissionSupplier.get();
        if (raw == null || raw.isBlank()) return "";
        for (String item : raw.split(",")) { String[] pair = item.trim().split(":", 2); if (pair.length == 2 && pair[0].trim().equalsIgnoreCase(category)) return pair[1].trim().toLowerCase(java.util.Locale.ROOT); }
        return "";
    }
    /**
     * 权限类别是否放行（fail-closed）：
     * <ul>
     *   <li>配置完全为空时仅 {@code system} 总开关默认开启（逃生门语义），其余类别一律拒绝；</li>
     *   <li>类别未在配置中声明时默认拒绝（deny-by-default）并记审计——配置漏写不再静默放行；</li>
     *   <li>显式声明 allow/enabled/confirm 才放行。</li>
     * </ul>
     */
    public boolean permissionAllowed(String category) {
        String raw = permissionSupplier.get();
        if (raw == null || raw.isBlank()) return "system".equalsIgnoreCase(category);
        for (String item : raw.split(",")) { String[] pair = item.trim().split(":", 2); if (pair.length == 2 && pair[0].trim().equalsIgnoreCase(category)) { String value = pair[1].trim().toLowerCase(java.util.Locale.ROOT); return value.equals("allow") || value.equals("enabled") || value.equals("confirm"); } }
        audit("权限类别未配置，默认拒绝（deny-by-default）：category=" + category);
        return false;
    }

    /**
     * 系统总开关：仅显式 {@code system:deny/disabled/off} 才关闭；
     * 未声明 system 时默认开启（逃生门语义，与类别授权的 fail-closed 正交——
     * 用户只声明了 ui/write 等类别时不应被隐式当作总开关关闭）。
     */
    public boolean systemEnabled() {
        String raw = permissionSupplier.get();
        if (raw == null || raw.isBlank()) return true;
        for (String item : raw.split(",")) {
            String[] pair = item.trim().split(":", 2);
            if (pair.length == 2 && pair[0].trim().equalsIgnoreCase("system")) {
                String value = pair[1].trim().toLowerCase(java.util.Locale.ROOT);
                return value.equals("allow") || value.equals("enabled") || value.equals("confirm");
            }
        }
        return true;
    }

    /** Confirm once per session for a stable tool/action signature. */
    public boolean confirmRemembered(ConfirmationLevel level, String what, String detail, String signature) {
        Boolean remembered = permissionMemory().get(signature);
        if (remembered != null) return remembered;
        boolean allowed = confirm(level, what, detail);
        if (allowed) permissionMemory().remember(signature, true);
        return allowed;
    }
    public void audit(String entry) {
        if (this.audit != null) {
            this.audit.log(entry);
        }
    }

    public WorkbenchApplier workbenchApplier() {
        return this.workbenchApplier;
    }

    public void mutateWorkbench(WorkbenchMutator mutator) {
        if (this.workbenchMutator != null && mutator != null) {
            this.workbenchMutator.accept(mutator);
        }
    }

    public void saveProject() {
        if (this.saveAction != null) {
            this.saveAction.run();
        }
    }

    public void undo() {
        if (this.undoAction != null) {
            this.undoAction.run();
        }
    }

    public void redo() {
        if (this.redoAction != null) {
            this.redoAction.run();
        }
    }

    public void setQuestionHandler(QuestionHandler handler) {
        this.questionHandler = handler;
    }

    public String askUser(String question, List<String> options) {
        if (this.questionHandler == null) {
            return "";
        }
        return this.questionHandler.ask(question, options);
    }

    public boolean ui(String action, Map<String, Object> arguments) {
        if (this.uiAction == null || action == null || action.isBlank()) {
            return false;
        }
        try {
            if (javax.swing.SwingUtilities.isEventDispatchThread()) {
                return this.uiAction.perform(action, arguments);
            } else {
                java.util.concurrent.atomic.AtomicReference<RuntimeException> failure = new java.util.concurrent.atomic.AtomicReference<>();
                java.util.concurrent.atomic.AtomicBoolean applied = new java.util.concurrent.atomic.AtomicBoolean(false);
                javax.swing.SwingUtilities.invokeAndWait(() -> {
                    try { applied.set(this.uiAction.perform(action, arguments)); }
                    catch (RuntimeException e) { failure.set(e); }
                });
                if (failure.get() != null) throw failure.get();
                return applied.get();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception e) {
            audit("ui_control failed action=" + action + " error=" + e.getMessage());
            return false;
        }
    }

    /** 设置会话消息历史提供者（供总结等工具读取）。 */
    public void setConversationSupplier(Supplier<List<Map<String, Object>>> conversationSupplier) {
        this.conversationSupplier = conversationSupplier;
    }

    /** 获取会话消息历史（最近消息），用于总结/分析；未设置时返回空。 */
    public List<Map<String, Object>> conversationHistory() {
        if (this.conversationSupplier == null) {
            return List.of();
        }
        List<Map<String, Object>> history = this.conversationSupplier.get();
        return history == null ? List.of() : List.copyOf(history);
    }

    /** 设置文件变更通知（Agent 写/改文件后回调，驱动文件变更面板刷新）。 */
    public void setFileChangeNotifier(FileChangeNotifier notifier) {
        this.fileChangeNotifier = notifier;
    }

    /** 通知文件变更（写/改/删文件后调用）。 */
    public void notifyFileChange(String relative, String kind, String detail) {
        if (this.fileChangeNotifier != null) {
            this.fileChangeNotifier.onChange(relative, kind, detail);
        }
    }

    @FunctionalInterface
    public static interface ConfirmationHandler {
        public boolean confirm(ConfirmationLevel var1, String var2, String var3);
    }

    @FunctionalInterface
    public static interface AuditLogger {
        public void log(String var1);
    }

    @FunctionalInterface
    public static interface WorkbenchApplier {
        public void applyToWorkbench(WorkflowModel var1);
    }

    @FunctionalInterface
    public static interface UiAction {
        public boolean perform(String var1, Map<String, Object> var2);
    }

    @FunctionalInterface
    public static interface QuestionHandler {
        public String ask(String var1, List<String> var2);
    }

    @FunctionalInterface
    public static interface WorkbenchMutator {
        public void mutate(WorkflowModel var1);
    }

    public void setSoftwareInfoProvider(SoftwareInfoProvider provider) { this.softwareInfoProvider = provider; }
    public SoftwareInfoProvider softwareInfoProvider() { return softwareInfoProvider; }

    /** 绑定当前线程的会话作用域（工具执行前由 controller 设置，执行后置空）。 */
    public void setSessionScope(AgentSessionScope scope) {
        if (scope == null) sessionScope.remove(); else sessionScope.set(scope);
    }

    /**
     * 在指定会话作用域下执行动作（P2-8 显式参数化）：执行期间绑定 scope 到当前线程，
     * 结束后恢复原绑定。MCP bridge 等跨线程调用点通过它显式传递调用方的 scope，
     * 不再依赖「恰好运行在已绑定线程」的隐式假设。
     */
    public <T> T runWithScope(AgentSessionScope scope, java.util.function.Supplier<T> action) {
        if (scope == null) return action.get();
        AgentSessionScope previous = sessionScope.get();
        sessionScope.set(scope);
        try {
            return action.get();
        } finally {
            if (previous != null) sessionScope.set(previous);
            else sessionScope.remove();
        }
    }

    /** 当前线程绑定的会话作用域；未绑定时返回 null（调用方使用共享兜底）。 */
    public AgentSessionScope sessionScope() {
        return sessionScope.get();
    }

    public void requestToolStop() {
        AgentSessionScope scope = sessionScope.get();
        if (scope != null) scope.requestToolStop(); else sharedToolStopRequested.set(true);
    }
    public void clearToolStop() {
        AgentSessionScope scope = sessionScope.get();
        if (scope != null) scope.clearToolStop(); else sharedToolStopRequested.set(false);
    }
    public boolean toolStopRequested() {
        AgentSessionScope scope = sessionScope.get();
        return scope != null ? scope.toolStopRequested() : sharedToolStopRequested.get();
    }

    /** 当前作用域（或共享兜底）的权限确认记忆。 */
    public PermissionMemory permissionMemory() {
        AgentSessionScope scope = sessionScope.get();
        return scope != null ? scope.permissionMemory() : sharedPermissionMemory;
    }
    public void setRememberApprovals(boolean remember) { this.rememberApprovals = remember; if (!remember) sharedPermissionMemory.clear(); }
    public boolean rememberApprovals() { return rememberApprovals; }
    public AgentResultStore resultStore() { return resultStore; }
    /** Project-local durable Markdown memory plus a transient cache. */
    public MemoryStore memoryStore() {
        try { memoryStore.bind(projectRoot()); }
        catch (java.io.IOException failure) { throw new IllegalStateException("本地记忆初始化失败：" + failure.getMessage(), failure); }
        return memoryStore;
    }
    public void closeMemoryStore() { memoryStore.close(); }
    public void setKnowledgeGraphSupplier(Supplier<KnowledgeGraph> supplier) {
        this.knowledgeGraphSupplier = supplier == null ? KnowledgeGraph::new : supplier;
    }
    public KnowledgeGraph knowledgeGraph() {
        KnowledgeGraph graph = knowledgeGraphSupplier.get();
        return graph == null ? new KnowledgeGraph() : graph;
    }

    public void setTaskManagerSupplier(Supplier<TaskManager> supplier) {
        this.taskManagerSupplier = supplier == null ? TaskManager::new : supplier;
    }
    public TaskManager taskManager() {
        TaskManager manager = taskManagerSupplier.get();
        return manager == null ? new TaskManager() : manager;
    }

    /** The owning controller binds this per worker thread so subagents stay isolated by chat tab. */
    public void setSubagentManager(SubagentManager manager) {
        if (manager == null) subagentManager.remove(); else subagentManager.set(manager);
    }
    public SubagentManager subagentManager() { return subagentManager.get(); }

    /** 文件变更通知器（Agent 写/改/删文件后回调）。 */
    @FunctionalInterface
    public static interface FileChangeNotifier {
        public void onChange(String var1, String var2, String var3);
    }

    /** 确认级别：低风险直接放行，高风险需用户确认。 */
    public enum ConfirmationLevel {
        /** 低风险：项目内常规操作，直接放行，不询问。 */
        LOW,
        /** 中风险：写入/修改文件（项目内），默认放行但记录。 */
        WRITE,
        /** UI 操作：受 agent.permissions 的 ui 开关控制。 */
        UI,
        /** 高风险：执行外部命令、删除、git 危险操作、跨目录、超出用户请求范围——必须确认。 */
        HIGH
    }
}
