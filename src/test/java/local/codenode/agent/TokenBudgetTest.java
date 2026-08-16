package local.codenode.agent;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** TokenBudget：会话级 token 预算计数/超限/重置（P0-14）。 */
class TokenBudgetTest {

    @Test
    void accumulatesPromptAndCompletion() {
        TokenBudget budget = new TokenBudget();
        budget.setLimit(100);
        budget.record(Map.of("prompt_tokens", 10, "completion_tokens", 20));
        assertEquals(30, budget.used());
        assertFalse(budget.exceeded());
    }

    @Test
    void exceededOnlyWhenLimitSetAndReached() {
        TokenBudget budget = new TokenBudget();
        budget.record(Map.of("prompt_tokens", 999, "completion_tokens", 999));
        assertFalse(budget.exceeded(), "limit=0 时永不超限");

        budget.setLimit(50);
        budget.record(Map.of("prompt_tokens", 30, "completion_tokens", 30));
        assertTrue(budget.exceeded());
        assertEquals(0, budget.remaining(), "已超限时剩余应为 0");

        TokenBudget fresh = new TokenBudget();
        fresh.setLimit(50);
        fresh.record(Map.of("prompt_tokens", 30, "completion_tokens", 0));
        assertEquals(20, fresh.remaining());
    }

    @Test
    void resetClearsUsageButKeepsLimit() {
        TokenBudget budget = new TokenBudget();
        budget.setLimit(10);
        budget.record(Map.of("prompt_tokens", 8, "completion_tokens", 2));
        assertTrue(budget.exceeded());
        budget.reset();
        assertEquals(0, budget.used());
        assertFalse(budget.exceeded());
    }

    @Test
    void toleratesMissingOrNonNumericUsage() {
        TokenBudget budget = new TokenBudget();
        budget.record(null);
        budget.record(Map.of());
        budget.record(Map.of("prompt_tokens", "12", "completion_tokens", "oops"));
        assertEquals(12, budget.used());
    }
}
