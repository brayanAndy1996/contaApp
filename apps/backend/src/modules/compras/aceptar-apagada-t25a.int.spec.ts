/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 021 · T25a (H-T25-1): aceptar una sugerencia guardada de una regla que el estudio apagó después es 409 `revisar_de_nuevo`
// y no escribe nada, también SIN XML (la compra no trae XML: `sigueVigente` no contrasta) y en la masiva. Con la regla encendida
// el mismo caso se acepta (control). Los hallazgos están guardados con la regla encendida; el estudio la apaga después.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoReglas, base, hallazgoIscXml, montos, RUTA_MOTOR, type Actor, type BancoReglas, type Estudio } from "../../../test/soporte-reglas.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoReglas;
let G: Estudio; // su propio estudio: apagar reglas no afecta a otras pruebas
let admin: Actor;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoReglas();
  G = await v.estudio();
  admin = await v.b.c.p.b.miembro(G.tenantId, "admin");
  contador = await v.b.c.p.b.miembro(G.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const cliente = () => v.cliente(G, { responsable: contador.id }) as Promise<Cliente>;
const apagar = (codigo: string, activa: boolean) => v.http(admin, "PUT", `${RUTA_MOTOR}/${codigo}`, { activa });
const aceptar = (c: Cliente, id: string, cuerpo: unknown) => v.llamar(contador, "POST", `${base(c.id)}/${id}/sugerencias/aceptar`, cuerpo);
const masiva = (c: Cliente, cuerpo: unknown) => v.llamar(contador, "POST", `${base(c.id)}/masivas/aceptar`, cuerpo);

// Sin XML y sin historial de proveedores: San Juan trae R-ISC y el proveedor de las bolsas, R-NEW (fixture de 009).
const CASOS = [
  { regla: "R-ISC", fila: "F001-1040", extra: {} },
  { regla: "R-NEW", fila: "F001-3064", extra: { dato: { destino: "DNG" } } },
] as const;

describe("T25a · aceptar con la regla apagada por el estudio, sin XML (H-T25-1)", () => {
  it.each(CASOS)("$regla guardada: encendida se acepta (200) y apagada es 409 revisar_de_nuevo sin escribir", async ({ regla, fila, extra }) => {
    const encendida = await cliente();
    const idsOn = await v.sembrarFixture(G.tenantId, encendida.id, { usuarioId: G.titular.id, conocidos: false });
    expect((await v.hallazgosDe(idsOn[fila]!, 1)).map((h: any) => h.regla)).toContain(regla); // el hallazgo está guardado
    const on = await aceptar(encendida, idsOn[fila]!, { versionBase: 1, regla, confirmar: true, ...extra });
    expect(on.status, on.text).toBe(200);

    const apagada = await cliente();
    const idsOff = await v.sembrarFixture(G.tenantId, apagada.id, { usuarioId: G.titular.id, conocidos: false });
    expect((await apagar(regla, false)).status).toBe(200);
    try {
      const antes = await v.foto(apagada.id);
      const off = await aceptar(apagada, idsOff[fila]!, { versionBase: 1, regla, confirmar: true, ...extra });
      expect(off.status, off.text).toBe(409);
      expect(off.body).toEqual({ codigo: "revisar_de_nuevo" });
      expect(await v.foto(apagada.id)).toEqual(antes);
      expect((await v.hallazgosDe(idsOff[fila]!, 1)).map((h: any) => h.regla)).toContain(regla); // lo guardado no se borra
    } finally {
      await apagar(regla, true);
    }
  });
});

describe("T25a · la masiva de aceptar con la regla apagada, sin XML en la compra (H-T25-1)", () => {
  // Un hallazgo respaldado por XML (sin confirmación) guardado en una compra sin XML vigente: `sigueVigente` no contrasta sin XML.
  const sembrar = async (c: Cliente): Promise<string> => {
    const m = montos({ biDg: "500.00" });
    return v.sembrarCompra(G.tenantId, c.id, { serie: "F004", numero: "1", usuarioId: G.titular.id, montos: { biDg: "500.00" }, hallazgos: [hallazgoIscXml(m, "500.00")] });
  };

  it("R-ISC: encendida se aplica y apagada se rechaza como revisar_de_nuevo sin escribir", async () => {
    const encendida = await cliente();
    const on = await masiva(encendida, { items: [{ compraId: await sembrar(encendida), versionBase: 1 }], regla: "R-ISC" });
    expect(on.status, on.text).toBe(200);
    expect(on.body).toMatchObject({ aplicadas: 1, rechazadas: [] });

    const apagada = await cliente();
    const id = await sembrar(apagada);
    expect((await apagar("R-ISC", false)).status).toBe(200);
    try {
      const antes = await v.foto(apagada.id);
      const off = await masiva(apagada, { items: [{ compraId: id, versionBase: 1 }], regla: "R-ISC" });
      expect(off.status, off.text).toBe(200);
      expect(off.body.aplicadas).toBe(0);
      expect(off.body.rechazadas).toEqual([{ compraId: id, codigo: "revisar_de_nuevo" }]);
      expect(await v.foto(apagada.id)).toEqual(antes);
    } finally {
      await apagar("R-ISC", true);
    }
  });
});
