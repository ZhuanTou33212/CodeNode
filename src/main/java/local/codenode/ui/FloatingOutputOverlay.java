package local.codenode.ui;

import local.codenode.UiTheme;

import javax.swing.*;
import java.awt.*;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Non-blocking canvas output: recent messages materialize at the right edge,
 * remain readable briefly, then fade away. Only the compact visibility toggle
 * participates in hit testing, so the canvas stays fully interactive.
 */
public final class FloatingOutputOverlay extends JComponent {
    private static final int MAX_LINES = 7;
    private static final long HOLD_NANOS = 2_600_000_000L;
    private static final long FADE_NANOS = 1_400_000_000L;
    private static final long MATERIALIZE_NANOS = 220_000_000L;

    private final JButton visibilityButton = new JButton("\u25C9");
    private final Deque<String> lines = new ArrayDeque<>();
    private final Timer animation = new Timer(33, e -> updateAnimation());
    private boolean outputVisible = true;
    private long lastMessageAt;
    private float alpha;

    public FloatingOutputOverlay() {
        setOpaque(false);
        setLayout(null);

        visibilityButton.setFocusable(false);
        visibilityButton.setMargin(new Insets(0, 0, 0, 0));
        visibilityButton.setToolTipText("\u9690\u85cf\u753b\u5e03\u8f93\u51fa");
        visibilityButton.addActionListener(e -> {
            outputVisible = !outputVisible;
            visibilityButton.setText(outputVisible ? "\u25C9" : "\u25CB");
            visibilityButton.setToolTipText(outputVisible ? "\u9690\u85cf\u753b\u5e03\u8f93\u51fa" : "\u663e\u793a\u753b\u5e03\u8f93\u51fa");
            if (!outputVisible) {
                lines.clear();
                alpha = 0f;
                animation.stop();
            }
            repaint();
        });
        add(visibilityButton);

        animation.setCoalesce(true);
    }

    @Override
    public void doLayout() {
        visibilityButton.setBounds(Math.max(8, getWidth() - 42), 12, 30, 28);
    }

    @Override
    public boolean contains(int x, int y) {
        return visibilityButton.getBounds().contains(x, y);
    }

    public void showMessage(String message) {
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater(() -> showMessage(message));
            return;
        }
        if (!outputVisible || message == null || message.isBlank()) return;

        for (String raw : message.split("\\R")) {
            String line = raw.strip();
            if (line.isEmpty()) continue;
            if (line.length() > 72) line = line.substring(0, 71) + "\u2026";
            lines.addLast(line);
            while (lines.size() > MAX_LINES) lines.removeFirst();
        }
        if (lines.isEmpty()) return;

        lastMessageAt = System.nanoTime();
        alpha = 1f;
        if (!animation.isRunning()) animation.start();
        repaint();
    }

    public boolean isOutputVisible() {
        return outputVisible;
    }

    private void updateAnimation() {
        long elapsed = System.nanoTime() - lastMessageAt;
        if (elapsed <= HOLD_NANOS) {
            alpha = 1f;
        } else {
            alpha = Math.max(0f, 1f - (float)(elapsed - HOLD_NANOS) / (float)FADE_NANOS);
        }
        if (alpha <= 0f) {
            lines.clear();
            animation.stop();
        }
        repaint();
    }

    @Override
    protected void paintComponent(Graphics raw) {
        super.paintComponent(raw);
        if (!outputVisible || alpha <= 0f || lines.isEmpty()) return;

        Graphics2D g = (Graphics2D)raw.create();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);

        Font base = UIManager.getFont("Label.font");
        g.setFont((base == null ? getFont() : base).deriveFont(Font.BOLD, 13f));
        FontMetrics fm = g.getFontMetrics();
        int lineHeight = fm.getHeight() + 3;
        int maxTextWidth = Math.min(390, Math.max(180, getWidth() / 3));
        int textWidth = 0;
        for (String line : lines) textWidth = Math.max(textWidth, Math.min(maxTextWidth, fm.stringWidth(line)));
        int x = Math.max(14, getWidth() - 54 - textWidth);
        long age = System.nanoTime() - lastMessageAt;
        float materialize = Math.min(1f, (float)age / (float)MATERIALIZE_NANOS);
        float eased = 1f - (1f - materialize) * (1f - materialize);
        int y = 58 + Math.round((1f - eased) * 8f) + fm.getAscent();

        for (String line : lines) {
            String shown = fit(line, fm, maxTextWidth);
            g.setComposite(AlphaComposite.SrcOver.derive(alpha * 0.28f));
            g.setColor(Color.BLACK);
            g.drawString(shown, x + 1, y + 1);
            g.setComposite(AlphaComposite.SrcOver.derive(alpha * 0.94f));
            g.setColor(UiTheme.TEXT);
            g.drawString(shown, x, y);
            y += lineHeight;
        }
        g.dispose();
    }

    private static String fit(String text, FontMetrics metrics, int maxWidth) {
        if (metrics.stringWidth(text) <= maxWidth) return text;
        String ellipsis = "\u2026";
        int end = text.length();
        while (end > 1 && metrics.stringWidth(text.substring(0, end) + ellipsis) > maxWidth) end--;
        return text.substring(0, Math.max(1, end)) + ellipsis;
    }
}
