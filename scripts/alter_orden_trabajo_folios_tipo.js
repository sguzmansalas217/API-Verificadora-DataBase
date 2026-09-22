import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`ALTER TABLE orden_trabajo_folios ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'federal';`);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE orden_trabajo_folios ADD CONSTRAINT orden_trabajo_folios_tipo_chk CHECK (tipo IN ('federal','estatal'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await client.query(`ALTER TABLE orden_trabajo_folios DROP CONSTRAINT IF EXISTS orden_trabajo_folios_pkey;`);
    await client.query(`ALTER TABLE orden_trabajo_folios ALTER COLUMN numero DROP DEFAULT;`);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE orden_trabajo_folios ADD PRIMARY KEY (tipo, numero);
      EXCEPTION WHEN invalid_table_definition THEN NULL; END $$;
    `);

    await client.query(`CREATE SEQUENCE IF NOT EXISTS orden_trabajo_folio_federal_seq;`);
    await client.query(`CREATE SEQUENCE IF NOT EXISTS orden_trabajo_folio_estatal_seq;`);

    await client.query(`
      SELECT setval('orden_trabajo_folio_federal_seq',
        COALESCE((SELECT MAX(numero) FROM orden_trabajo_folios WHERE tipo = 'federal'), 0) + 1, false);
    `);

    await client.query("COMMIT");
    console.log("OK: 'orden_trabajo_folios' ahora soporta tipo ('federal'/'estatal') con folio y contador independiente por tipo. La secuencia federal continua donde iba; la estatal (E######) arranca en 1.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
