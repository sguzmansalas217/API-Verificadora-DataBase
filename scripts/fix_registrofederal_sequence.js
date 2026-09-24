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

// La columna 'id' de registrofederal es SERIAL, pero en algun momento se
// insertaron filas con id explicito (ej. una restauracion de datos), asi que
// la secuencia interna quedo atrasada respecto al maximo id real. Eso causa
// "duplicate key value violates unique constraint registrofederal_pkey" al
// intentar dar de alta un vehiculo nuevo. Este script resincroniza la
// secuencia al MAX(id) real de la tabla; es seguro correrlo mas de una vez.
async function main() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT setval(
        pg_get_serial_sequence('registrofederal', 'id'),
        COALESCE((SELECT MAX(id) FROM registrofederal), 0) + 1,
        false
      ) AS siguiente_id;
    `);
    console.log(`OK: secuencia de registrofederal resincronizada. Siguiente id a usar: ${result.rows[0].siguiente_id}`);
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
