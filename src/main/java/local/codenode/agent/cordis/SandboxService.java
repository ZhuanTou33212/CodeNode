package local.codenode.agent.cordis;

import java.io.IOException;
import java.nio.file.Path;

/** Filesystem boundary exposed to tools and plugins. */
public interface SandboxService {
    Path root();
    Path resolve(String relative) throws IOException;
}
