/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 017 · T15 · Ronda adversarial 1 (API). H-017-1 reproducido de punta a punta: cambiar el tipo de una asignación existente por la
// ruta de 005 no deja rastro en `GET /auditoria` (RF-150, CA-1). La prueba en rojo es el hallazgo; el control positivo (alta nueva)
// muestra que la ruta y la consulta funcionan.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { limpiarAvisosDeEstudios } from "../../../test/soporte-notificaciones.js";

let b: Banco;
let E: Estudio;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
});
afterAll(async () => {
  if (b && E) await limpiarAvisosDeEstudios([E.tenantId]);
  await b?.cerrar();
});

/** Filas de `GET /auditoria` (primera página: el estudio es nuevo) de asignaciones del usuario `u` en el cliente `c`. */
async function asignacionesAuditadas(c: string, u: string): Promise<any[]> {
  const r = await b.llamar(E.titular, "GET", "/auditoria");
  expect(r.status, r.text).toBe(200);
  return (r.body.items as any[]).filter((x) => x.entidad === "asignacion" && x.cliente?.id === c && x.datos?.usuarioId === u);
}

describe("H-017-1 · un cambio de tipo de asignación por la API no llega a la auditoría", () => {
  it("PUT colaborador (alta: auditada) y luego PUT responsable al mismo usuario: la promoción no aparece en GET /auditoria", async () => {
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = (await b.clientes(E.tenantId, 1)) as [string];
    const alta = await b.llamar(E.titular, "PUT", `/clientes/${c}/asignaciones/${m.id}`, { tipo: "colaborador" });
    expect(alta.status, alta.text).toBe(200);
    const antes = await asignacionesAuditadas(c, m.id);
    // Control: el alta sí se audita, con el actor de la sesión.
    expect(antes.map((x) => [x.accion, x.datos.tipo, x.actor.autor?.id])).toEqual([["asignacion.agregada", "colaborador", E.titular.id]]);

    const promocion = await b.llamar(E.titular, "PUT", `/clientes/${c}/asignaciones/${m.id}`, { tipo: "responsable" });
    expect(promocion.status, promocion.text).toBe(200);
    expect((await b.sql("select tipo from asignacion where cliente_id = $1 and usuario_id = $2", [c, m.id]))[0].tipo).toBe("responsable");

    // Contrato de T16 (0045): el cambio de tipo es exactamente UNA fila `asignacion.tipo_cambiado` con `datos {de, a, usuarioId}`.
    const despues = await asignacionesAuditadas(c, m.id);
    expect(
      despues.filter((x) => x.accion === "asignacion.tipo_cambiado").map((x) => [x.datos, x.actor.autor?.id]),
      "la promoción a responsable (quien recibe los avisos de credencial, P-4) no dejó fila",
    ).toEqual([[{ de: "colaborador", a: "responsable", usuarioId: m.id }, E.titular.id]]);
  }, 30_000);
});
