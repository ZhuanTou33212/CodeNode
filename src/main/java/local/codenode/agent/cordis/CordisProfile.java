package local.codenode.agent.cordis;

import java.util.List;
import java.util.Objects;

/** Named, ordered plugin composition analogous to a Harness profile/bundle. */
public record CordisProfile(String name, List<? extends CordisPlugin> plugins) {
    public CordisProfile {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("profile name is blank");
        name = name.trim();
        plugins = plugins == null ? List.of() : List.copyOf(plugins);
    }

    public void mount(CordisRuntime runtime) throws Exception {
        Objects.requireNonNull(runtime, "runtime").mountAll(plugins);
    }
}
