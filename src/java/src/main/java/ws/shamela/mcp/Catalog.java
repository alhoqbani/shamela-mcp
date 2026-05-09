package ws.shamela.mcp;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;

/**
 * In-memory cache of master.db: book_id -> (book_name, author_name).
 * Loaded once at startup; master.db has 8 589 books and 3 187 authors so the
 * full catalog fits comfortably in memory.
 */
public final class Catalog {

    public record BookInfo(int bookId, String bookName, String authorName) {}
    public record AuthorInfo(int authorId, String authorName, Integer deathYear) {}

    private final Map<Integer, BookInfo> books = new HashMap<>();
    private final Map<Integer, AuthorInfo> authors = new HashMap<>();

    public Catalog(Path masterDb) throws SQLException {
        // Force load of the SQLite JDBC driver for systems without auto-discovery.
        try {
            Class.forName("org.sqlite.JDBC");
        } catch (ClassNotFoundException e) {
            throw new SQLException("sqlite-jdbc not on the classpath", e);
        }
        String url = "jdbc:sqlite:" + masterDb.toString().replace("\\", "/");
        Properties props = new Properties();
        // SQLITE_OPEN_READONLY = 1; sqlite-jdbc maps "open_mode" to sqlite3_open_v2 flags.
        props.setProperty("open_mode", "1");
        try (Connection conn = DriverManager.getConnection(url, props);
             Statement st = conn.createStatement()) {

            // Load authors first.
            try (ResultSet rs = st.executeQuery("SELECT author_id, author_name, death_number FROM author")) {
                while (rs.next()) {
                    int aid = rs.getInt(1);
                    String name = rs.getString(2);
                    int dn = rs.getInt(3);
                    Integer death = rs.wasNull() ? null : Integer.valueOf(dn);
                    authors.put(aid, new AuthorInfo(aid, name, death));
                }
            }

            // Then books, joining main_author -> author_name.
            try (ResultSet rs = st.executeQuery("SELECT book_id, book_name, main_author FROM book")) {
                while (rs.next()) {
                    int bid = rs.getInt(1);
                    String name = rs.getString(2);
                    int authorId = rs.getInt(3);
                    boolean authorIsNull = rs.wasNull();
                    String authorName = null;
                    if (!authorIsNull) {
                        AuthorInfo ai = authors.get(authorId);
                        if (ai != null) authorName = ai.authorName();
                    }
                    books.put(bid, new BookInfo(bid, name, authorName));
                }
            }
        }
    }

    public BookInfo bookOrPlaceholder(int bookId) {
        BookInfo info = books.get(bookId);
        if (info != null) return info;
        return new BookInfo(bookId, "(unknown book " + bookId + ")", null);
    }

    public AuthorInfo authorOrPlaceholder(int authorId) {
        AuthorInfo info = authors.get(authorId);
        if (info != null) return info;
        return new AuthorInfo(authorId, "(unknown author " + authorId + ")", null);
    }

    public int bookCount() { return books.size(); }
    public int authorCount() { return authors.size(); }
}
