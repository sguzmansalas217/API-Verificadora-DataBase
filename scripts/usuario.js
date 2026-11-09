// Crea un usuario del sistema o le cambia la contraseña, desde el droplet:
//   docker exec -it api-db-verificadora node scripts/usuario.js
// Pregunta correo, nombre, tipo y contraseña. Si se deja la contraseña vacia, el usuario queda
// sin contraseña: no puede entrar hasta que un Admin le asigne una temporal desde la pantalla Usuarios.
import dotenv from "dotenv";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";
import pkg from "pg";
import { cifrarContrasena, contrasenaValida, crearTablaUsuarios } from "../usuarios.js";

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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await crearTablaUsuarios(pool);

    const email = (await rl.question("Correo: ")).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Correo inválido");
    const nombre = (await rl.question("Nombre (opcional): ")).trim() || null;
    const tipo = (await rl.question("Tipo [Admin/User] (User): ")).trim() || "User";
    if (!["Admin", "User"].includes(tipo)) throw new Error("El tipo debe ser Admin o User");

    const contrasena = await rl.question("Contraseña (vacía = sin contraseña, mínimo 8): ");
    let hash = null;
    if (contrasena) {
      if (!contrasenaValida(contrasena)) throw new Error("La contraseña debe tener al menos 8 caracteres");
      if ((await rl.question("Repite la contraseña: ")) !== contrasena) throw new Error("Las contraseñas no coinciden");
      hash = cifrarContrasena(contrasena);
    }
    const debeCambiar = !hash || /^s/i.test((await rl.question("¿Pedir que la cambie al entrar? [s/N]: ")).trim());

    // Limpia la pantalla para que la contraseña no quede a la vista.
    process.stdout.write("\x1Bc");

    const r = await pool.query(
      `INSERT INTO usuarios_sistema (email, nombre, tipo, password_hash, debe_cambiar)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         nombre = COALESCE(EXCLUDED.nombre, usuarios_sistema.nombre),
         tipo = EXCLUDED.tipo,
         password_hash = COALESCE(EXCLUDED.password_hash, usuarios_sistema.password_hash),
         debe_cambiar = EXCLUDED.debe_cambiar,
         activo = true,
         sesion_version = usuarios_sistema.sesion_version + 1
       RETURNING (xmax = 0) AS nuevo`,
      [email, nombre, tipo, hash, debeCambiar]
    );
    console.log(`✅ ${email} ${r.rows[0].nuevo ? "creado" : "actualizado"} como ${tipo}` +
      (hash ? "" : " (sin contraseña: asígnale una temporal desde la pantalla Usuarios)") +
      (hash && debeCambiar ? " (deberá cambiar la contraseña al entrar)" : ""));
  } catch (error) {
    console.error("❌", error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
