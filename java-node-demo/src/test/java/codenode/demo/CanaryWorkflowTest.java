package codenode.demo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class CanaryWorkflowTest {
    @Test
    void variableCalculation() {
        assertEquals(42, AddIntegers.execute(19, 23));
    }

    @Test
    void conditionalBranch() {
        assertEquals("accepted", ConditionalValue.choose(10, 10));
        assertEquals("rejected", ConditionalValue.choose(9, 10));
    }

    @Test
    void jsonTransformAndOutput() {
        assertEquals("{\"value\":84}", JsonNumberTransform.doubleValue("{\"value\":42}"));
    }
}
