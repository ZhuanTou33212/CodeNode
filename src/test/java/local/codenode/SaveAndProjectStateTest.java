package local.codenode;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SaveAndProjectStateTest {
    @Test
    void saveRequiresAnActiveWritableProject() {
        assertFalse(MainFrame.canSave(false, false));
        assertFalse(MainFrame.canSave(false, true));
        assertFalse(MainFrame.canSave(true, true));
        assertTrue(MainFrame.canSave(true, false));
    }
}