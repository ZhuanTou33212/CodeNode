package local.codenode.agent;

import java.util.Map;

/** Supplies non-sensitive, live information about the CodeNode workbench. */
public interface SoftwareInfoProvider {
    Map<String, Object> softwareInfo();
    Map<String, Object> environmentInfo();
}
