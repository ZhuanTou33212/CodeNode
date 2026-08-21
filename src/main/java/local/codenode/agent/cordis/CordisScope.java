package local.codenode.agent.cordis;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.UnaryOperator;

/**
 * Session/group scope layered over a parent Cordis context.
 * Local services shadow parent services; events are stamped with this scope
 * and subscriptions only observe events from the same scope.
 */
public final class CordisScope implements AutoCloseable {
    private final CordisContext parent;
    private final String id;
    private final ConcurrentHashMap<String, Object> services = new ConcurrentHashMap<>();
    private final List<AutoCloseable> effects = new ArrayList<>();
    private volatile boolean closed;

    CordisScope(CordisContext parent, String id) {
        this.parent = Objects.requireNonNull(parent, "parent");
        if (id == null || id.isBlank()) throw new IllegalArgumentException("scope id is blank");
        this.id = id.trim();
    }

    public String id() { return id; }

    public <T> T get(String name, Class<T> type) {
        Objects.requireNonNull(type, "type");
        ensureOpen();
        Object value = services.containsKey(name) ? services.get(name) : parent.get(name);
        return value == null ? null : type.cast(value);
    }

    public Object get(String name) {
        ensureOpen();
        return services.containsKey(name) ? services.get(name) : parent.get(name);
    }

    public boolean has(String name) { return get(name) != null; }

    public synchronized ServiceRegistration provide(String name, Object service) {
        ensureOpen();
        if (name == null || name.isBlank()) throw new IllegalArgumentException("service name is blank");
        Objects.requireNonNull(service, "service");
        String key = name.trim();
        if (services.putIfAbsent(key, service) != null) {
            throw new IllegalStateException("scope service already provided: " + key);
        }
        ServiceRegistration registration = new ServiceRegistration(key, service);
        effects.add(registration);
        return registration;
    }

    public CordisEventBus.Subscription on(String type, Consumer<CordisEvent> listener) {
        ensureOpen();
        CordisEventBus.Subscription subscription = parent.events().on(type, event -> {
            if (id.equals(event.scope())) listener.accept(event);
        });
        track(subscription);
        return subscription;
    }

    public CordisEventBus.Subscription before(String type, UnaryOperator<CordisEvent> interceptor) {
        ensureOpen();
        CordisEventBus.Subscription subscription = parent.events().before(type, event -> {
            if (!id.equals(event.scope())) return event;
            return interceptor.apply(event);
        });
        track(subscription);
        return subscription;
    }

    public CordisEvent emit(String type, Map<String, Object> fields) {
        ensureOpen();
        return parent.events().emit(CordisEvent.of(type, id, fields));
    }

    public CordisEvent emit(CordisEvent event) {
        ensureOpen();
        Objects.requireNonNull(event, "event");
        return parent.events().emit(event.scope().equals(id) ? event
                : CordisEvent.of(event.type(), id, event.fields()));
    }

    public Map<String, Object> localServicesSnapshot() {
        ensureOpen();
        return Map.copyOf(new LinkedHashMap<>(services));
    }

    private synchronized void track(AutoCloseable effect) { effects.add(effect); }

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

    private void ensureOpen() { if (closed) throw new IllegalStateException("Cordis scope is closed: " + id); }

    public final class ServiceRegistration implements AutoCloseable {
        private final String name;
        private final Object service;
        private boolean closed;

        private ServiceRegistration(String name, Object service) { this.name = name; this.service = service; }

        @Override
        public synchronized void close() {
            if (closed) return;
            closed = true;
            services.remove(name, service);
        }
    }
}
