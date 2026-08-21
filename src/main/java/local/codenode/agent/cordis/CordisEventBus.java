package local.codenode.agent.cordis;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.UnaryOperator;

/** Thread-safe exact-match and wildcard event bus for Cordis plugins. */
public final class CordisEventBus {
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<Consumer<CordisEvent>>> listeners =
            new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<UnaryOperator<CordisEvent>>> interceptors =
            new ConcurrentHashMap<>();

    public Subscription on(String type, Consumer<CordisEvent> listener) {
        Objects.requireNonNull(listener, "listener");
        String key = normalize(type);
        CopyOnWriteArrayList<Consumer<CordisEvent>> bucket =
                listeners.computeIfAbsent(key, ignored -> new CopyOnWriteArrayList<>());
        bucket.addIfAbsent(listener);
        return () -> bucket.remove(listener);
    }

    /** Registers a before-interceptor; return null to cancel the event. */
    public Subscription before(String type, UnaryOperator<CordisEvent> interceptor) {
        Objects.requireNonNull(interceptor, "interceptor");
        String key = normalize(type);
        CopyOnWriteArrayList<UnaryOperator<CordisEvent>> bucket =
                interceptors.computeIfAbsent(key, ignored -> new CopyOnWriteArrayList<>());
        bucket.addIfAbsent(interceptor);
        return () -> bucket.remove(interceptor);
    }

    /** Emits an event after before-interceptors; null means the event was cancelled. */
    public CordisEvent emit(CordisEvent event) {
        Objects.requireNonNull(event, "event");
        List<UnaryOperator<CordisEvent>> filters = new ArrayList<>();
        CopyOnWriteArrayList<UnaryOperator<CordisEvent>> exactFilters = interceptors.get(event.type());
        if (exactFilters != null) filters.addAll(exactFilters);
        CopyOnWriteArrayList<UnaryOperator<CordisEvent>> wildcardFilters = interceptors.get("*");
        if (wildcardFilters != null) filters.addAll(wildcardFilters);
        CordisEvent current = event;
        for (UnaryOperator<CordisEvent> filter : filters) {
            try {
                current = filter.apply(current);
                if (current == null) return null;
            } catch (RuntimeException ignored) {
                // A failed observer/interceptor cannot break the agent turn.
            }
        }
        List<Consumer<CordisEvent>> targets = new ArrayList<>();
        CopyOnWriteArrayList<Consumer<CordisEvent>> exact = listeners.get(current.type());
        if (exact != null) targets.addAll(exact);
        CopyOnWriteArrayList<Consumer<CordisEvent>> wildcard = listeners.get("*");
        if (wildcard != null) targets.addAll(wildcard);
        for (Consumer<CordisEvent> target : targets) {
            try { target.accept(current); } catch (RuntimeException ignored) { }
        }
        return current;
    }

    public int listenerCount() {
        return listeners.values().stream().mapToInt(List::size).sum()
                + interceptors.values().stream().mapToInt(List::size).sum();
    }

    private static String normalize(String type) {
        if (type == null || type.isBlank()) throw new IllegalArgumentException("event type must not be blank");
        return type.trim();
    }

    @FunctionalInterface
    public interface Subscription extends AutoCloseable {
        @Override void close();
    }
}
