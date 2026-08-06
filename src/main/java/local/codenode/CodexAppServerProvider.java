package local.codenode;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.function.Consumer;

/**
 * Runs controlled Codex App Server turns over stdio. Stage4.5 线程化多轮会话：
 * 维护 {@code activeThreads: Map<sessionId, ThreadSession>}，请求通过自增 id 关联响应回调，
 * 支持 startThread / startTurn / submitToolResult / cancel / releaseThread。
 * 既有单次申请流程 start(...) 保持兼容（作为 legacy 会话）。
 */
final class CodexAppServerProvider implements AgentProvider {
    private final String executable;
    private final ExecutorService io = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "codenode-agent-io");
        thread.setDaemon(true);
        return thread;
    });
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "codenode-agent-timeout");
        thread.setDaemon(true);
        return thread;
    });
    private final long timeoutMinutes = Math.max(1, Long.getLong("codenode.agent.timeout.minutes", 30));
    private final Object lock = new Object();
    private final java.util.concurrent.atomic.AtomicLong idCounter = new java.util.concurrent.atomic.AtomicLong(1);
    private final Map<Long, Consumer<Map<String, Object>>> pending = new HashMap<>();
    private final Map<String, ThreadSession> activeThreads = new HashMap<>();

    private Process process;
    private BufferedWriter writer;
    private ThreadSession legacySession;
    private Path projectRoot = Path.of(System.getProperty("user.dir", "."));
    private ScheduledFuture<?> timeoutTask;
    private Consumer<String> events = ignored -> {};

    CodexAppServerProvider() {
        this(System.getProperty("codenode.codex.executable", System.getenv().getOrDefault("CODEX_EXECUTABLE", "codex")));
    }

    CodexAppServerProvider(String executable) {
        this.executable = Objects.requireNonNull(executable);
    }

    void setProjectRoot(Path root) {
        if (root != null) projectRoot = root.toAbsolutePath().normalize();
    }

    private static final class ThreadSession {
        final String sessionId;
        final Path projectRoot;
        volatile String threadId = "";
        volatile String turnId = "";
        volatile AgentProvider.SessionState state = AgentProvider.SessionState.IDLE;
        volatile Consumer<String> events = ignored -> {};

        ThreadSession(String sessionId, Path projectRoot) {
            this.sessionId = sessionId;
            this.projectRoot = projectRoot;
        }
    }

    // ---------- 会话生命周期门面 ----------

    @Override
    public AgentProvider.SessionState sessionState() {
        synchronized (lock) {
            if (activeThreads.isEmpty()) return AgentProvider.SessionState.IDLE;
            for (ThreadSession session : activeThreads.values()) {
                if (session.state == AgentProvider.SessionState.ACTIVE_RUNNING) return AgentProvider.SessionState.ACTIVE_RUNNING;
            }
            return AgentProvider.SessionState.ACTIVE_IDLE;
        }
    }

    @Override
    public String startSession(String systemPrompt) throws IOException {
        Path root = projectRoot;
        ensureProcess(root);
        final String sessionId = "session-" + UUID.randomUUID();
        final ThreadSession session = new ThreadSession(sessionId, root);
        synchronized (lock) { activeThreads.put(sessionId, session); }
        long id = idCounter.getAndIncrement();
        synchronized (lock) {
            pending.put(id, response -> {
                Object result = response.get("result");
                if (result instanceof Map<?, ?> rm && rm.get("thread") instanceof Map<?, ?> tm) {
                    session.threadId = String.valueOf(tm.get("id"));
                }
                if (session.threadId.isBlank() || "null".equals(session.threadId)) {
                    session.events.accept("App Server 未返回 threadId");
                } else {
                    session.state = AgentProvider.SessionState.ACTIVE_IDLE;
                }
            });
        }
        send(AppServerMessages.startThreadRequest(id, root));
        return sessionId;
    }

    @Override
    public void sendTurn(String sessionId, String userMessage, Consumer<String> eventSink) throws IOException {
        ThreadSession session = requireSession(sessionId);
        if (session.state != AgentProvider.SessionState.ACTIVE_IDLE && session.state != AgentProvider.SessionState.IDLE) {
            throw new IllegalStateException("会话不在可发送状态：" + session.state);
        }
        session.events = eventSink == null ? ignored -> {} : eventSink;
        session.state = AgentProvider.SessionState.ACTIVE_RUNNING;
        final long id = idCounter.getAndIncrement();
        synchronized (lock) {
            pending.put(id, response -> {
                if (response.get("result") instanceof Map<?, ?> rm && rm.get("turn") instanceof Map<?, ?> tm) {
                    session.turnId = String.valueOf(tm.get("id"));
                }
                session.events.accept("Codex Agent 回合已开始");
            });
        }
        send(AppServerMessages.startTurnRequest(id, session.threadId, session.projectRoot, userMessage, "", null));
    }

    @Override
    public void submitToolResult(String sessionId, String toolCallId, String jsonResult) throws IOException {
        ThreadSession session = requireSession(sessionId);
        session.state = AgentProvider.SessionState.ACTIVE_RUNNING;
        String message = "工具调用 " + toolCallId + " 返回结果：\n" + jsonResult;
        final long id = idCounter.getAndIncrement();
        synchronized (lock) {
            pending.put(id, response -> {
                if (response.get("result") instanceof Map<?, ?> rm && rm.get("turn") instanceof Map<?, ?> tm) {
                    session.turnId = String.valueOf(tm.get("id"));
                }
                session.state = AgentProvider.SessionState.ACTIVE_IDLE;
            });
        }
        send(AppServerMessages.startTurnRequest(id, session.threadId, session.projectRoot, message, "", null));
    }

    @Override
    public void cancelCurrentSession() {
        ThreadSession active;
        synchronized (lock) {
            active = activeThreads.values().stream()
                    .filter(s -> s.state == AgentProvider.SessionState.ACTIVE_RUNNING)
                    .findFirst().orElse(null);
        }
        if (active == null) return;
        active.state = AgentProvider.SessionState.ACTIVE_CANCELLED;
        try {
            send(AppServerMessages.cancelRequest(idCounter.getAndIncrement(), active.threadId, active.turnId));
        } catch (IOException ignored) {}
        active.state = AgentProvider.SessionState.IDLE;
    }

    /** 释放线程（内部会话名与 releaseThread 一致）。 */
    public void releaseThread(String sessionId) {
        synchronized (lock) { activeThreads.remove(sessionId); }
    }

    @Override
    public void closeSession(String sessionId) {
        releaseThread(sessionId);
    }

    private ThreadSession requireSession(String sessionId) {
        synchronized (lock) {
            ThreadSession session = activeThreads.get(sessionId);
            if (session == null) throw new IllegalStateException("会话不存在：" + sessionId);
            return session;
        }
    }

    // ---------- 既有单次申请流程 ----------

    @Override
    public void start(Path projectRoot, Path requestDirectory, Consumer<String> eventSink) throws IOException {
        synchronized (lock) {
            if (running()) throw new IllegalStateException("已有 Codex Agent 申请正在处理");
            events = eventSink == null ? ignored -> {} : eventSink;
            this.projectRoot = projectRoot.toAbsolutePath().normalize();
            final ThreadSession session = new ThreadSession("legacy", this.projectRoot);
            session.events = events;
            session.state = AgentProvider.SessionState.ACTIVE_RUNNING;
            legacySession = session;
            synchronized (lock) { activeThreads.put("legacy", session); }
            timeoutTask = timer.schedule(() -> {
                if (!running()) return;
                events.accept("Codex Agent 处理超时，已中止本次申请");
                cancel();
                cleanupProcess();
            }, timeoutMinutes, TimeUnit.MINUTES);
            ensureProcess(this.projectRoot);
            long id = idCounter.getAndIncrement();
            synchronized (lock) {
                pending.put(id, response -> {
                    Object result = response.get("result");
                    if (result instanceof Map<?, ?> rm && rm.get("thread") instanceof Map<?, ?> tm) {
                        session.threadId = String.valueOf(tm.get("id"));
                    }
                    if (session.threadId.isBlank() || "null".equals(session.threadId)) {
                        session.events.accept("App Server 未返回 threadId");
                    } else {
                        startLegacyTurn(session, requestDirectory);
                    }
                });
            }
            send(AppServerMessages.startThreadRequest(id, this.projectRoot));
        }
    }

    private void startLegacyTurn(ThreadSession session, Path requestDirectory) {
        long id = idCounter.getAndIncrement();
        synchronized (lock) {
            pending.put(id, response -> {
                if (response.get("result") instanceof Map<?, ?> rm && rm.get("turn") instanceof Map<?, ?> tm) {
                    session.turnId = String.valueOf(tm.get("id"));
                }
                session.events.accept("Codex Agent 已开始处理申请");
            });
        }
        try {
            send(AppServerMessages.startTurn(id, session.threadId, session.projectRoot, requestDirectory));
        } catch (IOException error) {
            session.events.accept("Codex Agent 启动回合失败：" + error.getMessage());
        }
    }

    @Override
    public boolean running() {
        synchronized (lock) { return process != null && process.isAlive(); }
    }

    @Override
    public void cancel() {
        ThreadSession active;
        synchronized (lock) {
            active = activeThreads.values().stream()
                    .filter(s -> s.state == AgentProvider.SessionState.ACTIVE_RUNNING)
                    .findFirst().orElse(null);
        }
        if (active == null) return;
        try {
            send(AppServerMessages.interrupt(idCounter.getAndIncrement(), active.threadId, active.turnId));
        } catch (IOException ignored) {}
    }

    @Override
    public void close() {
        cancel();
        cleanupProcess();
        io.shutdownNow();
        timer.shutdownNow();
    }

    // ---------- 内部 ----------

    private void ensureProcess(Path root) throws IOException {
        synchronized (lock) {
            if (process != null && process.isAlive()) return;
            ProcessBuilder builder = new ProcessBuilder(executable, "app-server", "--listen", "stdio://");
            builder.directory(root.toAbsolutePath().normalize().toFile());
            Process started = builder.start();
            process = started;
            writer = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
            io.submit(() -> readStdout(started));
            io.submit(() -> readStderr(started));
            final long id = idCounter.getAndIncrement();
            synchronized (lock) {
                pending.put(id, response -> {
                    if (response.get("result") instanceof Map<?, ?>) {
                        try { send(AppServerMessages.initialized()); } catch (IOException ignored) {}
                    }
                });
            }
            send(AppServerMessages.initialize(id));
        }
    }

    @SuppressWarnings("unchecked")
    private void readStdout(Process started) {
        try (BufferedReader reader = started.inputReader(StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                Object parsed = Json.parse(line);
                if (!(parsed instanceof Map<?, ?> raw)) continue;
                Map<String, Object> message = (Map<String, Object>) raw;
                Number id = message.get("id") instanceof Number number ? number : null;
                if (id != null) {
                    Consumer<Map<String, Object>> handler;
                    synchronized (lock) { handler = pending.remove(id.longValue()); }
                    if (handler != null) {
                        try {
                            handler.accept(message);
                        } catch (Exception error) {
                            events.accept("Codex 响应处理异常：" + error.getMessage());
                        }
                        continue;
                    }
                }
                handleNotification(message);
            }
        } catch (Exception error) {
            if (running()) events.accept("Codex Agent 通道异常：" + error.getMessage());
        } finally {
            cleanupProcess();
        }
    }

    private void handleNotification(Map<String, Object> message) {
        String method = String.valueOf(message.get("method"));
        if ("turn/completed".equals(method) && message.get("params") instanceof Map<?, ?> params) {
            Object turn = params.get("turn");
            String turnId = turn instanceof Map<?, ?> tm ? String.valueOf(tm.get("id")) : "";
            String status = turn instanceof Map<?, ?> tm ? String.valueOf(tm.get("status")) : "unknown";
            synchronized (lock) {
                for (ThreadSession session : activeThreads.values()) {
                    if (session.turnId.equals(turnId) || session.state == AgentProvider.SessionState.ACTIVE_RUNNING) {
                        session.state = AgentProvider.SessionState.ACTIVE_IDLE;
                        session.events.accept("Codex Agent 回合结束：" + status);
                    }
                }
            }
            if (legacySession != null) {
                legacySession.state = AgentProvider.SessionState.ACTIVE_IDLE;
                events.accept("Codex Agent 回合结束：" + status);
                cleanupProcess();
            }
        } else if ("tool/call".equals(method)) {
            Map<String, Object> call = AppServerMessages.parseAgentToolCall(
                    message.get("params") instanceof Map<?, ?> params ? (Map<String, Object>) params : Map.of());
            synchronized (lock) {
                for (ThreadSession session : activeThreads.values()) {
                    if (session.state == AgentProvider.SessionState.ACTIVE_RUNNING) {
                        session.events.accept("tool_call:" + Json.stringify(call));
                    }
                }
            }
        }
    }

    private void readStderr(Process started) {
        try (BufferedReader reader = started.errorReader(StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) if (!line.isBlank()) events.accept("Codex: " + line);
        } catch (IOException ignored) {}
    }

    private void send(Map<String, Object> message) throws IOException {
        synchronized (lock) {
            if (writer == null) throw new IOException("App Server 未启动");
            writer.write(Json.stringify(message));
            writer.flush();
        }
    }

    private void cleanupProcess() {
        Process current;
        synchronized (lock) {
            current = process;
            writer = null;
            process = null;
            legacySession = null;
            if (timeoutTask != null) { timeoutTask.cancel(false); timeoutTask = null; }
        }
        if (current == null) return;
        current.destroy();
        try {
            if (!current.waitFor(2, TimeUnit.SECONDS)) {
                current.destroyForcibly();
                current.waitFor(2, TimeUnit.SECONDS);
            }
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
            current.destroyForcibly();
        }
    }
}
