package local.codenode.agent.cordis;

import local.codenode.agent.tools.AgentToolContext;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Adapter that exposes the existing application UI callbacks as a Cordis service. */
public final class AgentUiBridge implements UiBridge {
    private final AgentToolContext context;

    public AgentUiBridge(AgentToolContext context) {
        this.context = Objects.requireNonNull(context, "context");
    }

    @Override public String askUser(String question, List<String> options) { return context.askUser(question, options); }
    @Override public boolean control(String action, Map<String, Object> arguments) { return context.ui(action, arguments); }
    @Override public void audit(String message) { context.audit(message); }
}
