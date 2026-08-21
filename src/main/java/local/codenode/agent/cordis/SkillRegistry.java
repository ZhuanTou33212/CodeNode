package local.codenode.agent.cordis;

import java.util.List;
import java.util.Optional;

/** Model-facing skill registry; skills are independently mountable capabilities. */
public interface SkillRegistry {
    void register(Skill skill);
    void unregister(String name);
    Optional<Skill> find(String name);
    List<Skill> list();

    record Skill(String name, String description, String prompt) {
        public Skill {
            if (name == null || name.isBlank()) throw new IllegalArgumentException("skill name is blank");
            description = description == null ? "" : description;
            prompt = prompt == null ? "" : prompt;
        }
    }
}
