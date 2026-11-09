// 🔹 Usuarios y sesiones propios (reemplaza a Firebase Authentication).
// Las contraseñas se guardan con scrypt (sal aleatoria, no se pueden descifrar) y la sesion es un
// token firmado con SESION_SECRETO que vence en 12 horas. En cada peticion se vuelve a leer el
// usuario, asi un cambio de tipo, desactivar o cambiar contraseña surte efecto de inmediato.
import crypto from "crypto";
import { esSuperAdmin } from "./controlPago.js";

const DURACION_SESION_MS = 12 * 60 * 60 * 1000;
const MIN_CONTRASENA = 8;
const TIPOS = ["Admin", "User"];

let SECRETO = process.env.SESION_SECRETO;
if (!SECRETO) {
  SECRETO = crypto.randomBytes(32).toString("hex");
  console.warn("⚠️ Falta SESION_SECRETO en el .env: las sesiones se cierran cada vez que se reinicia la API");
}

// ------------------ CONTRASEÑAS ------------------
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function cifrarContrasena(contrasena) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(contrasena, sal, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString("base64")}$${hash.toString("base64")}`;
}

function contrasenaCorrecta(contrasena, guardado) {
  if (!guardado) return false;
  const [alg, N, r, p, sal, hash] = guardado.split("$");
  if (alg !== "scrypt") return false;
  const esperado = Buffer.from(hash, "base64");
  const calculado = crypto.scryptSync(contrasena, Buffer.from(sal, "base64"), esperado.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(esperado, calculado);
}

export const contrasenaValida = (c) => typeof c === "string" && c.length >= MIN_CONTRASENA && c.length <= 200;

// ------------------ TOKEN DE SESION ------------------
// payload.firma: base64url. version cambia al cambiar la contraseña y cierra las sesiones anteriores.
const firmar = (datos) => crypto.createHmac("sha256", SECRETO).update(datos).digest("base64url");

function crearToken(usuario) {
  const datos = Buffer.from(JSON.stringify({ id: usuario.id, v: usuario.sesion_version, exp: Date.now() + DURACION_SESION_MS })).toString("base64url");
  return `${datos}.${firmar(datos)}`;
}

function leerToken(token) {
  const [datos, firma] = (token || "").split(".");
  if (!datos || !firma || token.split(".").length !== 2) return null;
  const esperada = Buffer.from(firmar(datos));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
  try {
    const payload = JSON.parse(Buffer.from(datos, "base64url").toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// Forma del usuario que reciben las rutas (req.user) y la pantalla.
const publico = (u) => ({
  uid: String(u.id), id: u.id, email: u.email, nombre: u.nombre, tipoUsuario: u.tipo,
  activo: u.activo, debeCambiar: u.debe_cambiar,
});

const COLUMNAS = `id, email, nombre, tipo, activo, debe_cambiar, sesion_version, password_hash,
                  to_char(ultimo_acceso, 'YYYY-MM-DD HH24:MI') AS ultimo_acceso`;

// La usa verificarApiKey: devuelve el usuario de la sesion o null si el token no sirve.
export async function verificarSesion(pool, token) {
  const payload = leerToken(token);
  if (!payload) return null;
  const r = await pool.query(`SELECT ${COLUMNAS} FROM usuarios_sistema WHERE id = $1`, [payload.id]);
  const u = r.rows[0];
  if (!u || !u.activo || u.sesion_version !== payload.v) return null;
  return publico(u);
}

export async function crearTablaUsuarios(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios_sistema (
      id             SERIAL PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE,
      nombre         TEXT,
      tipo           TEXT NOT NULL DEFAULT 'User' CHECK (tipo IN ('Admin', 'User')),
      activo         BOOLEAN NOT NULL DEFAULT true,
      password_hash  TEXT,
      debe_cambiar   BOOLEAN NOT NULL DEFAULT true,
      sesion_version INTEGER NOT NULL DEFAULT 0,
      creado         TIMESTAMP NOT NULL DEFAULT now(),
      ultimo_acceso  TIMESTAMP
    );
  `);
}

// ------------------ INTENTOS FALLIDOS ------------------
// 5 fallos seguidos con el mismo correo lo bloquean 15 minutos (en memoria, se limpia al reiniciar).
const fallos = new Map();
const BLOQUEO_MS = 15 * 60 * 1000;

function bloqueado(email) {
  const f = fallos.get(email);
  return f && f.hasta > Date.now();
}
function registrarFallo(email) {
  const f = fallos.get(email) || { n: 0, hasta: 0 };
  f.n++;
  if (f.n >= 5) { f.n = 0; f.hasta = Date.now() + BLOQUEO_MS; }
  fallos.set(email, f);
}

// ------------------ RUTAS ------------------
export function registrarRutasUsuarios(app, { pool, verificarApiKey, soloApiKey }) {
  const esAdmin = (req) => req.user?.tipoUsuario === "Admin" || esSuperAdmin(req);
  const soloAdmin = [verificarApiKey, (req, res, next) => (esAdmin(req) ? next() : res.status(403).json({ error: "Solo administradores" }))];
  const correo = (v) => (v || "").toString().trim().toLowerCase();

  app.post("/auth/login", soloApiKey, async (req, res) => {
    const email = correo(req.body?.email);
    const contrasena = (req.body?.contrasena || "").toString();
    if (bloqueado(email)) return res.status(429).json({ error: "Demasiados intentos. Espera 15 minutos." });
    try {
      const r = await pool.query(`SELECT ${COLUMNAS} FROM usuarios_sistema WHERE email = $1`, [email]);
      const u = r.rows[0];
      if (!u || !u.activo || !contrasenaCorrecta(contrasena, u.password_hash)) {
        registrarFallo(email);
        return res.status(401).json({ error: "Correo o contraseña incorrectos" });
      }
      fallos.delete(email);
      await pool.query(`UPDATE usuarios_sistema SET ultimo_acceso = now() WHERE id = $1`, [u.id]);
      res.json({ token: crearToken(u), usuario: publico(u) });
    } catch (error) {
      console.error("Error en login:", error);
      res.status(500).json({ error: "Error al iniciar sesión" });
    }
  });

  app.get("/auth/yo", verificarApiKey, (req, res) => res.json(req.user));

  // Cada usuario cambia su propia contraseña; pide la actual. Devuelve un token nuevo
  // porque las sesiones anteriores (otros dispositivos) se cierran.
  app.post("/auth/cambiar-contrasena", verificarApiKey, async (req, res) => {
    const { actual, nueva } = req.body || {};
    if (!contrasenaValida(nueva)) return res.status(400).json({ error: `La contraseña nueva debe tener al menos ${MIN_CONTRASENA} caracteres` });
    if (nueva === actual) return res.status(400).json({ error: "La contraseña nueva debe ser distinta a la actual" });
    try {
      const r = await pool.query(`SELECT ${COLUMNAS} FROM usuarios_sistema WHERE id = $1`, [req.user.id]);
      const u = r.rows[0];
      if (!u || !contrasenaCorrecta((actual || "").toString(), u.password_hash)) {
        return res.status(400).json({ error: "La contraseña actual no es correcta" });
      }
      const act = await pool.query(
        `UPDATE usuarios_sistema SET password_hash = $1, debe_cambiar = false, sesion_version = sesion_version + 1
         WHERE id = $2 RETURNING ${COLUMNAS}`,
        [cifrarContrasena(nueva), u.id]
      );
      res.json({ token: crearToken(act.rows[0]), usuario: publico(act.rows[0]) });
    } catch (error) {
      console.error("Error al cambiar contraseña:", error);
      res.status(500).json({ error: "No se pudo cambiar la contraseña" });
    }
  });

  // ---------- Administracion (solo Admin) ----------
  const protegido = (u) => esSuperAdmin({ user: { email: u.email } });

  app.get("/usuarios", ...soloAdmin, async (req, res) => {
    try {
      const r = await pool.query(`SELECT ${COLUMNAS} FROM usuarios_sistema ORDER BY email`);
      res.json(r.rows.map(u => ({
        ...publico(u), ultimoAcceso: u.ultimo_acceso, sinContrasena: !u.password_hash, protegido: protegido(u),
      })));
    } catch (error) {
      console.error("Error al listar usuarios:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/usuarios", ...soloAdmin, async (req, res) => {
    const email = correo(req.body?.email);
    const { nombre, tipo, contrasena } = req.body || {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Correo inválido" });
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: "Tipo de usuario inválido" });
    if (!contrasenaValida(contrasena)) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres` });
    try {
      await pool.query(
        `INSERT INTO usuarios_sistema (email, nombre, tipo, password_hash, debe_cambiar) VALUES ($1, $2, $3, $4, true)`,
        [email, (nombre || "").toString().trim() || null, tipo, cifrarContrasena(contrasena)]
      );
      res.json({ ok: true });
    } catch (error) {
      if (error.code === "23505") return res.status(400).json({ error: "Ese correo ya está registrado" });
      console.error("Error al crear usuario:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Cambia tipo (Admin/User). Nadie cambia su propio tipo ni toca al super admin.
  app.put("/usuarios/:id", ...soloAdmin, async (req, res) => {
    const { tipo } = req.body || {};
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: "Tipo de usuario inválido" });
    try {
      const r = await pool.query(`SELECT ${COLUMNAS} FROM usuarios_sistema WHERE id = $1`, [req.params.id]);
      const u = r.rows[0];
      if (!u) return res.status(404).json({ error: "Usuario no encontrado" });
      if (protegido(u)) return res.status(403).json({ error: "Esta cuenta no se puede modificar" });
      if (u.id === req.user.id) return res.status(400).json({ error: "No puedes cambiar tu propio tipo" });
      await pool.query(`UPDATE usuarios_sistema SET tipo = $1 WHERE id = $2`, [tipo, u.id]);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error al cambiar tipo de usuario:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Contraseña temporal: el usuario debe cambiarla al entrar y se cierran sus sesiones abiertas.
  app.post("/usuarios/:id/contrasena-temporal", ...soloAdmin, async (req, res) => {
    const { contrasena } = req.body || {};
    if (!contrasenaValida(contrasena)) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres` });
    try {
      const r = await pool.query(`SELECT ${COLUMNAS} FROM usuarios_sistema WHERE id = $1`, [req.params.id]);
      const u = r.rows[0];
      if (!u) return res.status(404).json({ error: "Usuario no encontrado" });
      if (protegido(u)) return res.status(403).json({ error: "Esta cuenta no se puede modificar" });
      await pool.query(
        `UPDATE usuarios_sistema SET password_hash = $1, debe_cambiar = true, sesion_version = sesion_version + 1 WHERE id = $2`,
        [cifrarContrasena(contrasena), u.id]
      );
      fallos.delete(u.email);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error al asignar contraseña temporal:", error);
      res.status(500).json({ error: error.message });
    }
  });
}
