// 🔹 Control de pago del sistema: cada mes vence el pago en el dia configurado. Si no se registra
// el pago, los usuarios ven un aviso durante los dias de gracia y despues el sistema se suspende
// para todos menos el super admin, que es quien registra los pagos y cambia la configuracion.

const listaCorreos = (valor) => valor.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const SUPER_ADMINS = listaCorreos(process.env.SUPER_ADMIN || "sguzmansalas217@gmail.com");

const esSuperAdmin = (req) => SUPER_ADMINS.includes((req.user?.email || "").toLowerCase());

// Las fechas se manejan como texto YYYY-MM-DD en hora de Mexico, sin depender de la zona del servidor.
const hoyMexico = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const diaNumero = (fecha) => Date.UTC(...fecha.split("-").map((n, i) => Number(n) - (i === 1 ? 1 : 0))) / 86400000;
const FECHA_VALIDA = /^\d{4}-\d{2}-\d{2}$/;

// El dia de pago del mes siguiente a `fecha` (dia_pago va de 1 a 28, asi existe en todos los meses).
function mesSiguiente(fecha, diaPago) {
  const [a, m] = fecha.split("-").map(Number);
  const siguiente = new Date(Date.UTC(a, m, diaPago)); // m ya es el mes siguiente (base 0)
  return siguiente.toISOString().slice(0, 10);
}

export async function crearTablaPago(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_pago (
      id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      dia_pago        INTEGER NOT NULL DEFAULT 5,
      dias_gracia     INTEGER NOT NULL DEFAULT 3,
      pagado_hasta    DATE NOT NULL,
      activo          BOOLEAN NOT NULL DEFAULT true,
      actualizado_por TEXT,
      actualizado_en  TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS control_pago_historial (
      id      SERIAL PRIMARY KEY,
      accion  TEXT NOT NULL,
      detalle TEXT,
      usuario TEXT,
      creado  TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  // Al crearla por primera vez queda pagado hasta el dia 5 del mes siguiente, para no bloquear a nadie.
  await pool.query(
    `INSERT INTO control_pago (id, pagado_hasta) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [mesSiguiente(hoyMexico(), 5)]
  );
}

async function leerControl(pool) {
  const r = await pool.query(
    `SELECT dia_pago, dias_gracia, to_char(pagado_hasta, 'YYYY-MM-DD') AS pagado_hasta, activo,
            actualizado_por, actualizado_en
     FROM control_pago WHERE id = 1`
  );
  return r.rows[0] || null;
}

// 'al_corriente', 'aviso' (con los dias que faltan para suspender) o 'suspendido'.
function calcularEstado(control) {
  if (!control || !control.activo) return { estado: "al_corriente" };
  const vencido = diaNumero(hoyMexico()) - diaNumero(control.pagado_hasta);
  if (vencido <= 0) return { estado: "al_corriente" };
  if (vencido <= control.dias_gracia) return { estado: "aviso", diasRestantes: control.dias_gracia - vencido + 1 };
  return { estado: "suspendido" };
}

// Se consulta en cada peticion, asi que se guarda un minuto en memoria.
let cache = { estado: null, hasta: 0 };
async function estadoActual(pool) {
  if (Date.now() < cache.hasta) return cache.estado;
  const estado = calcularEstado(await leerControl(pool));
  cache = { estado, hasta: Date.now() + 60_000 };
  return estado;
}

// La usa verificarApiKey: true si a este usuario se le debe negar el acceso.
// Si la base falla no se bloquea a nadie, para que un error no tumbe el sistema.
export async function sistemaSuspendido(pool, req) {
  if (esSuperAdmin(req)) return false;
  try {
    return (await estadoActual(pool)).estado === "suspendido";
  } catch (error) {
    console.error("⚠️ No se pudo revisar el control de pago:", error.message);
    return false;
  }
}

export function registrarRutasPago(app, { pool, verificarApiKey }) {
  const soloSuperAdmin = [verificarApiKey, (req, res, next) =>
    esSuperAdmin(req) ? next() : res.status(403).json({ error: "Sin acceso" })];

  const historial = (req, accion, detalle) => pool.query(
    `INSERT INTO control_pago_historial (accion, detalle, usuario) VALUES ($1, $2, $3)`,
    [accion, detalle, req.user?.email || null]
  );

  // Respuesta comun: estado para todos; configuracion e historial solo para el super admin.
  async function respuesta(req) {
    const control = await leerControl(pool);
    const estado = calcularEstado(control);
    if (!esSuperAdmin(req)) return estado;
    const h = await pool.query(
      `SELECT accion, detalle, usuario, to_char(creado, 'YYYY-MM-DD HH24:MI') AS creado
       FROM control_pago_historial ORDER BY id DESC LIMIT 20`
    );
    return { ...estado, superAdmin: true, hoy: hoyMexico(), control, historial: h.rows };
  }

  app.get("/pago/estado", verificarApiKey, async (req, res) => {
    try {
      res.json(await respuesta(req));
    } catch (error) {
      console.error("Error al leer el control de pago:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Registra un mes pagado: pagado_hasta avanza al dia de pago del mes siguiente.
  app.post("/pago/registrar", ...soloSuperAdmin, async (req, res) => {
    try {
      const control = await leerControl(pool);
      const nuevo = mesSiguiente(control.pagado_hasta, control.dia_pago);
      await pool.query(
        `UPDATE control_pago SET pagado_hasta = $1, actualizado_por = $2, actualizado_en = now() WHERE id = 1`,
        [nuevo, req.user.email]
      );
      await historial(req, "Pago registrado", `Pagado hasta ${nuevo}`);
      cache.hasta = 0;
      res.json(await respuesta(req));
    } catch (error) {
      console.error("Error al registrar el pago:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/pago/config", ...soloSuperAdmin, async (req, res) => {
    const { dia_pago, dias_gracia, pagado_hasta, activo } = req.body || {};
    const entero = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    if (!entero(dia_pago, 1, 28)) return res.status(400).json({ error: "El día de pago debe ser de 1 a 28" });
    if (!entero(dias_gracia, 0, 15)) return res.status(400).json({ error: "Los días de aviso deben ser de 0 a 15" });
    if (!FECHA_VALIDA.test(pagado_hasta || "")) return res.status(400).json({ error: "Fecha de pagado hasta inválida" });
    if (typeof activo !== "boolean") return res.status(400).json({ error: "Valor de activo inválido" });
    try {
      await pool.query(
        `UPDATE control_pago SET dia_pago = $1, dias_gracia = $2, pagado_hasta = $3, activo = $4,
                actualizado_por = $5, actualizado_en = now()
         WHERE id = 1`,
        [dia_pago, dias_gracia, pagado_hasta, activo, req.user.email]
      );
      await historial(req, "Configuración", `Día ${dia_pago}, aviso ${dias_gracia} días, pagado hasta ${pagado_hasta}, ${activo ? "cobro activo" : "cobro desactivado"}`);
      cache.hasta = 0;
      res.json(await respuesta(req));
    } catch (error) {
      console.error("Error al guardar el control de pago:", error);
      res.status(500).json({ error: error.message });
    }
  });
}
