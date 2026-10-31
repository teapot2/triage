import { Client } from "pg";
import { shopfrontDatabaseUrl } from "../live/live-source";
import { exec, sandboxEnv, trim } from "./sandbox";

// A throwaway copy of the app's database for one sandbox run, so a
// regression test can write (create the rows it needs, call code that
// inserts) without changing the database the app serves from. Postgres
// won't copy a database while anything else is connected to it (CREATE
// DATABASE … TEMPLATE), and the app always is, so the copy is built: an
// empty database, the app's own Drizzle migrations as they are in the
// sandbox, then every table's rows and every sequence's position, read in
// one snapshot. A fix's new migration isn't in the sandbox yet when the
// copy is made, so it never runs here (data-change.ts). Needs a database
// user that can create databases.

// Postgres truncates identifiers longer than this.
const MAX_IDENTIFIER = 63;

// Drizzle keeps its record of applied migrations here; the migrator writes
// the copy's own.
const MIGRATIONS_SCHEMA = "drizzle";

// Run with the sandbox as the working directory, so the imports resolve to
// the app's own drizzle-orm.
const MIGRATE = `
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
const db = drizzle(process.env.DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: "drizzle" });
} finally {
  await db.$client.end();
}
`;

// The copy's name: the source's, marked as a sandbox and by what it's for.
export function copyName(source: string, purpose: string): string {
  const slug = purpose.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${source}_sandbox_${slug}`.slice(0, MAX_IDENTIFIER);
}

// The same server and credentials, another database.
export function databaseUrlFor(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, application_name: "triage-sandbox" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// FORCE: a test that leaked connections may still hold some.
const dropSql = (name: string) => `DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`;

export type SandboxDatabase = { name: string; url: string; drop: () => Promise<void> };

export async function createSandboxDatabase(
  dir: string,
  purpose: string,
  sourceUrl = shopfrontDatabaseUrl,
): Promise<SandboxDatabase> {
  const name = copyName(decodeURIComponent(new URL(sourceUrl).pathname.slice(1)), purpose);
  const url = databaseUrlFor(sourceUrl, name);
  // A copy left behind by a run that crashed goes first.
  await withClient(sourceUrl, async (c) => {
    await c.query(dropSql(name));
    await c.query(`CREATE DATABASE ${ident(name)}`);
  });
  const drop = () => withClient(sourceUrl, (c) => c.query(dropSql(name))).then(() => undefined, () => undefined);
  try {
    const migrated = await exec(process.execPath, ["--input-type=module", "-e", MIGRATE], dir, sandboxEnv(url));
    if (migrated.exitCode !== 0) throw new Error(`the app's migrations failed on the copy:\n${trim(migrated.output)}`);
    await copyData(sourceUrl, url);
  } catch (err) {
    await drop();
    throw err;
  }
  return { name, url, drop };
}

// Every row of every table the copy has, and where each sequence stands.
// Rows travel as JSON, which every column type converts to and from.
async function copyData(sourceUrl: string, copyUrl: string) {
  await withClient(sourceUrl, (from) =>
    withClient(copyUrl, async (to) => {
      await from.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // Foreign keys aren't checked while copying, so tables go in any order.
      await to.query("BEGIN");
      await to.query("SET LOCAL session_replication_role = replica");
      const { rows: tables } = await to.query<{ schema: string; table: string; columns: string[] }>(
        `SELECT c.table_schema AS schema, c.table_name AS table,
                array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM information_schema.columns c
           JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE t.table_type = 'BASE TABLE'
            AND c.table_schema NOT IN ('pg_catalog', 'information_schema', $1)
            AND c.is_generated = 'NEVER'
          GROUP BY 1, 2`,
        [MIGRATIONS_SCHEMA],
      );
      for (const { schema, table, columns } of tables) {
        const qualified = `${ident(schema)}.${ident(table)}`;
        // A table the app's migrations make but the database doesn't have.
        const { rows: found } = await from.query("SELECT to_regclass($1) IS NOT NULL AS ok", [qualified]);
        if (!found[0].ok) continue;
        const { rows } = await from.query<{ data: string | null }>(`SELECT json_agg(t)::text AS data FROM ${qualified} t`);
        if (!rows[0].data) continue;
        const list = columns.map(ident).join(", ");
        await to.query(
          `INSERT INTO ${qualified} (${list}) OVERRIDING SYSTEM VALUE
           SELECT ${list} FROM json_populate_recordset(NULL::${qualified}, $1::json)`,
          [rows[0].data],
        );
      }
      const { rows: sequences } = await from.query<{ name: string; value: string }>(
        `SELECT format('%I.%I', schemaname, sequencename) AS name, last_value::text AS value
           FROM pg_sequences
          WHERE last_value IS NOT NULL AND schemaname <> $1`,
        [MIGRATIONS_SCHEMA],
      );
      for (const { name, value } of sequences) {
        await to.query("SELECT setval(r, $2::bigint) FROM to_regclass($1) r WHERE r IS NOT NULL", [name, value]);
      }
      await to.query("COMMIT");
      await from.query("COMMIT");
    }),
  );
}
