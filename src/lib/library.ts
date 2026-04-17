import "server-only";

import path from "node:path";
import fs from "node:fs";

import Database from "better-sqlite3";

export type LibraryEntry = {
  id: number;
  baseUrl: string;
  bookId: string;
  title: string | null;
  slug: string;
  totalPages: number;
  lastPage: number;
  firstSeenAt: number;
  lastReadAt: number;
};

type LibraryRow = {
  id: number;
  base_url: string;
  book_id: string;
  title: string | null;
  slug: string;
  total_pages: number;
  last_page: number;
  first_seen_at: number;
  last_read_at: number;
};

function rowToEntry(row: LibraryRow): LibraryEntry {
  return {
    id: row.id,
    baseUrl: row.base_url,
    bookId: row.book_id,
    title: row.title,
    slug: row.slug,
    totalPages: row.total_pages,
    lastPage: row.last_page,
    firstSeenAt: row.first_seen_at,
    lastReadAt: row.last_read_at,
  };
}

function resolveDbPath(): string {
  const fromEnv = process.env.LIBRARY_DB_PATH?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return path.join(process.cwd(), "data", "library.db");
}

type Db = ReturnType<typeof Database>;

let dbInstance: Db | null = null;

function getDb(): Db {
  if (dbInstance) return dbInstance;

  const dbPath = resolveDbPath();
  const dir = path.dirname(dbPath);
  // Parent dir needs to exist before better-sqlite3 opens the file.
  // In production this is the mounted volume, in dev it's ./data.
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      base_url      TEXT NOT NULL UNIQUE,
      book_id       TEXT NOT NULL,
      title         TEXT,
      slug          TEXT NOT NULL,
      total_pages   INTEGER NOT NULL,
      last_page     INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_read_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_books_last_read_at
      ON books(last_read_at DESC);
  `);

  dbInstance = db;
  return db;
}

export type UpsertInput = {
  baseUrl: string;
  bookId: string;
  title: string | null;
  slug: string;
  totalPages: number;
};

/**
 * Insert-or-update a book entry keyed on base_url. Preserves last_page and
 * first_seen_at on conflict (only refreshes metadata + last_read_at).
 */
export function upsertBook(input: UpsertInput): LibraryEntry {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO books (
      base_url, book_id, title, slug, total_pages,
      last_page, first_seen_at, last_read_at
    )
    VALUES (@base_url, @book_id, @title, @slug, @total_pages, 1, @now, @now)
    ON CONFLICT(base_url) DO UPDATE SET
      book_id      = excluded.book_id,
      title        = excluded.title,
      slug         = excluded.slug,
      total_pages  = excluded.total_pages,
      last_read_at = excluded.last_read_at
    RETURNING *
  `);

  const row = stmt.get({
    base_url: input.baseUrl,
    book_id: input.bookId,
    title: input.title,
    slug: input.slug,
    total_pages: input.totalPages,
    now,
  }) as LibraryRow;

  return rowToEntry(row);
}

export function listBooks(limit = 50): LibraryEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM books
       ORDER BY last_read_at DESC
       LIMIT ?`,
    )
    .all(limit) as LibraryRow[];
  return rows.map(rowToEntry);
}

export function getBook(id: number): LibraryEntry | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM books WHERE id = ?`)
    .get(id) as LibraryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Update the last_page cursor and bump last_read_at. Silently clamps the
 * page to [1, total_pages] so clients can't persist out-of-range values.
 */
export function updateLastPage(id: number, page: number): LibraryEntry | null {
  const db = getDb();
  const current = getBook(id);
  if (!current) return null;

  const clamped = Math.min(Math.max(1, Math.trunc(page)), current.totalPages);
  const now = Date.now();

  const row = db
    .prepare(
      `UPDATE books
       SET last_page = ?, last_read_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(clamped, now, id) as LibraryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function deleteBook(id: number): boolean {
  const db = getDb();
  const info = db.prepare(`DELETE FROM books WHERE id = ?`).run(id);
  return info.changes > 0;
}
