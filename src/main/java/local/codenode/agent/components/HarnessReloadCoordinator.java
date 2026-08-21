package local.codenode.agent.components;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentSessionManager;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.config.AgentConfig;

import java.util.List;
import java.util.Objects;

/** Transactional profile reload coordinator for the desktop Agent sessions. */
public final class HarnessReloadCoordinator {
    private final AgentSessionManager sessions;
    private final AgentToolContext toolContext;
    private AgentConfig activeConfig;
    private HarnessComponents activeHarness;

    public HarnessReloadCoordinator(AgentConfig activeConfig, HarnessComponents activeHarness,
                                     AgentSessionManager sessions, AgentToolContext toolContext) {
        this.activeConfig = Objects.requireNonNull(activeConfig, "activeConfig");
        this.activeHarness = Objects.requireNonNull(activeHarness, "activeHarness");
        this.sessions = Objects.requireNonNull(sessions, "sessions");
        this.toolContext = Objects.requireNonNull(toolContext, "toolContext");
    }

    /**
     * Stages configuration and a complete new Harness composition before changing
     * any live session. Active sessions continue using the old composition until idle.
     */
    public synchronized ReloadResult reload() {
        AgentConfig stagedConfig = new AgentConfig(activeConfig.file());
        stagedConfig.reload();
        HarnessComponents stagedHarness;
        try {
            stagedHarness = HarnessAssembler.assembleDefaults(stagedConfig, toolContext);
        } catch (RuntimeException failure) {
            throw new IllegalStateException("Harness reload staging failed; active runtime unchanged", failure);
        }
        HarnessComponents previousHarness = activeHarness;
        AgentSessionManager.ReloadReport report;
        try {
            report = sessions.requestHarnessReload(
                    () -> new AgentChatController(stagedConfig, stagedHarness),
                    previousHarness::close);
        } catch (RuntimeException failure) {
            stagedHarness.close();
            throw new IllegalStateException("Harness reload commit failed; active runtime unchanged", failure);
        }
        activeConfig = stagedConfig;
        activeHarness = stagedHarness;
        return new ReloadResult(report, stagedConfig.appliedHarnessConfigFiles(), stagedConfig.harnessConfigWarnings());
    }

    public synchronized AgentConfig activeConfig() { return activeConfig; }
    public synchronized HarnessComponents activeHarness() { return activeHarness; }

    public record ReloadResult(AgentSessionManager.ReloadReport sessions,
                               List<java.nio.file.Path> appliedConfigFiles,
                               List<String> warnings) {
        public ReloadResult {
            appliedConfigFiles = appliedConfigFiles == null ? List.of() : List.copyOf(appliedConfigFiles);
            warnings = warnings == null ? List.of() : List.copyOf(warnings);
        }
    }
}
