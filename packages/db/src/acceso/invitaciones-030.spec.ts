// Spec 030 (T6): `revocarPendientesDe` con roles propios, sin BD (tx falsa). El comportamiento real está en
// tests/aislamiento/roles-t6.spec.ts.
import { describe, expect, it } from "vitest";
import { AccesoRepoError } from "./errores";
import { crearInvitacion, nombreRolPropioDeInvitacion, revocarPendientesDe } from "./invitaciones";
import { cambiarRol, listarMiembros, miembroActual } from "./miembros";

const U1 = "01920000-0000-7000-8000-00000000c0b1";
const R1 = "01920000-0000-7000-8000-00000000D1B1";
type TxFalsa = Parameters<typeof revocarPendientesDe>[0];

function txEspia(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxFalsa;
  return { tx, llamadas };
}

describe("revocarPendientesDe con roles propios (030)", () => {
  it("un rol propio viaja por su id (en minúsculas) junto a las claves de sistema; las propias se deciden por rol_id", async () => {
    const { tx, llamadas } = txEspia([{ id: "a" }]);
    expect(await revocarPendientesDe(tx, U1, ["lectura", { rolId: R1 }])).toBe(1);
    expect(llamadas[0]!.valores).toEqual([U1, ["lectura", R1.toLowerCase()]]);
    expect(llamadas[0]!.texto).toMatch(/when rol = 'propio' then rol_id::text = any\(\$2::text\[\]\)/);
    expect(llamadas[0]!.texto).not.toContain(R1.toLowerCase());
  });

  it("un error de pg sale como AccesoRepoError solo con el SQLSTATE", async () => {
    const tx = {
      query: async () => {
        throw Object.assign(new Error("detalle CANARIO-030"), { code: "23503", detail: "CANARIO-030" });
      },
    } as unknown as TxFalsa;
    const e = (await revocarPendientesDe(tx, U1, [{ rolId: R1 }]).catch((x: unknown) => x)) as AccesoRepoError;
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe("23503");
    expect(JSON.stringify(e) + e.message).not.toContain("CANARIO-030");
  });
});

describe("rol propio sin rolId y filas sin rol_id (030)", () => {
  const H = Buffer.alloc(32, 3);
  it("crearInvitacion y cambiarRol con 'propio' sin rolId envian NULL (el CHECK de 0082 lo rechaza con 23514)", async () => {
    const a = txEspia([{ id: "i1", correo: "x@ejemplo.test", rol: "propio", invitado_por: U1, creada_en: new Date(), vence_en: new Date() }]);
    const i = await crearInvitacion(a.tx, { correo: "x@ejemplo.test", rol: "propio", invitadoPor: U1, tokenHash: H });
    expect(a.llamadas[1]!.valores.at(-1)).toBeNull();
    expect([i.rolId, i.rolNombre]).toEqual([null, null]);
    const b = txEspia([{ usuario_id: U1, rol: "propio", activo: true }]);
    await cambiarRol(b.tx, U1, "propio");
    expect(b.llamadas[0]!.valores).toEqual([U1, "propio", null]);
  });

  it("filas sin rol_id ni rol_nombre (columnas ausentes) se mapean a null", async () => {
    const m = await listarMiembros(txEspia([{ usuario_id: U1, nombre: "Ana", correo: "a@ejemplo.test", rol: "lectura", activo: true }]).tx);
    expect([m[0]!.rolId, m[0]!.rolNombre]).toEqual([null, null]);
    const p = await miembroActual(txEspia([{ usuario_id: U1, rol: "propio", permisos: ["clientes.ver"], alcance: "global" }]).tx, U1);
    expect(p).toEqual({ usuarioId: U1, rol: "propio", rolId: null, propio: { permisos: ["clientes.ver"], alcance: "global" } });
  });
});

describe("nombreRolPropioDeInvitacion (T15a)", () => {
  const H = Buffer.alloc(32, 7);
  it("devuelve solo el nombre del rol de la invitación viva por su hash (criterio de vigencia y join por estudio)", async () => {
    const { tx, llamadas } = txEspia([{ nombre: "Practicante" }]);
    expect(await nombreRolPropioDeInvitacion(tx, H)).toBe("Practicante");
    expect(llamadas[0]!.valores).toEqual([H]);
    expect(llamadas[0]!.texto).toMatch(/r\.tenant_id = i\.tenant_id and r\.id = i\.rol_id/);
    expect(llamadas[0]!.texto).toMatch(/aceptada_en is null and i\.revocada_en is null and i\.vence_en > now\(\)/);
  });

  it("sin fila (no viva o no propia) -> null; un error de pg sale como AccesoRepoError solo con el SQLSTATE", async () => {
    expect(await nombreRolPropioDeInvitacion(txEspia([]).tx, H)).toBeNull();
    const tx = {
      query: async () => {
        throw Object.assign(new Error("detalle CANARIO-T15a"), { code: "42501" });
      },
    } as unknown as TxFalsa;
    const e = (await nombreRolPropioDeInvitacion(tx, H).catch((x: unknown) => x)) as AccesoRepoError;
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe("42501");
  });
});
