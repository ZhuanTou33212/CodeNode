package local.codenode.agent.cordis;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.UnaryOperator;

/** Shared service context exposed to Cordis plugins. */
public final class CordisContext implements AutoCloseable {
    private final ConcurrentHashMap<String, Object> services = new ConcurrentHashMap<>();
    private final CordisEventBus events = new CordisEventBus();
    private final List<AutoCloseable> effects = new ArrayList<>();
    private final ThreadLocal<EffectScope> activeScope = new ThreadLocal<>();
    private volatile boolean closed;

    public CordisEventBus events() { ensureOpen(); return events; }

    public <T> T get(String name, Class<T> type) {
        Objects.requireNonNull(type, "type");
        Object value = get(name);
        return value == null ? null : type.cast(value);
    }

    public Object get(String name) { ensureOpen(); return services.get(requireName(name)); }
    public boolean has(String name) { return get(name) != null; }

    /** Provides a service and returns an effect that removes exactly this registration. */
    public synchronized ServiceRegistration provide(String name, Object service) {
        ensureOpen();
        String key = requireName(name);
        Objects.requireNonNull(service, "service");
        if (services.putIfAbsent(key, service) != null) {
            throw new IllegalStateException("service already provided: " + key);
        }
        ServiceRegistration registration = new ServiceRegistration(this, key, service);
        track(registration);
        return registration;
    }

    /** Replaces a service value while preserving the old registration's safe remove semantics. */
    public synchronized ServiceRegistration replace(String name, Object service) {
        String key = requireName(name);
        services.remove(key);
        return provide(key, service);
    }

    public synchronized CordisEventBus.Subscription subscribe(String type,
                                                               java.util.function.Consumer<CordisEvent> listener) {
        ensureOpen();
        CordisEventBus.Subscription subscription = events.on(type, listener);
        track(subscription);
        return subscription;
    }

    public synchronized CordisEventBus.Subscription intercept(String type, UnaryOperator<CordisEvent> interceptor) {
        ensureOpen();
        CordisEventBus.Subscription subscription = events.before(type, interceptor);
        track(subscription);
        return subscription;
    }

    /** Opens a transaction-like effect scope for one plugin activation. */
    public synchronized EffectScope beginScope() {
        ensureOpen();
        if (activeScope.get() != null) throw new IllegalStateException("nested Cordis plugin scope");
        EffectScope scope = new EffectScope(this);
        activeScope.set(scope);
        return scope;
    }

    synchronized void remove(String name, Object service) { services.remove(name, service); }

    private synchronized void track(AutoCloseable effect) {
        EffectScope scope = activeScope.get();
        if (scope == null) effects.add(effect);
        else scope.effects.add(effect);
    }

    private synchronized void finishScope(EffectScope scope) {
        if (activeScope.get() == scope) activeScope.remove();
    }

    public Map<String, Object> servicesSnapshot() { ensureOpen(); return Map.copyOf(services); }

    @Override
    public synchronized void close() {
        if (closed) return;
        closed = true;
        for (int i = effects.size() - 1; i >= 0; i--) {
            try { effects.get(i).close(); } catch (Exception ignored) { }
        }
        effects.clear();
        services.clear();
    }

    private void ensureOpen() { if (closed) throw new IllegalStateException("Cordis context is closed"); }

    private static String requireName(String name) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("service name must not be blank");
        return name.trim();
    }

    public static final class ServiceRegistration implements AutoCloseable {
        private final CordisContext context;
        private final String name;
        private final Object service;
        private boolean closed;

        private ServiceRegistration(CordisContext context, String name, Object service) {
            this.context = context; this.name = name; this.service = service;
        }

        @Override
        public synchronized void close() {
            if (closed) return;
            closed = true;
            context.remove(name, service);
        }
    }

    /** Effects created by one plugin activation; close unwinds them in reverse order. */
    public static final class EffectScope implements AutoCloseable {
        private final CordisContext context;
        private final List<AutoCloseable> effects = new ArrayList<>();
        private boolean finished;

        private EffectScope(CordisContext context) { this.context = context; }

        void finish() {
            if (finished) return;
            finished = true;
            context.finishScope(this);
        }

        @Override
        public synchronized void close() {
            if (!finished) finish();
            for (int i = effects.size() - 1; i >= 0; i--) {
                try { effects.get(i).close(); } catch (Exception ignored) { }
            }
            effects.clear();
        }
    }
}
