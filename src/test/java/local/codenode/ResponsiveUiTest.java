package local.codenode;

import local.codenode.ui.ProjectRunPanel;
import org.junit.jupiter.api.Test;

import javax.swing.*;
import java.awt.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertTrue;

final class ResponsiveUiTest {
    @Test
    void verticalContentTracksViewportWidth() {
        UiTheme.VerticalScrollPanel inspectorContent = new UiTheme.VerticalScrollPanel();
        ProjectRunPanel runPanel = new ProjectRunPanel();
        assertTrue(inspectorContent.getScrollableTracksViewportWidth());
        assertTrue(runPanel.getScrollableTracksViewportWidth());
    }

    @Test
    void toolbarRecomputesHeightWhenNarrowed() throws Exception {
        UiTheme.ResponsiveWrapPanel panel = new UiTheme.ResponsiveWrapPanel(FlowLayout.LEFT, 8, 6);
        for (int i = 0; i < 4; i++) {
            JButton button = new JButton("Control " + i);
            button.setPreferredSize(new Dimension(120, 30));
            panel.add(button);
        }

        SwingUtilities.invokeAndWait(() -> {
            panel.setBounds(0, 0, 220, 40);
            panel.doLayout();
        });
        SwingUtilities.invokeAndWait(() -> {});

        AtomicInteger height = new AtomicInteger();
        SwingUtilities.invokeAndWait(() -> height.set(panel.getPreferredSize().height));
        assertTrue(height.get() > 70, "narrow toolbar should grow vertically instead of clipping");
    }
}
