package local.codenode.agent;

import local.codenode.agent.tools.AgentToolContext;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P0 并发隔离：共享 AgentToolContext 时，各会话（tab）的工具停止标志与权限确认记忆互不影响。
 */
class AgentSessionScopeTest {

    private static AgentToolContext newContext() {
        return new AgentToolContext(() -> Path.of("."), () -> null, (level, what, detail) -> true, entry -> {});
    }

    @Test
    void scopesAreIndependent() {
        AgentSessionScope a = new AgentSessionScope();
        AgentSessionScope b = new AgentSessionScope();
        a.requestToolStop();
        assertTrue(a.toolStopRequested());
        assertFalse(b.toolStopRequested());
        b.requestToolStop();
        a.clearToolStop();
        assertFalse(a.toolStopRequested());
        assertTrue(b.toolStopRequested());
    }

    @Test
    void contextDelegatesToThreadBoundScope() throws Exception {
        AgentToolContext context = newContext();
        AgentSessionScope scopeA = new AgentSessionScope();
        AgentSessionScope scopeB = new AgentSessionScope();
        CountDownLatch done = new CountDownLatch(2);
        AtomicBoolean aSeesStop = new AtomicBoolean();
        AtomicBoolean bSeesStop = new AtomicBoolean();
        Thread ta = new Thread(() -> {
            context.setSessionScope(scopeA);
            context.requestToolStop();
            aSeesStop.set(context.toolStopRequested());
            context.setSessionScope(null);
            done.countDown();
        });
        Thread tb = new Thread(() -> {
            context.setSessionScope(scopeB);
            try { Thread.sleep(100); } catch (InterruptedException ignored) {}
            bSeesStop.set(context.toolStopRequested());
            context.setSessionScope(null);
            done.countDown();
        });
        ta.start();
        tb.start();
        done.await();
        assertTrue(aSeesStop.get(), "绑定 scopeA 的线程应看到停止标志");
        assertFalse(bSeesStop.get(), "绑定 scopeB 的线程不应受 scopeA 停止影响");
    }

    @Test
    void permissionMemoryIsIsolatedPerScope() throws Exception {
        AgentToolContext context = newContext();
        AgentSessionScope scopeA = new AgentSessionScope();
        AgentSessionScope scopeB = new AgentSessionScope();
        AtomicBoolean bSees = new AtomicBoolean(false);
        CountDownLatch done = new CountDownLatch(1);
        Thread tb = new Thread(() -> {
            context.setSessionScope(scopeB);
            bSees.set(context.permissionMemory().get("sig:1") != null);
            context.setSessionScope(null);
            done.countDown();
        });
        context.setSessionScope(scopeA);
        context.permissionMemory().remember("sig:1", true);
        assertTrue(context.permissionMemory().get("sig:1"));
        context.setSessionScope(null);
        tb.start();
        done.await();
        assertFalse(bSees.get(), "另一会话不应看到本会话的权限记忆");
    }

    @Test
    void unboundThreadUsesSharedFallback() {
        AgentToolContext context = newContext();
        assertFalse(context.toolStopRequested());
        context.requestToolStop();
        assertTrue(context.toolStopRequested());
        context.clearToolStop();
        assertFalse(context.toolStopRequested());
    }
}
