package codenode.demo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class AddIntegersTest {
    @Test
    void addsTwoInputs() {
        assertEquals(7, AddIntegers.execute(3, 4));
    }
}
