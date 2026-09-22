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
    await client.query(`
      CREATE TABLE IF NOT EXISTS orden_trabajo_folios (
        numero SERIAL PRIMARY KEY,
        parque TEXT,
        cliente TEXT,
        telefono TEXT,
        fecha DATE,
        factura_or TEXT,
        razon_social TEXT,
        rfc TEXT,
        calle_numero TEXT,
        colonia TEXT,
        estado_municipio TEXT,
        mail TEXT,
        tipo_emisiones BOOLEAN DEFAULT false,
        tipo_fisico BOOLEAN DEFAULT false,
        tipo_estatal BOOLEAN DEFAULT false,
        total NUMERIC,
        vehiculos JSONB NOT NULL DEFAULT '[]',
        usuarioactual TEXT,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query("COMMIT");
    console.log("OK: tabla 'orden_trabajo_folios' creada (o ya existía). El folio F###### sale de 'numero' (SERIAL, atomico, nunca se reinicia). Guarda la orden completa (vehiculos incluido) para poder reimprimir.");
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
