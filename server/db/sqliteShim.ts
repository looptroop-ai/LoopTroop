import { DatabaseSync, StatementSync } from 'node:sqlite'

export type Statement = StatementSync

/**
 * Compatibility shim wrapping node:sqlite's DatabaseSync to match the
 * better-sqlite3 surface this codebase relies on.
 *
 * node:sqlite (Node 24+) lacks `.pragma()` and `.transaction()` methods. This
 * shim restores them so existing call sites stay unchanged during the swap.
 */
export class Database {
  private readonly db: DatabaseSync
  private transactionDepth = 0

  /**
   * `fileMustExist` is accepted for call-site compatibility but needs no
   * mapping: node:sqlite already fails to open a missing file in readOnly mode,
   * which is the only place this codebase relies on it.
   */
  constructor(path: string, options?: { readonly?: boolean, fileMustExist?: boolean }) {
    this.db = new DatabaseSync(path, options?.readonly ? { readOnly: true } : {})
  }

  /**
   * `PRAGMA x = y` is executed then read back, because SQLite treats several
   * pragmas (journal_mode, synchronous) as read-write and better-sqlite3
   * returns the resulting value rather than nothing.
   */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    const assignment = source.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/)
    const rows = assignment
      ? (this.db.exec(`PRAGMA ${assignment[1]} = ${assignment[2]}`),
        this.db.prepare(`PRAGMA ${assignment[1]}`).all())
      : this.db.prepare(`PRAGMA ${source}`).all()

    if (!options?.simple) return rows

    const first = rows[0]
    if (!first || typeof first !== 'object') return undefined
    const values = Object.values(first)
    return values.length === 1 ? values[0] : values
  }

  /**
   * Mirrors better-sqlite3: the outermost call uses BEGIN/COMMIT, nested calls
   * use SAVEPOINTs, so an inner rollback discards only the inner work.
   */
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A) => {
      if (this.transactionDepth === 0) {
        this.db.exec('BEGIN')
        this.transactionDepth = 1
        try {
          const result = fn(...args)
          this.db.exec('COMMIT')
          return result
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        } finally {
          this.transactionDepth = 0
        }
      }

      const name = `looptroop_sp_${this.transactionDepth}`
      this.db.exec(`SAVEPOINT ${name}`)
      this.transactionDepth += 1
      try {
        const result = fn(...args)
        this.db.exec(`RELEASE ${name}`)
        return result
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}`)
        this.db.exec(`RELEASE ${name}`)
        throw error
      } finally {
        this.transactionDepth -= 1
      }
    }
  }

  /** The wrapped connection, for APIs that need the real node:sqlite type. */
  get client(): DatabaseSync {
    return this.db
  }

  prepare(source: string) {
    return this.db.prepare(source)
  }

  exec(source: string) {
    return this.db.exec(source)
  }

  close() {
    this.db.close()
  }
}
