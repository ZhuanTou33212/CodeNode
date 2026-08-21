package local.codenode.agent.cordis;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Plugin runtime with dependency checks and reverse-order lifecycle disposal. */
public final class CordisRuntime implements AutoCloseable {
    public static final String RUNTIME_VERSION = "0.1.0";
    private final CordisContext context;
    private final LinkedHashMap<String, MountedPlugin> mounted = new LinkedHashMap<>();
    private final List<CordisScope> scopes = new ArrayList<>();
    private boolean closed;

    public CordisRuntime() { this(new CordisContext()); }
    public CordisRuntime(CordisContext context) { this.context = Objects.requireNonNull(context, "context"); }

    public synchronized CordisContext context() { ensureOpen(); return context; }
    public synchronized List<String> mountedPluginIds() { return List.copyOf(mounted.keySet()); }

    public synchronized CordisScope openScope(String id) {
        ensureOpen();
        CordisScope scope = new CordisScope(context, id);
        scopes.add(scope);
        return scope;
    }

    /** Runtime inspection snapshot for diagnostics and creator/configuration UIs. */
    public synchronized RuntimeSnapshot snapshot() {
        return new RuntimeSnapshot(List.copyOf(mounted.keySet()), context.servicesSnapshot(),
                scopes.stream().map(CordisScope::id).toList(), context.events().listenerCount());
    }

    public synchronized void mount(CordisPlugin plugin) throws Exception {
        ensureOpen();
        Objects.requireNonNull(plugin, "plugin");
        String id = requireId(plugin.id());
        CordisPluginManifest manifest = Objects.requireNonNull(plugin.manifest(), "plugin manifest");
        validateManifest(plugin, manifest, id);
        if (mounted.containsKey(id)) throw new IllegalStateException("plugin already mounted: " + id);
        for (String dependency : plugin.dependencies()) {
            if (!mounted.containsKey(dependency)) {
                throw new IllegalStateException("plugin " + id + " requires missing plugin: " + dependency);
            }
        }
        for (String service : plugin.requiredServices()) {
            if (!context.has(service)) {
                throw new IllegalStateException("plugin " + id + " requires missing service: " + service);
            }
        }
        CordisContext.EffectScope scope = context.beginScope();
        try {
            plugin.apply(context);
            scope.finish();
            mounted.put(id, new MountedPlugin(plugin, scope));
        } catch (Exception failure) {
            scope.close();
            throw failure;
        }
        context.events().emit(CordisEvent.of("plugin/mounted", id,
                java.util.Map.of("plugin", id, "dependencies", plugin.dependencies(),
                        "requiredServices", plugin.requiredServices(), "manifest", manifest.toMap())));
    }

    public synchronized void mountAll(Iterable<? extends CordisPlugin> plugins) throws Exception {
        List<CordisPlugin> pending = new ArrayList<>();
        plugins.forEach(pending::add);
        Set<String> remaining = new LinkedHashSet<>();
        for (CordisPlugin plugin : pending) remaining.add(plugin.id());
        List<String> before = new ArrayList<>(mounted.keySet());
        try {
            while (!pending.isEmpty()) {
                boolean progress = false;
                for (int i = 0; i < pending.size(); i++) {
                    CordisPlugin plugin = pending.get(i);
                    if (plugin.dependencies().stream().allMatch(dep -> mounted.containsKey(dep))
                            && plugin.requiredServices().stream().allMatch(context::has)) {
                        mount(plugin); pending.remove(i); remaining.remove(plugin.id()); progress = true; break;
                    }
                }
                if (!progress) throw new IllegalStateException("unresolvable plugin dependencies: " + remaining);
            }
        } catch (Exception failure) {
            List<String> added = new ArrayList<>(mounted.keySet());
            for (int i = added.size() - 1; i >= 0; i--) {
                if (!before.contains(added.get(i))) {
                    try { unmount(added.get(i)); } catch (RuntimeException ignored) { }
                }
            }
            throw failure;
        }
    }

    public synchronized boolean unmount(String id) {
        ensureOpen();
        MountedPlugin mountedPlugin = mounted.get(id);
        if (mountedPlugin == null) return false;
        CordisPlugin plugin = mountedPlugin.plugin();
        List<String> dependents = mounted.values().stream()
                .filter(other -> other.plugin().dependencies().contains(id))
                .map(other -> other.plugin().id()).toList();
        if (!dependents.isEmpty()) throw new IllegalStateException(
                "cannot unmount " + id + "; dependents still mounted: " + dependents);
        mounted.remove(id);
        try { plugin.dispose(context); }
        finally {
            mountedPlugin.scope().close();
            context.events().emit(CordisEvent.of("plugin/unmounted", id,
                java.util.Map.of("plugin", id))); }
        return true;
    }

    /** Replaces a mounted plugin after its dependents have been removed. */
    public synchronized void replace(CordisPlugin plugin) throws Exception {
        Objects.requireNonNull(plugin, "plugin");
        String id = requireId(plugin.id());
        if (mounted.containsKey(id)) unmount(id);
        mount(plugin);
    }

    @Override
    public synchronized void close() {
        if (closed) return;
        closed = true;
        List<MountedPlugin> plugins = new ArrayList<>(mounted.values());
        for (int i = plugins.size() - 1; i >= 0; i--) {
            try { plugins.get(i).plugin().dispose(context); } catch (RuntimeException ignored) { }
            try { plugins.get(i).scope().close(); } catch (RuntimeException ignored) { }
        }
        mounted.clear();
        for (int i = scopes.size() - 1; i >= 0; i--) {
            try { scopes.get(i).close(); } catch (RuntimeException ignored) { }
        }
        scopes.clear();
        context.close();
    }

    private void ensureOpen() { if (closed) throw new IllegalStateException("Cordis runtime is closed"); }

    private static void validateManifest(CordisPlugin plugin, CordisPluginManifest manifest, String id) {
        if (!id.equals(manifest.id())) throw new IllegalArgumentException(
                "plugin manifest id mismatch: plugin=" + id + ", manifest=" + manifest.id());
        if (!manifest.compatibleWith(RUNTIME_VERSION)) throw new IllegalStateException(
                "plugin " + id + " is incompatible with Cordis runtime " + RUNTIME_VERSION);
        if (!CordisContracts.compatible(manifest.contractVersion())) throw new IllegalStateException(
                "plugin " + id + " requires unsupported Cordis contract " + manifest.contractVersion());
        if (!manifest.dependencies().containsAll(plugin.dependencies())) throw new IllegalArgumentException(
                "plugin manifest dependencies do not cover implementation dependencies: " + id);
        if (!manifest.requiredServices().containsAll(plugin.requiredServices())) throw new IllegalArgumentException(
                "plugin manifest required services do not cover implementation requirements: " + id);
    }
    private static String requireId(String id) {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("plugin id must not be blank");
        return id.trim();
    }

    private record MountedPlugin(CordisPlugin plugin, CordisContext.EffectScope scope) { }

    public record RuntimeSnapshot(List<String> plugins, java.util.Map<String, Object> services,
                                  List<String> scopes, int eventListeners) {
        public RuntimeSnapshot {
            plugins = List.copyOf(plugins);
            services = java.util.Map.copyOf(services);
            scopes = List.copyOf(scopes);
        }
    }
}
