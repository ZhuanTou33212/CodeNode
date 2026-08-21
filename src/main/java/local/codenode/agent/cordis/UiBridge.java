package local.codenode.agent.cordis;

import java.util.List;
import java.util.Map;

/** UI capability boundary; the runtime does not depend on Swing. */
public interface UiBridge {
    String askUser(String question, List<String> options);
    boolean control(String action, Map<String, Object> arguments);
    void audit(String message);
}
