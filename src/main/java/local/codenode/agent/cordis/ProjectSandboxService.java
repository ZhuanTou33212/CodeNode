package local.codenode.agent.cordis;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Objects;
import java.util.function.Supplier;

/** Project-root sandbox with traversal protection for plugin consumers. */
public final class ProjectSandboxService implements SandboxService {
    private final Supplier<Path> rootSupplier;

    public ProjectSandboxService(Supplier<Path> rootSupplier) {
        this.rootSupplier = Objects.requireNonNull(rootSupplier, "rootSupplier");
    }

    @Override
    public Path root() {
        Path root = rootSupplier.get();
        return (root == null ? Path.of(".") : root).toAbsolutePath().normalize();
    }

    @Override
    public Path resolve(String relative) throws IOException {
        if (relative == null || relative.isBlank()) throw new IOException("sandbox path is blank");
        Path candidate = root().resolve(relative).normalize();
        if (!candidate.startsWith(root())) throw new IOException("path escapes project sandbox: " + relative);
        return candidate;
    }
}
