// 🔹 Usuarios y sesiones propios (reemplaza a Firebase Authentication).
// Las contraseñas se guardan con scrypt (sal aleatoria, no se pueden descifrar) y la sesion es un
// token firmado con SESION_SECRETO que vence en 12 horas. En cada peticion se vuelve a leer el
// usuario, asi un cambio de tipo, desactivar o cambiar contraseña surte efecto de inmediato.
import crypto from "crypto";
import { esSuperAdmin } from "./controlPago.js";

const DURACION_SESION_MS = 12 * 60 * 60 * 1000;
const MIN_CONTRASENA = 8;
const TIPOS = ["Admin", "User"];

// Unicos que administran usuarios (crear, editar, eliminar, cambiar tipo, contraseña temporal).
// Los demas, aunque sean Admin, solo cambian su propia contraseña y su perfil.
const GESTORES = (process.env.USUARIOS_GESTORES || "sguzmansalas217@gmail.com,robertomuniz1096@gmail.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const esGestor = (email) => GESTORES.includes((email || "").toLowerCase()) || esSuperAdmin({ user: { email } });

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
  activo: u.activo, debeCambiar: u.debe_cambiar, gestorUsuarios: esGestor(u.email),
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
  const soloGestor = [verificarApiKey, (req, res, next) =>
    (esGestor(req.user?.email) ? next() : res.status(403).json({ error: "No tienes permiso para administrar usuarios" }))];
  const correo = (v) => (v || "").toString().trim().toLowerCase();
  const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const limpiarNombre = (v) => (v || "").toString().trim().slice(0, 120) || null;

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

  // Cada usuario edita su propio perfil (nombre).
  app.put("/auth/perfil", verificarApiKey, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE usuarios_sistema SET nombre = $1 WHERE id = $2 RETURNING ${COLUMNAS}`,
        [limpiarNombre(req.body?.nombre), req.user.id]
      );
      res.json(publico(r.rows[0]));
    } catch (error) {
      console.error("Error al guardar perfil:", error);
      res.status(500).json({ error: "No se pudo guardar el perfil" });
    }
  });

  // ---------- Administracion (solo USUARIOS_GESTORES) ----------
  const protegido = (u) => esSuperAdmin({ user: { email: u.email } });

  // Busca al usuario de :id y aplica las reglas comunes: existe y no es el super admin
  // (salvo que el propio super admin se edite a si mismo).
  async function usuarioEditable(req, res) {
    const r = await pool.query(`SELECT ${COLUMNAS} FROM usuarios_sistema WHERE id = $1`, [req.params.id]);
    const u = r.rows[0];
    if (!u) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return null;
    }
    if (protegido(u) && u.id !== req.user.id) {
      res.status(403).json({ error: "Esta cuenta no se puede modificar" });
      return null;
    }
    return u;
  }

  app.get("/usuarios", ...soloGestor, async (req, res) => {
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

  app.post("/usuarios", ...soloGestor, async (req, res) => {
    const email = correo(req.body?.email);
    const { nombre, tipo, contrasena } = req.body || {};
    if (!CORREO_VALIDO.test(email)) return res.status(400).json({ error: "Correo inválido" });
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: "Tipo de usuario inválido" });
    if (!contrasenaValida(contrasena)) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres` });
    try {
      await pool.query(
        `INSERT INTO usuarios_sistema (email, nombre, tipo, password_hash, debe_cambiar) VALUES ($1, $2, $3, $4, true)`,
        [email, limpiarNombre(nombre), tipo, cifrarContrasena(contrasena)]
      );
      res.json({ ok: true });
    } catch (error) {
      if (error.code === "23505") return res.status(400).json({ error: "Ese correo ya está registrado" });
      console.error("Error al crear usuario:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Edita perfil y tipo: { nombre?, email?, tipo? }. Nadie cambia su propio tipo.
  app.put("/usuarios/:id", ...soloGestor, async (req, res) => {
    const body = req.body || {};
    if (body.tipo !== undefined && !TIPOS.includes(body.tipo)) return res.status(400).json({ error: "Tipo de usuario inválido" });
    if (body.email !== undefined && !CORREO_VALIDO.test(correo(body.email))) return res.status(400).json({ error: "Correo inválido" });
    try {
      const u = await usuarioEditable(req, res);
      if (!u) return;
      if (body.tipo !== undefined && body.tipo !== u.tipo && u.id === req.user.id) {
        return res.status(400).json({ error: "No puedes cambiar tu propio tipo" });
      }
      // Si cambia el correo de alguien, sus sesiones se cierran (entra con el correo nuevo).
      const nuevoCorreo = body.email !== undefined ? correo(body.email) : u.email;
      await pool.query(
        `UPDATE usuarios_sistema SET nombre = $1, email = $2, tipo = $3,
                sesion_version = sesion_version + CASE WHEN $2 <> email THEN 1 ELSE 0 END
         WHERE id = $4`,
        [body.nombre !== undefined ? limpiarNombre(body.nombre) : u.nombre, nuevoCorreo, body.tipo ?? u.tipo, u.id]
      );
      res.json({ ok: true });
    } catch (error) {
      if (error.code === "23505") return res.status(400).json({ error: "Ese correo ya está registrado" });
      console.error("Error al editar usuario:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Elimina la cuenta. Sus registros en la base se conservan (guardan el correo como texto).
  app.delete("/usuarios/:id", ...soloGestor, async (req, res) => {
    try {
      const u = await usuarioEditable(req, res);
      if (!u) return;
      if (u.id === req.user.id) return res.status(400).json({ error: "No puedes eliminar tu propia cuenta" });
      if (protegido(u)) return res.status(403).json({ error: "Esta cuenta no se puede eliminar" });
      await pool.query(`DELETE FROM usuarios_sistema WHERE id = $1`, [u.id]);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error al eliminar usuario:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Contraseña temporal: el usuario debe cambiarla al entrar y se cierran sus sesiones abiertas.
  // A uno mismo no (para eso esta cambiar contraseña).
  app.post("/usuarios/:id/contrasena-temporal", ...soloGestor, async (req, res) => {
    const { contrasena } = req.body || {};
    if (!contrasenaValida(contrasena)) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres` });
    try {
      const u = await usuarioEditable(req, res);
      if (!u) return;
      if (u.id === req.user.id) return res.status(400).json({ error: "Para tu cuenta usa Cambiar contraseña" });
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
