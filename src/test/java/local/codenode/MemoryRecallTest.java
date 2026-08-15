package local.codenode;

import local.codenode.agent.MemoryStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P3 记忆相关性检索：关键词打分排序（英文词 + 中文 2-gram），空查询保持时间序。
 */
class MemoryRecallTest {
    @TempDir
    Path root;

    private MemoryStore newStore() throws Exception {
        MemoryStore store = new MemoryStore(4096, 16, Duration.ofDays(30));
        store.bind(root);
        return store;
    }

    @Test
    void relevantEntryOutranksNewerUnrelatedEntry() throws Exception {
        MemoryStore store = newStore();
        store.remember("部署记录", "jenkins 构建失败排查记录", "conversation");
        store.remember("会议纪要", "本周产品评审结论", "conversation");
        List<MemoryStore.Entry> hits = store.recall("jenkins 构建", 5);
        assertEquals(1, hits.size(), "只应召回相关条目");
        assertTrue(hits.get(0).title().contains("部署记录"), "相关条目应优先于时间序");
    }

    @Test
    void chineseBigramMatchesContent() throws Exception {
        MemoryStore store = newStore();
        store.remember("架构", "扫描项目后生成的架构分析", "conversation");
        store.remember("日志", "运行日志", "conversation");
        List<MemoryStore.Entry> hits = store.recall("架构分析", 5);
        assertTrue(hits.stream().anyMatch(e -> e.title().contains("架构")), "中文 2-gram 应命中相关记忆");
    }

    @Test
    void emptyQueryKeepsTimeOrder() throws Exception {
        MemoryStore store = newStore();
        store.remember("first", "第一条", "conversation");
        store.remember("second", "第二条", "conversation");
        List<MemoryStore.Entry> hits = store.recall("", 5);
        assertEquals(2, hits.size());
        assertTrue(hits.get(0).title().contains("second"), "空查询应按最新优先");
    }

    @Test
    void noMatchFallsBackToNewest() throws Exception {
        MemoryStore store = newStore();
        store.remember("alpha", "内容一", "conversation");
        store.remember("beta", "内容二", "conversation");
        List<MemoryStore.Entry> hits = store.recall("完全不存在的关键词xyz", 5);
        assertEquals(2, hits.size(), "无相关命中时退回最新条目");
        assertTrue(hits.get(0).title().contains("beta"));
    }
}
