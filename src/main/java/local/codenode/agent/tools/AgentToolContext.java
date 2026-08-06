package local.codenode.agent.tools;

import java.nio.file.Path;
import java.util.function.Supplier;

/**
 * 工具执行上下文：提供项目根目录、当前工作台模型、高危操作确认回调与审计日志。
 * write_file / execute_shell 每次执行前必须经 confirmation 确认。
 */
public final class AgentToolContext {
    private final Supplier<Path> projectRootSupplier;
    private final Supplier<local.codenode.WorkflowModel> modelSupplier;
    private final ConfirmationHandler confirmation;
    private final AuditLogger audit;
    private final WorkbenchApplier workbenchApplier;
    private final java.util.function.Consumer<WorkbenchMutator> workbenchMutator;
    private final Runnable saveAction;
    private final Runnable undoAction;
    private final Runnable redoAction;
    private QuestionHandler questionHandler;

    @FunctionalInterface
    public interface ConfirmationHandler {
        boolean confirm(String message);
    }

    @FunctionalInterface
    public interface AuditLogger {
        void log(String entry);
    }

    /** 将符合项目结构的生成图原生写入工作台（必须由调用方切到 Swing EDT 后再变更模型）。 */
    @FunctionalInterface
    public interface WorkbenchApplier {
        void applyToWorkbench(local.codenode.WorkflowModel generated);
    }

    /** 在当前工作台模型上执行一次变更（增删节点/连线等），由调用方保证 EDT 线程安全。 */
    @FunctionalInterface
    public interface WorkbenchMutator {
        void mutate(local.codenode.WorkflowModel model);
    }

    /** 向用户提问（ask_user 工具）：返回用户回答文本，取消返回 null/空。 */
    @FunctionalInterface
    public interface QuestionHandler {
        String ask(String question, java.util.List<String> options);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier,
                            Supplier<local.codenode.WorkflowModel> modelSupplier,
                            ConfirmationHandler confirmation, AuditLogger audit) {
        this(projectRootSupplier, modelSupplier, confirmation, audit, null, null, null, null, null);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier,
                            Supplier<local.codenode.WorkflowModel> modelSupplier,
                            ConfirmationHandler confirmation, AuditLogger audit,
                            WorkbenchApplier workbenchApplier) {
        this(projectRootSupplier, modelSupplier, confirmation, audit, workbenchApplier, null, null, null, null);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier,
                            Supplier<local.codenode.WorkflowModel> modelSupplier,
                            ConfirmationHandler confirmation, AuditLogger audit,
                            WorkbenchApplier workbenchApplier,
                            java.util.function.Consumer<WorkbenchMutator> workbenchMutator) {
        this(projectRootSupplier, modelSupplier, confirmation, audit, workbenchApplier, workbenchMutator, null, null, null);
    }

    public AgentToolContext(Supplier<Path> projectRootSupplier,
                            Supplier<local.codenode.WorkflowModel> modelSupplier,
                            ConfirmationHandler confirmation, AuditLogger audit,
                            WorkbenchApplier workbenchApplier,
                            java.util.function.Consumer<WorkbenchMutator> workbenchMutator,
                            Runnable saveAction, Runnable undoAction, Runnable redoAction) {
        this.projectRootSupplier = projectRootSupplier == null ? () -> Path.of(".") : projectRootSupplier;
        this.modelSupplier = modelSupplier == null ? () -> null : modelSupplier;
        this.confirmation = confirmation;
        this.audit = audit;
        this.workbenchApplier = workbenchApplier;
        this.workbenchMutator = workbenchMutator;
        this.saveAction = saveAction;
        this.undoAction = undoAction;
        this.redoAction = redoAction;
    }

    public Path projectRoot() {
        Path root = projectRootSupplier.get();
        return root == null ? Path.of(".") : root;
    }

    public local.codenode.WorkflowModel model() {
        return modelSupplier.get();
    }

    public boolean confirm(String message) {
        return confirmation == null || confirmation.confirm(message);
    }

    public void audit(String entry) {
        if (audit != null) audit.log(entry);
    }

    public WorkbenchApplier workbenchApplier() {
        return workbenchApplier;
    }

    /** 在工作台上执行一次变更（增删节点等），无变更器时静默跳过。 */
    public void mutateWorkbench(WorkbenchMutator mutator) {
        if (workbenchMutator != null && mutator != null) workbenchMutator.accept(mutator);
    }

    /** 保存当前工程（无保存动作时静默）。 */
    public void saveProject() {
        if (saveAction != null) saveAction.run();
    }

    /** 撤销（无动作时静默）。 */
    public void undo() {
        if (undoAction != null) undoAction.run();
    }

    /** 重做（无动作时静默）。 */
    public void redo() {
        if (redoAction != null) redoAction.run();
    }

    /** 注册向用户提问的回调（ask_user 工具使用）。 */
    public void setQuestionHandler(QuestionHandler handler) {
        this.questionHandler = handler;
    }

    /** 向用户提问；无回调或用户取消时返回空字符串。 */
    public String askUser(String question, java.util.List<String> options) {
        if (questionHandler == null) return "";
        return questionHandler.ask(question, options);
    }
}
