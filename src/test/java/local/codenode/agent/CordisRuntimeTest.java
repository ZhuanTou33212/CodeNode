package local.codenode.agent;

import local.codenode.agent.cordis.CordisEvent;
import local.codenode.agent.cordis.CordisScope;
import local.codenode.agent.cordis.CordisRuntime;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CordisRuntimeTest {
    @Test
    void mountsServicesAndUnwindsPluginEffects() throws Exception {
        CordisRuntime runtime = new CordisRuntime();
        List<String> observed = new ArrayList<>();
        runtime.context().events().on("*", event -> observed.add(event.type()));
        runtime.mount(new Plugin("base", Set.of(), context -> context.provide("answer", 42)));
        runtime.mount(new Plugin("consumer", Set.of("base"), context -> {
            assertEquals(42, context.get("answer"));
            context.subscribe("demo/test", event -> observed.add("consumer:" + event.type()));
        }));

        observed.clear();
        runtime.context().events().emit(new CordisEvent("demo/test", Map.of("ok", true)));
        assertEquals(List.of("consumer:demo/test", "demo/test"), observed);
        assertEquals(List.of("base", "consumer"), runtime.mountedPluginIds());
        assertThrows(IllegalStateException.class, () -> runtime.unmount("base"));

        assertTrue(runtime.unmount("consumer"));
        int afterUnmount = observed.size();
        runtime.context().events().emit(new CordisEvent("demo/test", Map.of()));
        assertEquals(afterUnmount + 1, observed.size(), "unmounted plugin subscription must be unwound");
        assertTrue(runtime.unmount("base"));
        assertFalse(runtime.context().has("answer"));
        runtime.close();
    }

    @Test
    void rejectsMissingDependencies() {
        CordisRuntime runtime = new CordisRuntime();
        assertThrows(IllegalStateException.class, () -> runtime.mount(
                new Plugin("consumer", Set.of("missing"), context -> { })));
        runtime.close();
    }

    @Test
    void rejectsMissingInjectedService() {
        CordisRuntime runtime = new CordisRuntime();
        local.codenode.agent.cordis.CordisPlugin plugin = new local.codenode.agent.cordis.CordisPlugin() {
            @Override public String id() { return "consumer"; }
            @Override public Set<String> requiredServices() { return Set.of("missing.service"); }
            @Override public void apply(local.codenode.agent.cordis.CordisContext context) { }
        };
        assertThrows(IllegalStateException.class, () -> runtime.mount(plugin));
        runtime.close();
    }

    @Test
    void beforeInterceptorCanTransformOrCancelAnEvent() {
        CordisRuntime runtime = new CordisRuntime();
        List<String> seen = new ArrayList<>();
        runtime.context().events().before("demo/transform", event ->
                event.withFields(Map.of("value", "rewritten")));
        runtime.context().events().on("demo/transform", event ->
                seen.add(String.valueOf(event.fields().get("value"))));
        runtime.context().events().before("demo/cancel", event -> null);
        runtime.context().events().on("demo/cancel", event -> seen.add("cancelled event delivered"));

        assertTrue(runtime.context().events().emit(new CordisEvent("demo/transform", Map.of("value", "original"))) != null);
        assertEquals(List.of("rewritten"), seen);
        assertTrue(runtime.context().events().emit(new CordisEvent("demo/cancel", Map.of())) == null);
        assertEquals(List.of("rewritten"), seen);
        runtime.close();
    }

    @Test
    void sessionScopeIsolatesServicesAndSubscriptions() {
        CordisRuntime runtime = new CordisRuntime();
        runtime.context().provide("shared", "parent");
        CordisScope scope = runtime.openScope("session-1");
        scope.provide("shared", "local");
        List<String> seen = new ArrayList<>();
        scope.on("agent/event", event -> seen.add(event.scope()));
        assertEquals("local", scope.get("shared"));
        assertEquals("parent", runtime.context().get("shared"));
        scope.emit("agent/event", Map.of());
        assertEquals(List.of("session-1"), seen);
        scope.close();
        scope = runtime.openScope("session-2");
        scope.emit("agent/event", Map.of());
        assertEquals(List.of("session-1"), seen);
        scope.close();
        runtime.close();
    }

    @Test
    void pluginManifestCompatibilityIsValidatedBeforeApply() {
        CordisRuntime runtime = new CordisRuntime();
        local.codenode.agent.cordis.CordisPlugin incompatible = new local.codenode.agent.cordis.CordisPlugin() {
            @Override public String id() { return "future-plugin"; }
            @Override public local.codenode.agent.cordis.CordisPluginManifest manifest() {
                return new local.codenode.agent.cordis.CordisPluginManifest(
                        "future-plugin", "2.0.0", Set.of(), Set.of(), Set.of(), "2.0.0", "");
            }
            @Override public void apply(local.codenode.agent.cordis.CordisContext context) {
                throw new AssertionError("incompatible plugin must not apply");
            }
        };
        assertThrows(IllegalStateException.class, () -> runtime.mount(incompatible));
        assertTrue(runtime.mountedPluginIds().isEmpty());
        runtime.close();
    }

    @Test
    void stableContractExposesKnownServiceAndEventNames() {
        assertEquals("1.0", local.codenode.agent.cordis.CordisContracts.VERSION);
        assertTrue(local.codenode.agent.cordis.CordisContracts.SERVICE_TYPES.containsKey(
                local.codenode.agent.cordis.CordisContracts.SERVICE_TOOLS));
        assertTrue(local.codenode.agent.cordis.CordisContracts.DURABLE_EVENTS.contains("tool/result"));
        assertTrue(local.codenode.agent.cordis.CordisContracts.compatible("1.0"));
    }

    private record Plugin(String id, Set<String> dependencies,
                          java.util.function.Consumer<local.codenode.agent.cordis.CordisContext> action)
            implements local.codenode.agent.cordis.CordisPlugin {
        @Override
        public void apply(local.codenode.agent.cordis.CordisContext context) {
            action.accept(context);
        }
    }
}
