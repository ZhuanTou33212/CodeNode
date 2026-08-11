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
import local.codenode.agent.SoftwareInfoProvider;
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
    private final AtomicBoolean toolStopRequested = new AtomicBoolean(false);
    private final PermissionMemory permissionMemory = new PermissionMemory();
    private final AgentResultStore resultStore = new AgentResultStore();

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
        return this.confirmation == null || this.confirmation.confirm(ConfirmationLevel.WRITE, message, "");
    }

    /**
     * 分级确认：仅高风险（delete/execute/git 危险命令/跨目录/超出请求范围）需要用户确认；
     * 低风险（项目内 write_file 等）默认放行。确认文案用自然语言解释"在做什么"。
     */
    public boolean confirm(ConfirmationLevel level, String what, String detail) {
        if (this.confirmation == null) {
            return true;
        }
        return this.confirmation.confirm(level, what, detail);
    }

    /** Confirm once per session for a stable tool/action signature. */
    public boolean confirmRemembered(ConfirmationLevel level, String what, String detail, String signature) {
        Boolean remembered = permissionMemory.get(signature);
        if (remembered != null) return remembered;
        boolean allowed = confirm(level, what, detail);
        if (allowed) permissionMemory.remember(signature, true);
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
        this.uiAction.perform(action, arguments);
        return true;
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
        public void perform(String var1, Map<String, Object> var2);
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
    public void requestToolStop() { toolStopRequested.set(true); }
    public void clearToolStop() { toolStopRequested.set(false); }
    public boolean toolStopRequested() { return toolStopRequested.get(); }
    public PermissionMemory permissionMemory() { return permissionMemory; }
    public AgentResultStore resultStore() { return resultStore; }

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
        /** 高风险：执行外部命令、删除、git 危险操作、跨目录、超出用户请求范围——必须确认。 */
        HIGH
    }
}
