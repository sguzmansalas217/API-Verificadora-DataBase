import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const BASE = "http://localhost:3000";
const API_KEY = process.env.API_KEY;

async function call(nombreCaso, body) {
  const res = await fetch(`${BASE}/registrofederal-folio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`\n--- ${nombreCaso} ---`);
  console.log("status:", res.status);
  console.log("body:", JSON.stringify(data, null, 2));
  return { status: res.status, data };
}

async function main() {
  await call("1) Emisiones periodo 1", {
    folio: "12345", placa: "774RP3", nombre: "TURISMO AUTOCLASS", fecha: "2026-03-15"
  });

  await call("2) Emisiones periodo 2", {
    folio: "67890", placa: "774RP3", nombre: "TURISMO AUTOCLASS", fecha: "2026-09-10"
  });

  await call("3) Fisico Motriz", {
    folio: "M100", placa: "774RP3", nombre: "TURISMO AUTOCLASS", fecha: "2026-05-01"
  });

  await call("3b) Fisico Arrastre", {
    folio: "A200", placa: "130RR4", nombre: "TURISMO AUTOCLASS", fecha: "2026-05-01"
  });

  await call("4) Placa no encontrada", {
    folio: "999", placa: "ZZZZZZ999", nombre: "NADIE", fecha: "2026-05-01"
  });

  const nombreLibre = await call("5) Nombre distinto al propietario ahora se acepta (solo importa la placa)", {
    folio: "111", placa: "774RP3", nombre: "OTRO NOMBRE", fecha: "2026-05-01"
  });

  if (nombreLibre.status === 409 && nombreLibre.data.requiereConfirmacion) {
    await call("5b) Confirmar sobrescritura con nombre distinto", {
      folio: "111", placa: "774RP3", nombre: "OTRO NOMBRE", fecha: "2026-05-01",
      confirmarSobrescritura: true
    });
  }

  const ambigua = await call("6) Placa ambigua (DOLLY)", {
    folio: "555", placa: "DOLLY", nombre: "SERVICIO DE CARGA ESTRELLA BLANCA", fecha: "2026-05-01"
  });

  if (ambigua.status === 409 && Array.isArray(ambigua.data.candidatos)) {
    const elegido = ambigua.data.candidatos[0];
    console.log(`\nCandidatos encontrados: ${ambigua.data.candidatos.length}. Eligiendo id=${elegido.id}`);
    await call("6b) Placa ambigua resuelta con registrofederal_id", {
      folio: "555", placa: "DOLLY", nombre: "SERVICIO DE CARGA ESTRELLA BLANCA", fecha: "2026-05-01",
      registrofederal_id: elegido.id
    });
  }

  const sobrescritura = await call("7) Intentar sobrescribir emisiones1 sin confirmar", {
    folio: "22222", placa: "774RP3", nombre: "TURISMO AUTOCLASS", fecha: "2026-02-01"
  });

  if (sobrescritura.status === 409 && sobrescritura.data.requiereConfirmacion) {
    await call("7b) Confirmar sobrescritura", {
      folio: "22222", placa: "774RP3", nombre: "TURISMO AUTOCLASS", fecha: "2026-02-01",
      confirmarSobrescritura: true
    });
  }
}

main().catch(err => {
  console.error("ERROR:", err.message);
  process.exitCode = 1;
});
