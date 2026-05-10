package ws.shamela.mcp;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Streaming counter for search-result coverage aggregation. Java side
 * groups hits by `book_key` (every doc in page/title/book has it) up to
 * COVERAGE_CAP hits to keep the cost bounded; Node side enriches with
 * book/author/category names before returning.
 */
public final class Coverage {

    private static final int CAP = 5_000;

    private final LinkedHashMap<String, Integer> byBookKey = new LinkedHashMap<>();
    private int totalSeen = 0;

    public void recordBookKey(String bookKey) {
        if (totalSeen >= CAP) return;
        byBookKey.merge(bookKey, 1, Integer::sum);
        totalSeen++;
    }

    public Map<String, Integer> snapshot() {
        return byBookKey;
    }

    public int total() { return totalSeen; }

    public boolean atCap() { return totalSeen >= CAP; }
}
