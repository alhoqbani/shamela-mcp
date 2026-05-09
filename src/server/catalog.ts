/**
 * In-memory catalog from master.db: book_id -> (book_name, author_name)
 * and author_id -> (author_name, death_year). Loaded once at server startup
 * via sql.js (WASM SQLite, no native modules).
 */

import * as fs from "node:fs";
import initSqlJs, { type Database } from "sql.js";

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
        return view.buffer as ArrayBuffer;
    }
    return view.slice().buffer as ArrayBuffer;
}

export interface BookInfo {
    book_id: number;
    book_name: string;
    author_name: string | null;
}

export interface AuthorInfo {
    author_id: number;
    author_name: string;
    death_year: number | null;
}

export class Catalog {
    private readonly books = new Map<number, BookInfo>();
    private readonly authors = new Map<number, AuthorInfo>();

    private constructor() {}

    static async load(masterDbPath: string, wasmBinary: Uint8Array): Promise<Catalog> {
        if (!fs.existsSync(masterDbPath)) {
            throw new Error(`master.db not found at ${masterDbPath}`);
        }
        const buffer = fs.readFileSync(masterDbPath);
        const SQL = await initSqlJs({ wasmBinary: toArrayBuffer(wasmBinary) });
        const db: Database = new SQL.Database(new Uint8Array(buffer));
        try {
            const cat = new Catalog();
            cat.loadAuthors(db);
            cat.loadBooks(db);
            return cat;
        } finally {
            db.close();
        }
    }

    private loadAuthors(db: Database): void {
        const stmt = db.prepare("SELECT author_id, author_name, death_number FROM author");
        try {
            while (stmt.step()) {
                const row = stmt.get();
                const authorId = row[0] as number;
                const authorName = (row[1] as string) ?? "";
                const death = row[2];
                this.authors.set(authorId, {
                    author_id: authorId,
                    author_name: authorName,
                    death_year: typeof death === "number" ? death : null,
                });
            }
        } finally {
            stmt.free();
        }
    }

    private loadBooks(db: Database): void {
        const stmt = db.prepare("SELECT book_id, book_name, main_author FROM book");
        try {
            while (stmt.step()) {
                const row = stmt.get();
                const bookId = row[0] as number;
                const bookName = (row[1] as string) ?? "";
                const authorIdRaw = row[2];
                let authorName: string | null = null;
                if (typeof authorIdRaw === "number") {
                    const a = this.authors.get(authorIdRaw);
                    if (a) authorName = a.author_name;
                }
                this.books.set(bookId, { book_id: bookId, book_name: bookName, author_name: authorName });
            }
        } finally {
            stmt.free();
        }
    }

    book(bookId: number): BookInfo {
        return (
            this.books.get(bookId) ?? {
                book_id: bookId,
                book_name: `(unknown book ${bookId})`,
                author_name: null,
            }
        );
    }

    author(authorId: number): AuthorInfo {
        return (
            this.authors.get(authorId) ?? {
                author_id: authorId,
                author_name: `(unknown author ${authorId})`,
                death_year: null,
            }
        );
    }

    bookCount(): number {
        return this.books.size;
    }
    authorCount(): number {
        return this.authors.size;
    }
}
