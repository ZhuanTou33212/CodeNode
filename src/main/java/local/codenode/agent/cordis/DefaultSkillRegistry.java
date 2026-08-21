package local.codenode.agent.cordis;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Deterministic in-process skill registry used by the default profile. */
public final class DefaultSkillRegistry implements SkillRegistry {
    private final Map<String, Skill> skills = new LinkedHashMap<>();

    @Override public synchronized void register(Skill skill) { skills.put(skill.name(), skill); }
    @Override public synchronized void unregister(String name) { if (name != null) skills.remove(name); }
    @Override public synchronized Optional<Skill> find(String name) { return Optional.ofNullable(skills.get(name)); }
    @Override public synchronized List<Skill> list() { return List.copyOf(new ArrayList<>(skills.values())); }
}
