/*
 * Decompiled with CFR 0.152.
 */
package local.codenode.agent.tools;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;
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

    public boolean confirm(String message) {
        return this.confirmation == null || this.confirmation.confirm(message);
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

    @FunctionalInterface
    public static interface ConfirmationHandler {
        public boolean confirm(String var1);
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
}
