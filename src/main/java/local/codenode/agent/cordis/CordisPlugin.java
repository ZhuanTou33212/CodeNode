package local.codenode.agent.cordis;

import java.util.Set;

/** A Cordis plugin with explicit dependencies and reversible lifecycle. */
public interface CordisPlugin {
    String id();
    default Set<String> dependencies() { return Set.of(); }

    /** Services that must exist before this plugin is applied (Cordis inject seam). */
    default Set<String> requiredServices() { return Set.of(); }

    /** Published identity and compatibility contract; override for real plugins. */
    default CordisPluginManifest manifest() { return CordisPluginManifest.forPlugin(this); }

    void apply(CordisContext context) throws Exception;
    default void dispose(CordisContext context) { }
}
