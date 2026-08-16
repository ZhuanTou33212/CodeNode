package local.codenode.agent;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 会话级可变状态：工具停止标志与权限确认记忆。
 *
 * <p>每个 {@code AgentChatController} 持有自己的 scope，工具执行时通过
 * {@code AgentToolContext.setSessionScope} 绑定到当前工作线程。这样多对话 tab
 * 并行时，一个 tab 的“停止”只取消该 tab 正在执行的工具，权限确认记忆也不
 * 会在 tab 之间泄漏。</p>
 */
public final class AgentSessionScope {
    private final AtomicBoolean toolStopRequested = new AtomicBoolean(false);
    private final PermissionMemory permissionMemory = new PermissionMemory();
    /** 会话级 token 预算（防失控循环超额消耗；limit=0 不限）。 */
    private final TokenBudget budget = new TokenBudget();

    public void requestToolStop() {
        toolStopRequested.set(true);
    }

    public void clearToolStop() {
        toolStopRequested.set(false);
    }

    public boolean toolStopRequested() {
        return toolStopRequested.get();
    }

    public PermissionMemory permissionMemory() {
        return permissionMemory;
    }

    public TokenBudget budget() {
        return budget;
    }
}
