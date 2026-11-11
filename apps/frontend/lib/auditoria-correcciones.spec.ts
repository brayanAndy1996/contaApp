import { describe, expect, it } from "vitest";
import { textoAccion, textoDetalle } from "./auditoria";

// Spec 017 · T16 (rojo). Ronda adversarial R1: las 4 acciones nuevas del catálogo (H-017-1 y H-017-2) salen en español en la tabla de
// auditoría, nunca como código crudo ni con el texto genérico de «acción fuera del catálogo». Contrato de `datos` (ver
// tests/aislamiento/auditoria-correcciones.spec.ts):
//   asignacion.tipo_cambiado {de, a, usuarioId} · miembro.eliminado {rol} · cliente.eliminado {} · invitacion.modificada {campos, de?, a?}
// El detalle sigue mostrando solo valores simples con rótulo conocido: la lista `campos` y el `usuarioId` no salen (sin ids ni listas).
const GENERICO = "Realizó una acción";

describe("textoAccion · acciones de la ronda R1", () => {
  it.each([
    "asignacion.tipo_cambiado",
    "miembro.eliminado",
    "cliente.eliminado",
    "invitacion.modificada",
  ])("%s tiene texto propio en español (ni genérico ni el código crudo)", (accion) => {
    const t = textoAccion(accion);
    expect(t, accion).not.toBe(GENERICO);
    expect(t, accion).not.toContain(accion);
    expect(t, accion).not.toMatch(/[._]/);
    expect(t.length).toBeGreaterThan(8);
  });

  it("los cuatro textos son distintos entre sí y de los de asignar, quitar, dar de alta y borrar ya existentes", () => {
    const nuevos = ["asignacion.tipo_cambiado", "miembro.eliminado", "cliente.eliminado", "invitacion.modificada"].map((a) => textoAccion(a));
    const previos = ["asignacion.agregada", "asignacion.quitada", "miembro.alta", "miembro.desactivado", "cliente.archivado", "invitacion.revocada"].map((a) => textoAccion(a));
    expect(new Set([...nuevos, ...previos]).size).toBe(nuevos.length + previos.length);
  });
});

describe("textoDetalle · datos de las acciones de la ronda R1", () => {
  it("cambio de tipo de asignación: «Tipo: Responsable → Colaborador», sin el id del usuario", () => {
    const detalle = textoDetalle({
      accion: "asignacion.tipo_cambiado",
      datos: { de: "responsable", a: "colaborador", usuarioId: "5f6c1d7e-0000-4000-8000-000000000001" },
    });
    expect(detalle).toBe("Tipo: Responsable → Colaborador");
  });

  it("baja de un miembro: «Rol: Contador»; cliente eliminado: sin detalle; invitación modificada: solo el cambio de rol, no la lista de campos", () => {
    expect(textoDetalle({ accion: "miembro.eliminado", datos: { rol: "contador" } })).toBe("Rol: Contador");
    expect(textoDetalle({ accion: "cliente.eliminado", datos: {} })).toBe("");
    expect(
      textoDetalle({
        accion: "invitacion.modificada",
        datos: { campos: ["correo", "rol"], de: "lectura", a: "contador" },
      }),
    ).toBe("Rol: Lectura → Contador");
  });
});
