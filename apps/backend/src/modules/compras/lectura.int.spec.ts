/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 014 (T10, rojo): lectura de compras por HTTP: listado, detalle, propuestas y diferencias, y aislamiento de las lecturas
// (D-4, D-6, D-11, D-13, DU-19; CA-2 parte detalle, CA-10, CA-13 lecturas, CA-15 listado, CA-17 lectura de diferencias).
// Contrato (plan: «Contratos: HTTP» y «Contrato real de 013», punto 12; formas de `@contapp/shared/compras`; errores `{codigo}`):
//  - `GET …/compras?cursor&limite&vista&alertas&proveedorNuevo&q` -> 200 `{ filas: FilaCompraVista[], siguiente: string | null }`.
//    Orden por fecha, serie y número; `siguiente` es un cursor opaco (uno mal formado: 400). `vista` ∈ `con_igv` | `sin_igv` |
//    `excluidas`; sin `vista`, la lista principal (sin excluidas ni descartadas). `alertas=true`: solo filas con hallazgos.
//    `proveedorNuevo=true`: solo filas con `proveedorNuevo`. `q`: prefijo de RUC, fragmento de razón social o serie-número, sin
//    distinguir mayúsculas, con `%`, `_` y `\\` como texto literal y sin concatenar SQL. Parámetros inválidos: 400.
//  - `proveedorNuevo` (D-4, CA-10, DU-7): el proveedor no tiene compras vivas o excluidas del MISMO cliente en OTROS periodos
//    (el historial de otro cliente o estudio no cuenta; una descartada no es historial) y la fila aún no está clasificada.
//  - `GET …/compras/:compraId` -> 200 `{ original, vigente, versiones[], hallazgos[] }`: la versión 1 aparte de la vigente, todas
//    las versiones con autor y fecha, y los hallazgos de la versión vigente. 404 si es de otro cliente, periodo o estudio.
//  - `GET …/compras/propuestas` y `…/propuestas/:propuestaId/diferencias` (DU-19): `PropuestaComprasDto[]` (la más reciente
//    primero; solo `libro = compras`) y `DiferenciaComprasDto[]` de ESA propuesta, con los mismos campos que los de ventas.
//    Una propuesta de otro cliente, periodo o libro, inexistente o mal formada: 404 sin datos.
//  - Permiso `clientes.ver`; `ClienteScopeGuard`: cliente de otro estudio, no asignado o inexistente, el mismo 404; sin sesión
//    401; un cliente archivado se puede leer. Listado de 5.000 filas en menos de 2 s (CA-15).
// Rojo: el módulo `compras` aún no existe (T15): toda ruta responde 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
import {
  detalleCompraSchema,
  filaCompraVistaSchema,
  listadoComprasSchema,
  versionCompraVistaSchema,
} from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  hallazgoIscSinXml,
  montos,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type IdsPorNumero,
} from "../../../test/soporte-compras.js";
import { forma } from "../../../test/soporte.js";
import { BAJO_COBERTURA, medirMediana } from "../../../test/tiempos.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
  asistenteAjeno = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<BancoCompras["cliente"]>[1] = {}) =>
  v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id], ...o });
const leer = (a: Actor, c: Cliente, query = "", periodo = PERIODO) =>
  v.llamar(a, "GET", `${base(c.id, periodo)}${query}`);
const ids = (r: { body: any }): string[] => (r.body.filas as any[]).map((f) => f.id);
const u = (): string => E.titular.id;

const CLAVES_FILA = [
  "clasificada",
  "excluida",
  "fecha",
  "hallazgos",
  "id",
  "moneda",
  "montos",
  "motivo",
  "numero",
  "origen",
  "proveedor",
  "proveedorNuevo",
  "segunHistorial",
  "serie",
  "tipo",
  "tipoCambio",
  "version",
];

/** Cliente con el fixture de 009 y F001-5070 excluida: 4 en la lista principal, 1 en «excluidas». */
async function conFixture() {
  const c = await nuevoCliente();
  const x = await v.sembrarFixture(E.tenantId, c.id, {
    usuarioId: u(),
    versiones: { "F001-5070": [{ excluida: true, motivo: "no es del giro", accion: "excluir" }] },
  });
  return { c, x };
}

// --- listado --------------------------------------------------------------------------------------------------------

describe("D-13 · listado: forma de la fila y de la página", () => {
  it("200 { filas, siguiente } con la forma de FilaCompraVista y los montos como cadenas con sus ceros", async () => {
    const { c, x } = await conFixture();
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(listadoComprasSchema.safeParse(r.body).success, r.text).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["filas", "siguiente"]);
    expect(r.body.siguiente).toBeNull();
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    for (const f of r.body.filas as any[]) {
      expect(filaCompraVistaSchema.safeParse(f).success).toBe(true);
      expect(Object.keys(f).sort()).toEqual(CLAVES_FILA);
    }
    const san = (r.body.filas as any[]).find((f) => f.id === x["F001-1040"])!;
    expect(san).toMatchObject({
      origen: "sire",
      tipo: "01",
      serie: "F001",
      numero: "1040",
      fecha: "2026-10-02",
      moneda: "PEN",
      tipoCambio: null,
      version: 1,
      excluida: false,
      motivo: null,
      clasificada: false,
      proveedor: { tipo: "6", numero: "20700000011", razonSocial: "PRUEBA PROVEEDOR ISC S.A.C." },
    });
    expect(san.montos).toEqual({
      biDg: "770.00",
      igvDg: "0.00",
      biDgng: "0.00",
      igvDgng: "0.00",
      biDng: "0.00",
      igvDng: "0.00",
      noGravado: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otrosTributos: "0.00",
      total: "770.00",
    });
    const usd = (r.body.filas as any[]).find((f) => f.id === x["F001-4062"])!;
    expect(usd).toMatchObject({ moneda: "USD", tipoCambio: "3.300" });
    expect(usd.montos).toMatchObject({ biDg: "0.15", igvDg: "0.03", total: "0.18" });
  });

  it("los hallazgos del motor van en la fila: San Juan con R-ISC (pide confirmación) y la mixta con R-MIX (pide el gravado)", async () => {
    const { c, x } = await conFixture();
    const filas = (await leer(contador, c)).body.filas as any[];
    const san = filas.find((f) => f.id === x["F001-1040"])!;
    expect(san.hallazgos).toHaveLength(1);
    expect(san.hallazgos[0]).toMatchObject({
      regla: "R-ISC",
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
      requiereConfirmacion: true,
      dato: null,
      masiva: false,
    });
    expect(typeof san.hallazgos[0].explicacion).toBe("string");
    expect(san.hallazgos[0].explicacion.length).toBeGreaterThan(0);
    const mix = filas.find((f) => f.id === x["F001-2056"])!;
    expect(mix.hallazgos.map((h: any) => h.regla)).toEqual(["R-MIX"]);
    expect(mix.hallazgos[0]).toMatchObject({ dato: "gravado", requiereConfirmacion: true, masiva: false });
    expect(mix.hallazgos[0].sugerencia.tipo).toBe("separar");
    const limpia = filas.find((f) => f.id === x["F001-3064"])!;
    expect(limpia.hallazgos).toEqual([]);
  });

  it("la fila no trae nada del estudio, la propuesta ni la clave interna", async () => {
    const { c } = await conFixture();
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.filas.length).toBeGreaterThan(0);
    const texto = r.text;
    for (const prohibido of [E.tenantId, c.id, "propuesta", "tenant", "01|F001|1040", "descartada"]) {
      expect(texto, prohibido).not.toContain(prohibido);
    }
  });

  it("solo las del cliente y el periodo pedidos: otro periodo y otro cliente del mismo estudio no se cuelan", async () => {
    const { c, x } = await conFixture();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F777", numero: "1", usuarioId: u(), periodo: "202609" });
    const otro = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, otro.id, { serie: "F888", numero: "1", usuarioId: u() });
    const r = await leer(contador, c);
    expect(ids(r).sort()).toEqual(Object.entries(x).filter(([k]) => k !== "F001-5070").map(([, id]) => id).sort());
    expect(r.text).not.toContain("F777");
    expect(r.text).not.toContain("F888");
  });

  it("un cliente sin compras: lista vacía y sin siguiente", async () => {
    const c = await nuevoCliente();
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ filas: [], siguiente: null });
  });
});

describe("D-13 · orden por fecha, serie y número, y paginación por cursor", () => {
  async function treintaFilas() {
    const c = await nuevoCliente();
    const esperado: { id: string; k: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const fecha = `2026-10-${String(1 + ((i * 7) % 28)).padStart(2, "0")}`;
      const serie = i % 2 === 0 ? "F001" : "F002";
      const numero = String(1000 + ((i * 13) % 100)); // 4 dígitos, sin repetir por serie
      const id = await v.sembrarCompra(E.tenantId, c.id, { serie, numero, fecha, doc: `2070000${String(i).padStart(4, "0")}`, usuarioId: u() });
      esperado.push({ id, k: `${fecha}|${serie}|${numero}` });
    }
    esperado.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    return { c, orden: esperado.map((e) => e.id) };
  }

  it("sin límite, todas ordenadas por fecha, serie y número", async () => {
    const { c, orden } = await treintaFilas();
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(ids(r)).toEqual(orden);
  });

  it("limite=7: siguiendo `siguiente` se recorren las 30 en el mismo orden, sin repetir ni saltar, y la última página no trae cursor", async () => {
    const { c, orden } = await treintaFilas();
    const vistas: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const q: string = `?limite=7${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const r = await leer(contador, c, q);
      expect(r.status, r.text).toBe(200);
      expect(r.body.filas.length).toBeLessThanOrEqual(7);
      vistas.push(...ids(r));
      cursor = r.body.siguiente;
      paginas++;
      expect(paginas).toBeLessThan(20);
    } while (cursor !== null);
    expect(paginas).toBe(5);
    expect(vistas).toEqual(orden);
  });

  it("una compra agregada o editada entre páginas no repite ni salta filas ya entregadas", async () => {
    const { c, orden } = await treintaFilas();
    const p1 = await leer(contador, c, "?limite=10");
    expect(ids(p1)).toEqual(orden.slice(0, 10));
    // Entre páginas aparece una fila con fecha anterior a todo: no debe empujar las ya vistas a la página siguiente.
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F000", numero: "1", fecha: "2026-10-01", doc: "20700099999", usuarioId: u(), origen: "agregada" });
    const p2 = await leer(contador, c, `?limite=10&cursor=${encodeURIComponent(p1.body.siguiente)}`);
    expect(ids(p2)).toEqual(orden.slice(10, 20));
  });

  it.each(["no-es-un-cursor", "%%%", "e30", "x".repeat(1025)])("un cursor mal formado (%#) es 400 solicitud_invalida", async (cursor) => {
    const c = await nuevoCliente();
    const r = await leer(contador, c, `?cursor=${encodeURIComponent(cursor)}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it.each([
    ["limite=0", "?limite=0"],
    ["limite negativo", "?limite=-1"],
    ["limite=5001", "?limite=5001"],
    ["limite no numérico", "?limite=abc"],
    ["limite decimal", "?limite=1.5"],
    ["vista desconocida", "?vista=todas"],
    ["alertas=talvez", "?alertas=talvez"],
    ["proveedorNuevo=1", "?proveedorNuevo=1"],
    ["q de 101 caracteres", `?q=${"a".repeat(101)}`],
  ])("parámetro inválido → 400 solicitud_invalida: %s", async (_n, query) => {
    const c = await nuevoCliente();
    const r = await leer(contador, c, query);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("el periodo mal formado es 400 y un periodo sin compras es 200 vacío", async () => {
    const c = await nuevoCliente();
    expect((await leer(contador, c, "", "2026-10")).status).toBe(400);
    expect((await leer(contador, c, "", "202601")).body).toEqual({ filas: [], siguiente: null });
  });
});

describe("D-13 · filtros vista, alertas y proveedorNuevo", () => {
  it("vista: con_igv y sin_igv separan por la suma de IGV; excluidas lista solo las excluidas; sin vista, la lista principal", async () => {
    const { c, x } = await conFixture();
    expect(ids(await leer(contador, c, "?vista=con_igv")).sort()).toEqual(
      [x["F001-2056"], x["F001-3064"], x["F001-4062"]].sort(),
    );
    expect(ids(await leer(contador, c, "?vista=sin_igv"))).toEqual([x["F001-1040"]]);
    expect(ids(await leer(contador, c, "?vista=excluidas"))).toEqual([x["F001-5070"]]);
    expect(ids(await leer(contador, c)).sort()).toEqual(
      [x["F001-1040"], x["F001-2056"], x["F001-3064"], x["F001-4062"]].sort(),
    );
  });

  it("una fila cuyo IGV queda en 0.00 tras una edición pasa a «sin IGV» (se mira la versión vigente)", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F100",
      numero: "1",
      usuarioId: u(),
      versiones: [{ montos: { igvDg: "0.00", isc: "18.00" }, accion: "editar" }],
    });
    expect(ids(await leer(contador, c, "?vista=sin_igv"))).toEqual([id]);
    expect(ids(await leer(contador, c, "?vista=con_igv"))).toEqual([]);
  });

  it("alertas=true deja solo las filas con hallazgos; la excluida no sale", async () => {
    const { c, x } = await conFixture();
    expect(ids(await leer(contador, c, "?alertas=true")).sort()).toEqual([x["F001-1040"], x["F001-2056"]].sort());
  });

  it("se combinan: vista=con_igv y alertas=true es solo la mixta", async () => {
    const { c, x } = await conFixture();
    expect(ids(await leer(contador, c, "?vista=con_igv&alertas=true"))).toEqual([x["F001-2056"]]);
  });
});

describe("CA-10 · proveedor nuevo (RF-070, HU-19, D-4, DU-7)", () => {
  it("el primer periodo de un cliente: todos los proveedores son nuevos y quedan pendientes", async () => {
    const { c, x } = await conFixture();
    const r = await leer(contador, c);
    for (const f of r.body.filas as any[]) expect(f.proveedorNuevo, f.serie + f.numero).toBe(true);
    expect(ids(await leer(contador, c, "?proveedorNuevo=true")).sort()).toEqual(
      [x["F001-1040"], x["F001-2056"], x["F001-3064"], x["F001-4062"]].sort(),
    );
  });

  it("con una compra del mismo proveedor en otro periodo del mismo cliente ya no es nuevo", async () => {
    const { c, x } = await conFixture();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F900", numero: "1", doc: "20700000011", usuarioId: u(), periodo: "202609" });
    const filas = (await leer(contador, c)).body.filas as any[];
    expect(filas.find((f) => f.id === x["F001-1040"])!.proveedorNuevo).toBe(false);
    expect(filas.find((f) => f.id === x["F001-2056"])!.proveedorNuevo).toBe(true);
    expect(ids(await leer(contador, c, "?proveedorNuevo=true"))).not.toContain(x["F001-1040"]);
  });

  it("una compra excluida del proveedor en otro periodo también es historial", async () => {
    const { c, x } = await conFixture();
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F900",
      numero: "2",
      doc: "20700000045",
      usuarioId: u(),
      periodo: "202609",
      versiones: [{ excluida: true, motivo: "zapatillas", accion: "excluir" }],
    });
    const filas = (await leer(contador, c)).body.filas as any[];
    expect(filas.find((f) => f.id === x["F001-2056"])!.proveedorNuevo).toBe(false);
  });

  it("una agregada descartada no es historial", async () => {
    const { c, x } = await conFixture();
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F900",
      numero: "3",
      doc: "20700000053",
      usuarioId: u(),
      periodo: "202609",
      origen: "agregada",
      descartada: true,
    });
    const filas = (await leer(contador, c)).body.filas as any[];
    expect(filas.find((f) => f.id === x["F001-3064"])!.proveedorNuevo).toBe(true);
  });

  it("el historial de otro cliente del mismo estudio y el de otro estudio no cuentan", async () => {
    const { c, x } = await conFixture();
    const otro = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, otro.id, { serie: "F900", numero: "4", doc: "20700000011", usuarioId: u(), periodo: "202609" });
    const cf = await v.cliente(F);
    await v.sembrarCompra(F.tenantId, cf.id, { serie: "F900", numero: "5", doc: "20700000045", usuarioId: F.titular.id, periodo: "202609" });
    const filas = (await leer(contador, c)).body.filas as any[];
    expect(filas.find((f) => f.id === x["F001-1040"])!.proveedorNuevo).toBe(true);
    expect(filas.find((f) => f.id === x["F001-2056"])!.proveedorNuevo).toBe(true);
  });

  it("otra compra del mismo proveedor en el mismo periodo no lo hace conocido", async () => {
    const c = await nuevoCliente();
    const a = await v.sembrarCompra(E.tenantId, c.id, { serie: "F910", numero: "1", doc: "20700000500", usuarioId: u() });
    const b = await v.sembrarCompra(E.tenantId, c.id, { serie: "F910", numero: "2", doc: "20700000500", usuarioId: u() });
    const filas = (await leer(contador, c)).body.filas as any[];
    expect(filas.find((f) => f.id === a)!.proveedorNuevo).toBe(true);
    expect(filas.find((f) => f.id === b)!.proveedorNuevo).toBe(true);
  });

  it("una vez clasificada deja de estar pendiente aunque el proveedor siga siendo nuevo", async () => {
    const c = await nuevoCliente();
    const pendiente = await v.sembrarCompra(E.tenantId, c.id, { serie: "F920", numero: "1", doc: "20700000600", usuarioId: u() });
    const clasificada = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F920",
      numero: "2",
      doc: "20700000601",
      usuarioId: u(),
      versiones: [{ clasificada: true, accion: "clasificar" }],
    });
    const filas = (await leer(contador, c)).body.filas as any[];
    expect(filas.find((f) => f.id === pendiente)!.proveedorNuevo).toBe(true);
    expect(filas.find((f) => f.id === clasificada)!.proveedorNuevo).toBe(false);
    expect(ids(await leer(contador, c, "?proveedorNuevo=true"))).toEqual([pendiente]);
  });
});

describe("D-13 · búsqueda `q`: prefijo de RUC, razón social o serie-número, con los comodines como texto", () => {
  it("prefijo de RUC, RUC completo, fragmento de razón social (sin distinguir mayúsculas) y serie-número", async () => {
    const { c, x } = await conFixture();
    expect(ids(await leer(contador, c, "?q=2070000001"))).toEqual([x["F001-1040"]]);
    expect(ids(await leer(contador, c, "?q=20700000053"))).toEqual([x["F001-3064"]]);
    expect(ids(await leer(contador, c, "?q=bolsas"))).toEqual([x["F001-3064"]]);
    expect(ids(await leer(contador, c, "?q=PROVEEDOR%20MIXTO"))).toEqual([x["F001-2056"]]);
    expect(ids(await leer(contador, c, "?q=F001-2056"))).toEqual([x["F001-2056"]]);
    expect(ids(await leer(contador, c, "?q=f001-2056"))).toEqual([x["F001-2056"]]);
    expect(ids(await leer(contador, c, "?q=zzz-no-existe"))).toEqual([]);
  });

  it("el RUC se busca por prefijo, no por fragmento del medio", async () => {
    const { c } = await conFixture();
    expect(ids(await leer(contador, c, "?q=0700000053"))).toEqual([]);
  });

  it("la búsqueda actúa dentro de la vista pedida", async () => {
    const { c, x } = await conFixture();
    expect(ids(await leer(contador, c, "?q=PRUEBA&vista=excluidas"))).toEqual([x["F001-5070"]]);
    expect(ids(await leer(contador, c, "?q=PRUEBA&vista=sin_igv"))).toEqual([x["F001-1040"]]);
  });

  describe("comodines de LIKE y comillas como texto", () => {
    let c: Cliente;
    let porRazon: Record<string, string>;
    beforeAll(async () => {
      c = await nuevoCliente();
      porRazon = {};
      let n = 0;
      for (const razon of ["AB%CD SAC", "AB_CD SAC", "ABXCD SAC", "AB\\CD SAC", "O'BRIEN & SONS", 'COMILLA "DOBLE" SAC']) {
        n++;
        porRazon[razon] = await v.sembrarCompra(E.tenantId, c.id, {
          serie: "F930",
          numero: String(n),
          doc: `2070000${String(700 + n).padStart(4, "0")}`,
          razonSocial: razon,
          usuarioId: u(),
        });
      }
    });

    it("«B%C» solo encuentra la razón social con el signo %", async () => {
      expect(ids(await leer(contador, c, `?q=${encodeURIComponent("B%C")}`))).toEqual([porRazon["AB%CD SAC"]]);
    });
    it("«B_C» solo encuentra la que tiene el guion bajo, no cualquier carácter", async () => {
      expect(ids(await leer(contador, c, `?q=${encodeURIComponent("B_C")}`))).toEqual([porRazon["AB_CD SAC"]]);
    });
    it("«%» solo y «_» solos no devuelven todo", async () => {
      expect(ids(await leer(contador, c, `?q=${encodeURIComponent("%")}`))).toEqual([porRazon["AB%CD SAC"]]);
      expect(ids(await leer(contador, c, `?q=${encodeURIComponent("_")}`))).toEqual([porRazon["AB_CD SAC"]]);
    });
    it("la barra invertida es texto", async () => {
      expect(ids(await leer(contador, c, `?q=${encodeURIComponent("B\\C")}`))).toEqual([porRazon["AB\\CD SAC"]]);
    });
    it("las comillas simples y dobles no rompen la consulta y encuentran su texto", async () => {
      expect(ids(await leer(contador, c, `?q=${encodeURIComponent("O'B")}`))).toEqual([porRazon["O'BRIEN & SONS"]]);
      expect(ids(await leer(contador, c, `?q=${encodeURIComponent('"DOBLE"')}`))).toEqual([porRazon['COMILLA "DOBLE" SAC']]);
    });
    it("una inyección de SQL es solo texto: lista vacía y la tabla sigue ahí", async () => {
      for (const q of ["'; drop table compra; --", "' OR '1'='1", '" OR 1=1 --', "x') UNION SELECT 1 --"]) {
        const r = await leer(contador, c, `?q=${encodeURIComponent(q)}`);
        expect(r.status, q).toBe(200);
        expect(r.body.filas, q).toEqual([]);
      }
      expect((await leer(contador, c)).body.filas).toHaveLength(6);
      expect((await v.compras(c.id)).length).toBe(6);
    });
  });
});

describe("CA-15 · listado de 5.000 filas en menos de 2 s en el servidor", () => {
  it("limite=5000 devuelve las 5.000 filas ordenadas y sin cursor en menos de 2 s (mediana de 3 lecturas)", async () => {
    const c = await nuevoCliente();
    const sembradas = await v.sembrarVolumen(E.tenantId, c.id, 5000, { usuarioId: u() });
    // Parte funcional (siempre, también bajo cobertura): filas, orden y cursor.
    const r = await leer(contador, c, "?limite=5000");
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body.filas).toHaveLength(5000);
    expect(ids(r)).toEqual(sembradas);
    expect(r.body.siguiente).toBeNull();
    // También paginado por defecto: la primera página responde.
    const p = await leer(contador, c);
    expect(p.status).toBe(200);
    expect(p.body.filas.length).toBeGreaterThan(0);

    // Tiempo (RNF-031): mediana de 3 lecturas, solo sin instrumentar (P-4). Bajo cobertura se registra y no se compara.
    const completo = await medirMediana(async () => (await leer(contador, c, "?limite=5000")).ms, 3);
    const pagina = await medirMediana(async () => (await leer(contador, c)).ms, 3);
    if (BAJO_COBERTURA) {
      console.info(`CA-15 bajo cobertura (no se compara): listado 5.000 = ${completo.toFixed(0)} ms, página = ${pagina.toFixed(0)} ms`);
      return;
    }
    expect(completo, "listado de 5.000 filas (mediana de 3)").toBeLessThan(2000);
    expect(pagina, "primera página (mediana de 3)").toBeLessThan(2000);
  });
});

// --- detalle ----------------------------------------------------------------------------------------------------------

describe("CA-2 · detalle: original y vigente por separado, con versiones y hallazgos", () => {
  it("la versión 1 es la fila del SIRE y la vigente es la corregida; las versiones traen autor, acción y fecha", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "3064",
      doc: "20700000053",
      razonSocial: "PRUEBA PROVEEDOR BOLSAS S.A.C.",
      usuarioId: u(),
      montos: { biDg: "100.00", igvDg: "18.00", icbper: "1.50" },
      versiones: [
        { montos: { biDg: "0.00", igvDg: "0.00", biDng: "100.00", igvDng: "18.00" }, clasificada: true, accion: "clasificar" },
        { montos: { biDng: "90.00" }, accion: "editar" },
      ],
      hallazgos: [hallazgoIscSinXml(montos({ biDg: "770.00" }))],
    });
    const r = await v.llamar(contador, "GET", `${base(c.id)}/${id}`);
    expect(r.status, r.text).toBe(200);
    expect(detalleCompraSchema.safeParse(r.body).success, r.text).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["hallazgos", "original", "versiones", "vigente"]);

    expect(r.body.original).toMatchObject({ n: 1, accion: "original", excluida: false, clasificada: false });
    expect(r.body.original.montos).toMatchObject({ biDg: "100.00", igvDg: "18.00", biDng: "0.00", icbper: "1.50", total: "119.50" });
    expect(r.body.vigente).toMatchObject({ id, version: 3, clasificada: true, excluida: false, origen: "sire" });
    expect(r.body.vigente.montos).toMatchObject({ biDg: "0.00", biDng: "90.00", igvDng: "18.00", total: "109.50" });

    expect(r.body.versiones.map((x: any) => x.n)).toEqual([1, 2, 3]);
    expect(r.body.versiones.map((x: any) => x.accion)).toEqual(["original", "clasificar", "editar"]);
    for (const x of r.body.versiones) {
      expect(x.usuarioId).toBe(E.titular.id);
      expect(Number.isNaN(Date.parse(x.creadaEn))).toBe(false);
    }
    // El original del detalle es la misma versión 1 de la lista de versiones.
    expect(r.body.versiones[0]).toEqual(r.body.original);
    // Los hallazgos son los de la versión vigente.
    expect(r.body.hallazgos.map((h: any) => h.regla)).toEqual(["R-ISC"]);
    expect(r.body.vigente.hallazgos).toEqual(r.body.hallazgos);
  });

  it("una compra sin cambios: original y vigente coinciden en montos y hay una sola versión", async () => {
    const { c, x } = await conFixture();
    const r = await v.llamar(contador, "GET", `${base(c.id)}/${x["F001-3064"]}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.versiones).toHaveLength(1);
    expect(r.body.original.montos).toEqual(r.body.vigente.montos);
    expect(r.body.vigente.version).toBe(1);
  });

  it("una agregada: versión 1 con accion agregada y sin propuesta a la vista", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, { serie: "F940", numero: "1", usuarioId: u(), origen: "agregada" });
    const r = await v.llamar(contador, "GET", `${base(c.id)}/${id}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.vigente.origen).toBe("agregada");
    expect(r.body.original.accion).toBe("agregada");
    expect(r.text).not.toContain("propuesta");
  });

  it("T17a: el detalle de una descargada y el de una agregada por la ruta traen acciones válidas según versionCompraVistaSchema", async () => {
    const c = await nuevoCliente();
    const descargada = await v.sembrarCompra(E.tenantId, c.id, { serie: "F950", numero: "1", usuarioId: u() });
    const alta = await v.llamar(E.titular, "POST", `${base(c.id)}`, {
      tipo: "01",
      serie: "F950",
      numero: "2",
      proveedor: { tipo: "6", numero: "20700000099", razonSocial: "PROVEEDOR AGREGADO SAC" },
      fecha: "2026-10-15",
      moneda: "PEN",
      montos: { biDg: "100.00", igvDg: "18.00" },
    });
    expect(alta.status, alta.text).toBe(201);
    for (const [id, esperada] of [
      [descargada, "original"],
      [alta.body.fila.id, "agregada"],
    ] as const) {
      const r = await v.llamar(contador, "GET", `${base(c.id)}/${id}`);
      expect(r.status, r.text).toBe(200);
      for (const x of [r.body.original, ...r.body.versiones]) {
        const ok = versionCompraVistaSchema.safeParse(x);
        expect(ok.success, `acción ${x.accion}: ${r.text}`).toBe(true);
      }
      expect(r.body.original.accion).toBe(esperada);
    }
  });

  it("el detalle de una excluida se puede leer, con su motivo", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F941",
      numero: "1",
      usuarioId: u(),
      versiones: [{ excluida: true, motivo: "zapatillas", accion: "excluir" }],
    });
    const r = await v.llamar(contador, "GET", `${base(c.id)}/${id}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.vigente).toMatchObject({ excluida: true, motivo: "zapatillas", version: 2 });
  });

  it("404 no_encontrado: inexistente, descartada, de otro cliente, de otro periodo y mal formada", async () => {
    const { c, x } = await conFixture();
    const otro = await conFixture();
    const descartada = await v.sembrarCompra(E.tenantId, c.id, { serie: "F942", numero: "1", usuarioId: u(), origen: "agregada", descartada: true });
    const enOtroPeriodo = await v.sembrarCompra(E.tenantId, c.id, { serie: "F943", numero: "1", usuarioId: u(), periodo: "202609" });
    expect((await v.llamar(contador, "GET", `${base(c.id)}/${x["F001-3064"]}`)).status).toBe(200); // control
    for (const [nombre, id] of [
      ["inexistente", randomUUID()],
      ["descartada", descartada],
      ["de otro cliente", otro.x["F001-3064"]!],
      ["de otro periodo", enOtroPeriodo],
      ["mal formada", "no-es-uuid"],
    ] as const) {
      const r = await v.llamar(contador, "GET", `${base(c.id)}/${id}`);
      expect(r.status, nombre).toBe(404);
      expect(r.body, nombre).toEqual({ codigo: "no_encontrado" });
    }
  });
});

// --- propuestas y diferencias (DU-19) -------------------------------------------------------------------------------------

describe("DU-19 · GET /propuestas y /propuestas/:propuestaId/diferencias (CA-17, lectura)", () => {
  async function conHistorial() {
    const c = await nuevoCliente();
    const otro = await v.cliente(E, { responsable: contador.id }); // sin el colaborador de solo lectura
    // Primera descarga (5 nuevas), segunda (todas iguales) y tercera con una distinta y una nueva (CA-17).
    const p1 = await v.sembrarPropuesta(E.tenantId, c.id, { usuarioId: u(), libro: "compras", nuevas: 5, creadaEn: "2026-11-01T10:00:00Z" });
    const p2 = await v.sembrarPropuesta(E.tenantId, c.id, { usuarioId: u(), libro: "compras", iguales: 5, creadaEn: "2026-11-02T10:00:00Z" });
    const p3 = await v.sembrarPropuesta(E.tenantId, c.id, {
      usuarioId: u(),
      libro: "compras",
      nuevas: 1,
      iguales: 3,
      distintas: 2,
      creadaEn: "2026-11-03T10:00:00Z",
    });
    await v.sembrarDiferenciaCompra(E.tenantId, p3, {
      clave: "01|F001|2056|6|20700000045",
      campos: ["biDg", "total"],
      valoresSire: { biDg: "22.00", total: "23.61" },
    });
    await v.sembrarDiferenciaCompra(E.tenantId, p3, {
      clave: "01|F001|9001|6|20700000099",
      origenExistente: "manual",
      campos: ["igvDg"],
      valoresSire: { igvDg: "2.00" },
    });
    // Lo que NO debe verse: otro periodo, el libro de ventas y otro cliente.
    const otroPeriodo = await v.sembrarPropuesta(E.tenantId, c.id, { usuarioId: u(), libro: "compras", periodo: "202609", nuevas: 7 });
    const deVentas = await v.sembrarPropuesta(E.tenantId, c.id, { usuarioId: u(), libro: "ventas", nuevas: 9 });
    const deOtro = await v.sembrarPropuesta(E.tenantId, otro.id, { usuarioId: u(), libro: "compras", nuevas: 5 });
    await v.sembrarDiferenciaCompra(E.tenantId, deOtro, {
      clave: "01|F009|1|6|20700000009",
      campos: ["total"],
      valoresSire: { total: "1.00" },
    });
    return { c, otro, p1, p2, p3, otroPeriodo, deVentas, deOtro };
  }
  const propuestas = (a: Actor, clienteId: string, periodo = PERIODO) =>
    v.llamar(a, "GET", `${base(clienteId, periodo)}/propuestas`);
  const diferencias = (a: Actor, clienteId: string, id: string, periodo = PERIODO) =>
    v.llamar(a, "GET", `${base(clienteId, periodo)}/propuestas/${id}/diferencias`);

  it("GET /propuestas: las del cliente, periodo y libro compras, la más reciente primero, con sus contadores y nada más", async () => {
    const h = await conHistorial();
    const r = await propuestas(contador, h.c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect((r.body as any[]).map((p) => p.id)).toEqual([h.p3, h.p2, h.p1]);
    expect(r.body[0]).toEqual({
      id: h.p3,
      fuente: "api",
      filasRecibidas: 6,
      filasNuevas: 1,
      filasIguales: 3,
      filasDistintas: 2,
      creadaEn: "2026-11-03T10:00:00.000Z",
    });
    expect(r.body[2]).toMatchObject({ filasRecibidas: 5, filasNuevas: 5, filasIguales: 0, filasDistintas: 0 });
    for (const p of r.body as any[]) {
      expect(Object.keys(p).sort()).toEqual(["creadaEn", "filasDistintas", "filasIguales", "filasNuevas", "filasRecibidas", "fuente", "id"]);
      expect(p.filasRecibidas).toBe(p.filasNuevas + p.filasIguales + p.filasDistintas);
    }
    expect(r.text).not.toMatch(/hash|usuario|trabajo|tenant/i);
  });

  it("no mezcla ventas: la propuesta del libro de ventas del mismo cliente y periodo no aparece", async () => {
    const h = await conHistorial();
    const r = await propuestas(contador, h.c.id);
    expect((r.body as any[]).map((p) => p.id)).not.toContain(h.deVentas);
    expect((r.body as any[]).map((p) => p.id)).not.toContain(h.otroPeriodo);
    // Y la ruta de ventas no ve las de compras.
    const rv = await v.llamar(contador, "GET", `/clientes/${h.c.id}/periodos/${PERIODO}/ventas/propuestas`);
    expect(rv.status, rv.text).toBe(200);
    expect((rv.body as any[]).map((p) => p.id)).toEqual([h.deVentas]);
  });

  it("un cliente sin descargas: lista vacía", async () => {
    const c = await nuevoCliente();
    const r = await propuestas(contador, c.id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("GET /propuestas/:id/diferencias: las de esa propuesta, con campos y valores del SIRE", async () => {
    const h = await conHistorial();
    const r = await diferencias(contador, h.c.id, h.p3);
    expect(r.status, r.text).toBe(200);
    const filas = [...(r.body as any[])].sort((a, b) => a.clave.localeCompare(b.clave));
    expect(filas).toEqual([
      {
        clave: "01|F001|2056|6|20700000045",
        tipo: "01",
        serie: "F001",
        numero: "2056",
        origenExistente: "sire",
        campos: ["biDg", "total"],
        valoresSire: { biDg: "22.00", total: "23.61" },
      },
      {
        clave: "01|F001|9001|6|20700000099",
        tipo: "01",
        serie: "F001",
        numero: "9001",
        origenExistente: "manual",
        campos: ["igvDg"],
        valoresSire: { igvDg: "2.00" },
      },
    ]);
    expect(Object.keys(filas[0]).sort()).toEqual(["campos", "clave", "numero", "origenExistente", "serie", "tipo", "valoresSire"]);
  });

  it("una propuesta sin diferencias: lista vacía", async () => {
    const h = await conHistorial();
    const r = await diferencias(contador, h.c.id, h.p1);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("la propuesta de otro cliente, de otro periodo, del libro de ventas, inexistente o mal formada: 404 sin datos", async () => {
    const h = await conHistorial();
    expect((await diferencias(contador, h.c.id, h.p3)).status).toBe(200); // control: la ruta existe
    for (const [nombre, id] of [
      ["de otro cliente", h.deOtro],
      ["de otro periodo", h.otroPeriodo],
      ["del libro de ventas", h.deVentas],
      ["inexistente", randomUUID()],
      ["mal formada", "no-es-uuid"],
    ] as const) {
      const r = await diferencias(contador, h.c.id, id);
      expect(r.status, nombre).toBe(404);
      expect(r.body, nombre).toEqual({ codigo: "no_encontrado" });
      expect(r.text, nombre).not.toContain("F009");
    }
  });

  it("otro estudio: la lista y las diferencias del cliente de E son un 404 para el Dueño de F", async () => {
    const h = await conHistorial();
    expect((await diferencias(E.titular, h.c.id, h.p3)).status).toBe(200); // control
    expect((await diferencias(F.titular, h.c.id, h.p3)).status).toBe(404);
    expect((await propuestas(F.titular, h.c.id)).status).toBe(404);
  });

  it("D-11: lectura (colaborador) las ve; sin asignar, el mismo 404 que un cliente inexistente; sin sesión, 401", async () => {
    const h = await conHistorial();
    expect((await propuestas(lectura, h.c.id)).status).toBe(200);
    expect((await diferencias(lectura, h.c.id, h.p3)).status).toBe(200);
    expect((await propuestas(E.titular, h.otro.id)).status).toBe(200); // control
    const r = await propuestas(lectura, h.otro.id);
    expect(r.status).toBe(404);
    expect(forma(r)).toEqual(forma(await propuestas(lectura, randomUUID())));
    const d = await diferencias(lectura, h.otro.id, h.deOtro);
    expect(d.status).toBe(404);
    expect(d.text).not.toContain("F009");
    expect((await v.sinSesion("GET", `${base(h.c.id)}/propuestas`)).status).toBe(401);
    expect((await v.sinSesion("GET", `${base(h.c.id)}/propuestas/${h.p3}/diferencias`)).status).toBe(401);
  });

  it("un cliente archivado se puede leer", async () => {
    const h = await conHistorial();
    const a = await nuevoCliente({ archivado: true });
    const p = await v.sembrarPropuesta(E.tenantId, a.id, { usuarioId: u(), libro: "compras", nuevas: 1 });
    expect((await propuestas(contador, a.id)).body.map((x: any) => x.id)).toEqual([p]);
    expect(h.c.id).not.toBe(a.id);
  });

  it("la ruta estática `propuestas` no se confunde con un :compraId", async () => {
    const h = await conHistorial();
    const r = await propuestas(contador, h.c.id);
    expect(Array.isArray(r.body)).toBe(true); // una lista, no un detalle ni un 404 de compra
  });
});

// --- CA-13 · aislamiento de las lecturas ---------------------------------------------------------------------------------

interface RutaLectura {
  nombre: string;
  ruta: (x: { compraId: string; propuestaId: string }) => string;
  binaria?: boolean;
}
const RUTAS: RutaLectura[] = [
  { nombre: "GET listado", ruta: () => "" },
  { nombre: "GET resumen", ruta: () => "/resumen" },
  { nombre: "GET exportar.xlsx", ruta: () => "/exportar.xlsx", binaria: true },
  { nombre: "GET propuestas", ruta: () => "/propuestas" },
  { nombre: "GET diferencias", ruta: (x) => `/propuestas/${x.propuestaId}/diferencias` },
  { nombre: "GET detalle", ruta: (x) => `/${x.compraId}` },
];

async function pedirLectura(a: Actor, r: RutaLectura, clienteId: string, x: { compraId: string; propuestaId: string }, periodo = PERIODO) {
  const url = `${base(clienteId, periodo)}${r.ruta(x)}`;
  if (r.binaria === true) {
    const b = await v.bin(a, "GET", url);
    return { status: b.status, body: b.json, headers: b.headers, text: b.texto };
  }
  const s = await v.llamar(a, "GET", url);
  return { status: s.status, body: s.body, headers: s.headers, text: s.text };
}
const sinFecha = (h: Record<string, unknown>) => {
  const { date: _d, ...resto } = h;
  void _d;
  return resto;
};

async function conDatos(o: Parameters<BancoCompras["cliente"]>[1] = {}) {
  const c = await nuevoCliente(o);
  const x: IdsPorNumero = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u() });
  const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { usuarioId: u(), libro: "compras", nuevas: 1 });
  return { c, ids: { compraId: x["F001-3064"]!, propuestaId } };
}

describe("CA-13 · el mismo 404 para cliente ajeno, no asignado e inexistente en todas las lecturas", () => {
  it.each(RUTAS)("otro estudio · $nombre", async (r) => {
    const { c, ids: x } = await conDatos();
    // La ruta existe para el dueño legítimo: con un periodo mal formado responde 400, no el 404 de una ruta inexistente.
    expect((await pedirLectura(E.titular, r, c.id, x, "2026-10")).status, `${r.nombre} existe`).toBe(400);
    const ajeno = await pedirLectura(F.titular, r, c.id, x);
    const inexistente = await pedirLectura(F.titular, r, randomUUID(), x);
    expect(ajeno.status, ajeno.text).toBe(404);
    expect(ajeno.body).toEqual({ codigo: "no_encontrado" });
    expect(ajeno.status).toBe(inexistente.status);
    expect(ajeno.body).toEqual(inexistente.body);
    expect(sinFecha(ajeno.headers)).toEqual(sinFecha(inexistente.headers));
  });

  it.each(RUTAS)("asistente no asignado · $nombre", async (r) => {
    const { c, ids: x } = await conDatos();
    expect((await pedirLectura(E.titular, r, c.id, x, "2026-10")).status).toBe(400);
    const ajeno = await pedirLectura(asistenteAjeno, r, c.id, x);
    const inexistente = await pedirLectura(asistenteAjeno, r, randomUUID(), x);
    expect(ajeno.status, ajeno.text).toBe(404);
    expect(ajeno.body).toEqual({ codigo: "no_encontrado" });
    expect(ajeno.body).toEqual(inexistente.body);
    expect(sinFecha(ajeno.headers)).toEqual(sinFecha(inexistente.headers));
  });

  it.each(RUTAS)("sin sesión: 401 · $nombre", async (r) => {
    const { c, ids: x } = await conDatos();
    expect((await pedirLectura(E.titular, r, c.id, x, "2026-10")).status).toBe(400);
    const s = await v.sinSesion("GET", `${base(c.id)}${r.ruta(x)}`);
    expect(s.status, s.text).toBe(401);
  });

  it.each(RUTAS)("lectura asignada y cliente archivado: se puede leer · $nombre", async (r) => {
    for (const o of [{}, { archivado: true }]) {
      const { c, ids: x } = await conDatos(o);
      const l = await pedirLectura(lectura, r, c.id, x);
      expect(l.status, `${r.nombre} ${JSON.stringify(o)}: ${l.text.slice(0, 200)}`).toBe(200);
    }
  });

  it("el otro estudio no ve nada: su cliente del mismo periodo está vacío y los datos de E no se cuelan en ninguna lectura", async () => {
    await conDatos();
    const cf = await v.cliente(F);
    const lista = await v.llamar(F.titular, "GET", `${base(cf.id)}`);
    expect(lista.status, lista.text).toBe(200);
    expect(lista.body).toEqual({ filas: [], siguiente: null });
    expect((await v.llamar(F.titular, "GET", `${base(cf.id)}/propuestas`)).body).toEqual([]);
    const res = await v.llamar(F.titular, "GET", `${base(cf.id)}/resumen`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.casilleros.vigente.total).toBe("0.00");
    expect(res.text).not.toContain(E.tenantId);
  });

  it("un compraId de otro cliente, periodo o estudio es el mismo 404 en el detalle", async () => {
    const { c, ids: x } = await conDatos();
    const otro = await conDatos();
    const cf = await v.cliente(F);
    const deF = await v.sembrarFixture(F.tenantId, cf.id, { usuarioId: F.titular.id });
    const enOtroPeriodo = await v.sembrarCompra(E.tenantId, c.id, { serie: "F960", numero: "1", usuarioId: u(), periodo: "202609" });
    expect((await v.llamar(contador, "GET", `${base(c.id)}/${x.compraId}`)).status).toBe(200); // control
    for (const id of [otro.ids.compraId, deF["F001-3064"]!, enOtroPeriodo, randomUUID()]) {
      const r = await v.llamar(contador, "GET", `${base(c.id)}/${id}`);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
  });
});
