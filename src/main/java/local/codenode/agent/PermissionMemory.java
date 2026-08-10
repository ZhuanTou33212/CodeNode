package local.codenode.agent;

import java.util.HashMap;
import java.util.Map;

/** Session-scoped approval memory; it is intentionally never persisted. */
public final class PermissionMemory {
    private final Map<String, Boolean> decisions = new HashMap<>();
    public synchronized Boolean get(String signature) { return decisions.get(signature); }
    public synchronized void remember(String signature, boolean allowed) { if (signature != null) decisions.put(signature, allowed); }
    public synchronized void clear() { decisions.clear(); }
    public static String signature(String tool, Object detail) { return tool + "|" + String.valueOf(detail); }
}
