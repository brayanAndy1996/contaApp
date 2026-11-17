/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 021 · T24 (cruce con 022): `escribirVersiones` solapa `evaluar` con las escrituras de la transacción, y `evaluarPorPeriodo` lee
// en la primera llamada (lazy) `leerProveedoresConocidos` y `leerReglasMotor`. Con reglas apagadas por el estudio (RF-089), la masiva y
// Ctrl+Z masivo deben dejar los mismos hallazgos que la acción fila por fila (en serie, sin solape), y con todas encendidas también.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoReglas, base, RUTA_MOTOR, type Actor, type BancoReglas, type Estudio } from "../../../test/soporte-reglas.js";

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
const VOLUMEN = 60;

/** Un cliente con el fixture de 009 (San Juan ISC, mixta, zapatilla, USD, gravada común), sin historial de proveedores, más filas de volumen. */
async function sembrar(): Promise<{ c: Cliente; ids: string[]; claves: string[] }> {
  const c = (await v.cliente(G, { responsable: contador.id })) as Cliente;
  const fixture = await v.sembrarFixture(G.tenantId, c.id, { usuarioId: G.titular.id, conocidos: false });
  const volumen = await v.sembrarVolumen(G.tenantId, c.id, VOLUMEN, { usuarioId: G.titular.id });
  const ids = [...Object.values(fixture), ...volumen];
  const claves = [...Object.keys(fixture), ...volumen.map((_, i) => `F002-${i + 1}`)];
  return { c, ids, claves };
}

const llamar = (c: Cliente, ruta: string, cuerpo: unknown) => v.llamar(contador, "POST", `${base(c.id)}${ruta}`, cuerpo);
const apagar = (codigo: string, activa: boolean) => v.http(admin, "PUT", `${RUTA_MOTOR}/${codigo}`, { activa });

/** Lo que dejó la evaluación de cada fila en una versión: regla, sugerencia, lecturas y confirmación. */
async function hallazgos(ids: string[], claves: string[], n: number): Promise<Record<string, unknown>> {
  const foto: Record<string, unknown> = {};
  for (let i = 0; i < ids.length; i++) {
    const h = await v.hallazgosDe(ids[i]!, n);
    foto[claves[i]!] = h.map((x: any) => [x.regla, x.sugerencia, x.lecturas, x.requiere_confirmacion]);
  }
  return foto;
}
const reglasEn = (foto: Record<string, unknown>): Set<string> =>
  new Set(Object.values(foto).flatMap((f) => (f as any[][]).map((h) => h[0] as string)));

const DESTINO = "DG" as const;

async function enMasa(): Promise<{ v2: Record<string, unknown>; v3: Record<string, unknown> }> {
  const { c, ids, claves } = await sembrar();
  const m = await llamar(c, "/masivas/clasificar", { items: ids.map((compraId) => ({ compraId, versionBase: 1 })), destino: DESTINO });
  expect(m.status, m.text).toBe(200);
  const v2 = await hallazgos(ids, claves, 2);
  const d = await llamar(c, "/deshacer", {});
  expect(d.status, d.text).toBe(200);
  return { v2, v3: await hallazgos(ids, claves, 3) };
}

async function enSerie(): Promise<{ v2: Record<string, unknown>; v3: Record<string, unknown> }> {
  const { c, ids, claves } = await sembrar();
  const v2: Record<string, unknown> = {};
  const v3: Record<string, unknown> = {};
  for (let i = 0; i < ids.length; i++) {
    const r = await llamar(c, `/${ids[i]!}/clasificar`, { versionBase: 1, destino: DESTINO });
    expect(r.status, `${claves[i]}: ${r.text}`).toBe(200);
    v2[claves[i]!] = (await hallazgos([ids[i]!], [claves[i]!], 2))[claves[i]!];
    const d = await llamar(c, "/deshacer", {});
    expect(d.status, `${claves[i]}: ${d.text}`).toBe(200);
    v3[claves[i]!] = (await hallazgos([ids[i]!], [claves[i]!], 3))[claves[i]!];
  }
  return { v2, v3 };
}

describe("022 × 021 · masiva y Ctrl+Z masivo con el solape de evaluar y escribir, con las reglas del estudio", () => {
  it("todas encendidas (control): la masiva y el deshacer masivo dejan los mismos hallazgos que fila por fila", async () => {
    const masa = await enMasa();
    const serie = await enSerie();
    expect(masa.v2).toEqual(serie.v2);
    expect(masa.v3).toEqual(serie.v3);
    // La prueba no es vacua: San Juan trae R-ISC y los proveedores sin historial, R-NEW.
    expect([...reglasEn(masa.v3)]).toEqual(expect.arrayContaining(["R-ISC", "R-NEW"]));
  });

  it("R-ISC y R-NEW apagadas: mismos hallazgos que en serie y ninguno de los dos aparece (v2 y v3)", async () => {
    expect((await apagar("R-ISC", false)).status).toBe(200);
    expect((await apagar("R-NEW", false)).status).toBe(200);
    try {
      const masa = await enMasa();
      const serie = await enSerie();
      expect(masa.v2).toEqual(serie.v2);
      expect(masa.v3).toEqual(serie.v3);
      for (const foto of [masa.v2, masa.v3, serie.v2, serie.v3]) {
        const reglas = reglasEn(foto);
        expect(reglas.has("R-ISC")).toBe(false);
        expect(reglas.has("R-NEW")).toBe(false);
      }
      // Las que siguen encendidas se siguen evaluando (la mixta trae R-MIX).
      expect(reglasEn(masa.v3).has("R-MIX")).toBe(true);
    } finally {
      await apagar("R-ISC", true);
      await apagar("R-NEW", true);
    }
  });
});
