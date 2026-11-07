// Spec 014 (T10, rojo): integración con 012 (D-9, D-10, nota [012b]; CA-14): `leerFilasReemplazo` + `prevalidar` + `resumirCambios`.
// Contrato (plan: «packages/db»; `tests/aislamiento/compras-periodo.spec.ts` de T6 prueba la lectura con un mapeo identidad):
//  - `leerFilasReemplazo(tx, clienteId, periodo, aFila) → { original, vigente }` (en `@contapp/db`): `aFila` mapea la compra
//    leída (cadenas) a la fila del consumidor; `packages/db` no depende de `domain`, así que la inyecta quien llama. Aquí se
//    inyecta `aFilaReemplazo` de `domain` (012b hará lo mismo) construyendo los `MontosComprobante` con `Money`.
//  - original = versión 1 de las filas del SIRE; vigente = versión vigente de las vivas (excluidas con su estado, agregadas
//    dentro, descartadas fuera). Las filas PEN llevan `tipoCambio: null`.
//  - CA-14: con el fixture sin corregir, `prevalidar` da `apto = false` con el error de IGV de F001-2056; tras corregir San Juan
//    (R-ISC aceptada) y la mixta (R-MIX con gravado 8.97) da `apto = true`, y `resumirCambios` cuenta 2 modificadas y 0 excluidas.
//  - 012b siempre pasa `reglas` a `prevalidar` y nunca toma `registro` de la petición (nota [012b]).
// La parte «A» siembra las correcciones por SQL: solo necesita `leerFilasReemplazo` (T14). La parte «B» las hace por HTTP, con
// las rutas de aceptar sugerencia (T16), y comprueba el recorrido completo.
// Rojo: `@contapp/db` aún no exporta `leerFilasReemplazo` (T14) y las rutas de acciones no existen (T16).
import * as db from "@contapp/db";
import {
  aFilaReemplazo,
  DICCIONARIO_GLOSAS_BASE,
  MontosComprobante,
  prevalidar,
  resumirCambios,
  type FilaReemplazo,
} from "@contapp/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  filasFixtureCompras,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type IdsPorNumero,
} from "../../../test/soporte-compras.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const u = (): string => E.titular.id;

/** Lo que `packages/db` entrega de cada compra (tipos estructurales de T6/T12: cadenas, sin `domain`). */
interface CompraLeida {
  id: string;
  origen: "sire" | "agregada";
  tipoDoc: string;
  serie: string;
  numero: string;
  docTipo: string;
  docNumero: string;
  razonSocial: string | null;
  fecha: string;
  moneda: "PEN" | "USD";
  tipoCambio: string | null;
  version: number;
  excluida: boolean;
  montos: Record<string, string>;
}
type LeerFilasReemplazo = (
  tx: unknown,
  clienteId: string,
  periodo: string,
  aFila: (c: CompraLeida) => FilaReemplazo,
) => Promise<{ original: FilaReemplazo[]; vigente: FilaReemplazo[] }>;

/** `aFilaReemplazo` de 012 con los montos de la compra convertidos a `MontosComprobante` (lo que hará 012b). */
function aFila(c: CompraLeida): FilaReemplazo {
  const m = c.montos;
  return aFilaReemplazo({
    id: c.id,
    origen: c.origen,
    comprobante: { tipo: c.tipoDoc, serie: c.serie, numero: c.numero },
    proveedor: { tipo: c.docTipo, numero: c.docNumero, razonSocial: c.razonSocial },
    fechaEmision: c.fecha,
    tipoCambio: c.tipoCambio,
    version: c.version,
    excluida: c.excluida,
    montos: MontosComprobante.desde(c.moneda, {
      biDg: m.biDg,
      igvDg: m.igvDg,
      biDgng: m.biDgng,
      igvDgng: m.igvDgng,
      biDng: m.biDng,
      igvDng: m.igvDng,
      noGravado: m.noGravado,
      isc: m.isc,
      icbper: m.icbper,
      otrosTributos: m.otrosTributos,
      total: m.total,
    } as never),
  });
}

async function leer(c: Cliente, periodo = PERIODO) {
  const f = (db as unknown as Record<string, unknown>)["leerFilasReemplazo"];
  expect(typeof f, "`@contapp/db` exporta leerFilasReemplazo (T14)").toBe("function");
  return v.b.c.p.b.h.dbBackend.withTenant({ tenantId: E.tenantId, userId: u() }, (tx) =>
    (f as LeerFilasReemplazo)(tx, c.id, periodo, aFila),
  );
}

const CABECERA = { rucDeclarante: "20700000002", periodo: PERIODO, libro: "compras" as const };
/** El contexto de reglas que 012b siempre le pasa a `prevalidar`: los proveedores del fixture ya conocidos. */
const reglas = () => ({
  proveedoresConocidos: filasFixtureCompras().map((f) => ({ tipo: "6", numero: f.rucContraparte })),
  proveedoresIsc: [],
  diccionario: DICCIONARIO_GLOSAS_BASE,
});

async function cliente(): Promise<Cliente> {
  return v.cliente(E, { responsable: contador.id });
}

describe("CA-14 · parte A · desde la BD: leerFilasReemplazo + prevalidar + resumirCambios", () => {
  it("el fixture sin corregir: apto = false con el error de IGV de F001-2056 y el aviso R-ISC de San Juan", async () => {
    const c = await cliente();
    const ids: IdsPorNumero = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u() });
    const { original, vigente } = await leer(c);

    expect(original).toHaveLength(5);
    expect(vigente).toHaveLength(5);
    expect(original.every((f) => f.estado === "original")).toBe(true);
    expect(vigente.every((f) => f.estado === "original")).toBe(true);

    const r = prevalidar(vigente, { cabecera: CABECERA, reglas: reglas() });
    expect(r.apto).toBe(false);
    expect(r.errores.map((e) => [e.filaId, e.codigo, e.campo])).toEqual([[ids["F001-2056"], "IGV", "igvDg"]]);
    expect(r.errores[0]!.destino).toBe("DG");
    // Con `reglas`, el error trae el hallazgo R-MIX de 011 y San Juan sale como aviso R-ISC (no bloquea).
    expect(r.errores[0]!.sugerencia?.regla).toBe("R-MIX");
    expect(r.avisos.map((a) => [a.filaId, a.codigo])).toEqual([[ids["F001-1040"], "R-ISC"]]);
  });

  it("San Juan (R-ISC aceptada) y la mixta (gravado 8.97) corregidas: apto = true y 2 modificadas, 0 excluidas", async () => {
    const c = await cliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, {
      usuarioId: u(),
      versiones: {
        "F001-1040": [{ montos: { biDg: "0.00", isc: "770.00" }, accion: "sugerencia" }],
        "F001-2056": [{ montos: { biDg: "8.97", noGravado: "12.51" }, accion: "sugerencia" }],
      },
    });
    const { original, vigente } = await leer(c);

    const r = prevalidar(vigente, { cabecera: CABECERA, reglas: reglas() });
    expect(r.errores).toEqual([]);
    expect(r.apto).toBe(true);
    expect(r.avisos).toEqual([]);

    const resumen = resumirCambios(original, vigente);
    expect(resumen.modificadas).toBe(2);
    expect(resumen.excluidas).toBe(0);
    expect(resumen.agregadas).toBe(0);
    expect(resumen.filasSinConvertir).toEqual([]);
    // El impacto en IGV es cero: las dos correcciones mueven BI, no IGV.
    expect(resumen.impactoIgv.total.toString()).toBe("0.00");

    // El estado de cada fila viene de su versión: las dos corregidas son «modificada», las demás «original».
    const por = (xs: FilaReemplazo[]) => Object.fromEntries(xs.map((f) => [f.id, f]));
    expect(por(vigente)[ids["F001-1040"]!]!.estado).toBe("modificada");
    expect(por(vigente)[ids["F001-2056"]!]!.estado).toBe("modificada");
    expect(por(vigente)[ids["F001-3064"]!]!.estado).toBe("original");
    // El original conserva lo que dijo el SIRE (versión 1) con sus montos y estado `original`.
    expect(por(original)[ids["F001-1040"]!]!.montos.obtener("biDg").toString()).toBe("770.00");
    expect(por(original)[ids["F001-1040"]!]!.estado).toBe("original");
    expect(por(vigente)[ids["F001-1040"]!]!.montos.obtener("isc").toString()).toBe("770.00");
    expect(por(vigente)[ids["F001-2056"]!]!.montos.obtener("noGravado").toString()).toBe("12.51");
  });

  it("las filas PEN llevan tipoCambio null y la USD conserva el suyo, sin origenUsd", async () => {
    const c = await cliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u() });
    const { vigente } = await leer(c);
    for (const f of vigente) {
      if (f.id === ids["F001-4062"]) {
        expect(f.tipoCambio).toBe("3.300");
      } else {
        expect(f.tipoCambio, f.comprobante.numero).toBeNull();
      }
      expect(f.origenUsd).toBeNull();
    }
    expect(vigente.find((f) => f.id === ids["F001-4062"])!.montos.moneda).toBe("USD");
  });

  it("una excluida cuenta como excluida; una agregada, como agregada; una descartada no sale", async () => {
    const c = await cliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, {
      usuarioId: u(),
      versiones: { "F001-3064": [{ excluida: true, motivo: "zapatillas", accion: "excluir" }] },
    });
    const agregada = await v.sembrarCompra(E.tenantId, c.id, { serie: "F050", numero: "1", doc: "20700000050", origen: "agregada", usuarioId: u() });
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F050", numero: "2", doc: "20700000051", origen: "agregada", descartada: true, usuarioId: u() });
    const { original, vigente } = await leer(c);

    expect(original.map((f) => f.id)).not.toContain(agregada); // el original es solo el SIRE
    expect(original).toHaveLength(5);
    expect(vigente).toHaveLength(6); // 5 del SIRE + 1 agregada; la descartada no sale
    const por = Object.fromEntries(vigente.map((f) => [f.id, f]));
    expect(por[ids["F001-3064"]!]!.estado).toBe("excluida");
    expect(por[agregada]!.estado).toBe("agregada");

    const resumen = resumirCambios(original, vigente);
    expect(resumen.excluidas).toBe(1);
    expect(resumen.agregadas).toBe(1);
    expect(resumen.modificadas).toBe(0);
  });

  it("solo el cliente y el periodo pedidos: otro periodo y otro cliente del mismo estudio no entran", async () => {
    const c = await cliente();
    await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u() });
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F051", numero: "1", usuarioId: u(), periodo: "202609" });
    const otro = await cliente();
    await v.sembrarFixture(E.tenantId, otro.id, { usuarioId: u() });
    const { original, vigente } = await leer(c);
    expect(original).toHaveLength(5);
    expect(vigente).toHaveLength(5);
    expect((await leer(c, "202601")).vigente).toEqual([]);
  });

  it("dentro del estudio de otro: la lectura con el contexto de otro estudio no devuelve nada (RLS)", async () => {
    const c = await cliente();
    await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u() });
    const F = await v.estudio();
    const f = (db as unknown as Record<string, unknown>)["leerFilasReemplazo"];
    expect(typeof f).toBe("function");
    const r = await v.b.c.p.b.h.dbBackend.withTenant({ tenantId: F.tenantId, userId: F.titular.id }, (tx) =>
      (f as LeerFilasReemplazo)(tx, c.id, PERIODO, aFila),
    );
    expect(r).toEqual({ original: [], vigente: [] });
  });
});

describe("CA-14 · parte B · recorrido completo: aceptar las sugerencias por HTTP y volver a prevalidar", () => {
  it("aceptar R-ISC de San Juan y R-MIX con 8.97 deja el periodo apto, con 2 modificadas", async () => {
    const c = await cliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u() });
    const antes = prevalidar((await leer(c)).vigente, { cabecera: CABECERA, reglas: reglas() });
    expect(antes.apto).toBe(false);

    const san = await v.llamar(contador, "POST", `${base(c.id)}/${ids["F001-1040"]}/sugerencias/aceptar`, {
      versionBase: 1,
      regla: "R-ISC",
      confirmar: true,
    });
    expect(san.status, san.text).toBe(200);
    const mix = await v.llamar(contador, "POST", `${base(c.id)}/${ids["F001-2056"]}/sugerencias/aceptar`, {
      versionBase: 1,
      regla: "R-MIX",
      confirmar: true,
      dato: { gravado: "8.97" },
    });
    expect(mix.status, mix.text).toBe(200);

    const { original, vigente } = await leer(c);
    const r = prevalidar(vigente, { cabecera: CABECERA, reglas: reglas() });
    expect(r.errores).toEqual([]);
    expect(r.apto).toBe(true);
    const resumen = resumirCambios(original, vigente);
    expect(resumen.modificadas).toBe(2);
    expect(resumen.excluidas).toBe(0);
    // La versión 1 sigue siendo lo que dijo el SIRE.
    expect(original.find((f) => f.id === ids["F001-2056"])!.montos.obtener("biDg").toString()).toBe("21.48");
  });

  it("excluir una fila y agregar otra se ven en el resumen de cambios", async () => {
    const c = await cliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u() });
    const ex = await v.llamar(contador, "POST", `${base(c.id)}/${ids["F001-3064"]}/excluir`, { versionBase: 1, motivo: "zapatillas" });
    expect(ex.status, ex.text).toBe(200);
    const ag = await v.llamar(contador, "POST", base(c.id), {
      tipo: "01",
      serie: "F060",
      numero: "1",
      proveedor: { tipo: "6", numero: "20700000060", razonSocial: "AGREGADO SAC" },
      fecha: "2026-10-20",
      moneda: "PEN",
      montos: { biDg: "100.00", igvDg: "18.00" },
    });
    expect(ag.status, ag.text).toBe(201);
    const { original, vigente } = await leer(c);
    const resumen = resumirCambios(original, vigente);
    expect(resumen.excluidas).toBe(1);
    expect(resumen.agregadas).toBe(1);
  });
});
