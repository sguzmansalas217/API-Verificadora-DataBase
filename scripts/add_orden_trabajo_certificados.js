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

// Certificados que incluye la orden (Fisico / Emisiones 1 / Emisiones 2).
// Reemplazan a tipo_emisiones/tipo_fisico/tipo_estatal, que se dejan en la
// tabla sin usar para no perder datos de ordenes ya generadas.
async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE orden_trabajo_folios ADD COLUMN IF NOT EXISTS cert_fisico BOOLEAN;`);
    await client.query(`ALTER TABLE orden_trabajo_folios ADD COLUMN IF NOT EXISTS cert_emisiones1 BOOLEAN;`);
    await client.query(`ALTER TABLE orden_trabajo_folios ADD COLUMN IF NOT EXISTS cert_emisiones2 BOOLEAN;`);
    await client.query("COMMIT");
    console.log("OK: columnas cert_fisico, cert_emisiones1 y cert_emisiones2 agregadas (o ya existian) en orden_trabajo_folios.");
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
