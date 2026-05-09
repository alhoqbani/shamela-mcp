package ws.shamela.mcp;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;

/**
 * Lazy-open per-book SQLite databases for printed-page label lookups.
 * Caches up to {@value #MAX_CACHE} connections in LRU order.
 *
 * Per-book DB lives at <database>/book/<bucket>/<book_id>.db where
 * bucket = book_id mod 1000. Schema:
 *   CREATE TABLE page (id INTEGER PRIMARY KEY, part TEXT, page INTEGER, number INTEGER, services TEXT);
 */
public final class BookPages {

    private static final int MAX_CACHE = 50;
    private static final String BOOK_LITERAL = "الكتاب"; // "الكتاب"

    private final Path databaseRoot;
    private final Map<Integer, Connection> connections = new LinkedHashMap<>(16, 0.75f, true);

    public BookPages(Path databaseRoot) {
        this.databaseRoot = databaseRoot;
        try {
            Class.forName("org.sqlite.JDBC");
        } catch (ClassNotFoundException ignore) {
            // Catalog.java already throws on missing driver; swallow here so a
            // single missing per-book DB doesn't kill the whole search.
        }
    }

    private Path pathFor(int bookId) {
        int bucket = bookId % 1000;
        return databaseRoot.resolve("book").resolve(Integer.toString(bucket)).resolve(bookId + ".db");
    }

    private synchronized Connection getOrOpen(int bookId) {
        Connection existing = connections.get(bookId);
        if (existing != null) return existing;
        Path p = pathFor(bookId);
        if (!Files.isRegularFile(p)) return null;
        try {
            String url = "jdbc:sqlite:" + p.toString().replace("\\", "/");
            Properties props = new Properties();
            props.setProperty("open_mode", "1"); // SQLITE_OPEN_READONLY
            Connection conn = DriverManager.getConnection(url, props);
            connections.put(bookId, conn);
            if (connections.size() > MAX_CACHE) {
                Map.Entry<Integer, Connection> oldest = connections.entrySet().iterator().next();
                connections.remove(oldest.getKey());
                try { oldest.getValue().close(); } catch (SQLException ignore) {}
            }
            return conn;
        } catch (SQLException e) {
            return null;
        }
    }

    /**
     * Return a printed-page label for (book_id, page_id), or null if the
     * per-book DB is missing or has no entry.
     *
     * Format: "<part>/ <page>" if part is set and != "الكتاب", else just
     * "<page>". Returns null only when both fields are null/empty or the
     * lookup itself failed.
     */
    public synchronized String printedPage(int bookId, int pageId) {
        Connection conn = getOrOpen(bookId);
        if (conn == null) return null;
        try (PreparedStatement ps = conn.prepareStatement("SELECT part, page FROM page WHERE id = ?")) {
            ps.setInt(1, pageId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return null;
                String part = rs.getString(1);
                int page = rs.getInt(2);
                boolean pageWasNull = rs.wasNull();
                String partTrim = part == null ? "" : part.trim();
                String pageStr = pageWasNull ? "" : Integer.toString(page);
                if (!partTrim.isEmpty() && !partTrim.equals(BOOK_LITERAL)) {
                    return pageStr.isEmpty() ? partTrim : (partTrim + "/ " + pageStr);
                }
                return pageStr.isEmpty() ? null : pageStr;
            }
        } catch (SQLException e) {
            return null;
        }
    }

    public synchronized void close() {
        for (Connection conn : connections.values()) {
            try { conn.close(); } catch (SQLException ignore) {}
        }
        connections.clear();
    }
}
