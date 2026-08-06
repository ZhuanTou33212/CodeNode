package local.codenode;
import java.nio.file.*;

public class CancelTest {
    public static void main(String[] args) throws Exception {
        var root = Path.of("C:\\Users\\1\\Desktop");
        var qs = new QueueService(root);
        
        // 列出所有申请
        System.out.println("=== 当前队列状态 ===");
        for (var e : qs.entries()) {
            System.out.println("  [" + e.status() + "] " + e.requestId());
        }
        
        // 取消 inbox 中的申请
        String reqId = "request-20260803163232108";
        Path inbox = root.resolve(".codenode/queue/inbox").resolve(reqId);
        Path cancelled = root.resolve(".codenode/queue/cancelled").resolve(reqId);
        
        if (Files.isDirectory(inbox)) {
            System.out.println("\n=== 取消申请: " + reqId + " ===");
            qs.cancel(reqId);
            System.out.println("结果: " + (Files.isDirectory(cancelled) ? "已移至 cancelled" : "失败"));
        } else {
            System.out.println("\n申请 " + reqId + " 不在 inbox 中，检查 processing...");
            Path proc = root.resolve(".codenode/queue/processing").resolve(reqId);
            if (Files.isDirectory(proc)) {
                qs.cancel(reqId);
                System.out.println("已从 processing 移至 cancelled");
            } else {
                System.out.println("也不在 processing 中，可能已被取消");
            }
        }
        
        // 再列出
        System.out.println("\n=== 取消后队列状态 ===");
        for (var e : qs.entries()) {
            System.out.println("  [" + e.status() + "] " + e.requestId());
        }
        
        // 恢复：移回 inbox 以便继续测试
        if (Files.isDirectory(cancelled)) {
            System.out.println("\n=== 恢复申请到 inbox ===");
            Files.move(cancelled, inbox, StandardCopyOption.ATOMIC_MOVE);
            System.out.println("已恢复");
        }
    }
}
