// Spec 014 (T6, rojo): repositorios de versiones de `packages/db/src/compras/**` contra la BD real (CA-2, CA-3, CA-6, CA-8,
// CA-10; D-1, D-2, D-4, D-5, D-7, DU-16). Se importan de `@contapp/db` por nombre (si faltan, la prueba dice cual).
//
// REGLA DE CAPAS (013 D16, plan «Archivos»): `packages/db` no depende de `packages/domain`. Aqui `evaluar` y `transformar` son
// FUNCIONES DE PRUEBA inyectadas (compras-soporte.ts); ninguna prueba de `packages/db` importa `@contapp/domain`.
//
// FIRMAS que fija (T12). Todas reciben la `tx` de `withTenant` como primer argumento. Montos, tipo de cambio y fecha viajan como
// CADENAS ("118.00", "3.456", "2026-10-05"), nunca `number`; las marcas de tiempo, como Date. Los tipos estan en compras-soporte.ts
// (DatosVersion, IdentidadCompra, CompraLeida, VersionFila, HallazgoNuevo, Evaluar, Transformar).
//   crearVersion(tx, { compraId, versionBase: number, datos: DatosVersion, accion: string, usuarioId: string,
//       operacionId?: string | null }, { evaluar }): Promise<VersionFila>
//       UNICO punto de escritura de una version: comprueba versionBase contra version_vigente; inserta la version n+1; mueve el
//       puntero con compare-and-set; llama a `evaluar(CompraLeida con la version nueva)` y guarda los hallazgos que devuelve con
//       version_n = n+1 (los de versiones anteriores quedan); todo en la transaccion recibida. Si evaluar lanza, no queda nada.
//       Errores: ComprasReglaError { codigo: 'version_obsoleta', versionVigente } (sin escribir) o { codigo: 'no_encontrada' }
//       (id inexistente, de otro estudio o descartada).
//   aplicarAccion(tx, { compraId, versionBase, accion, parametros, usuarioId }, { transformar, evaluar }):
//       Promise<{ operacionId: string; version: VersionFila }>
//       Lee la compra vigente; version_obsoleta si versionBase no es la vigente; fila_excluida si esta excluida y la accion no es
//       'restaurar'; llama transformar(actual: CompraLeida, parametros) -> DatosVersion | { rechazo: codigo } (el rechazo se lanza
//       como ComprasReglaError con ese codigo y no se escribe nada); crea una compra_operacion (tipo = accion, estado vigente, del
//       usuario, cliente y periodo de la compra), pasa a `caducada` las operaciones `deshecha` de ese usuario en ese cliente y
//       periodo, y escribe la version con crearVersion (operacion_id = la nueva operacion).
//   agregarCompra(tx, { clienteId, periodo, usuarioId, identidad: IdentidadCompra, montos: Montos }, { evaluar }):
//       Promise<{ id: string; version: VersionFila }>
//       Crea compra origen 'agregada' (propuesta_id null) y su version 1 (accion 'agregada'); evalua; NO crea operacion (no entra
//       en la pila de deshacer, DU-14). Clave viva repetida (tambien excluida o de origen sire): ComprasReglaError
//       { codigo: 'duplicado', ids: [idDeLaExistente] }.
//   descartar(tx, { compraId, versionBase, usuarioId }): Promise<void>
//       Solo agregadas: descartada_en = now(); libera la clave; sin version ni operacion. 'no_descartable' (sire),
//       'version_obsoleta', 'no_encontrada'.
//   insertarCompras(tx, { clienteId, periodo, propuestaId }, nuevas: (IdentidadCompra & { montos: Montos })[], { evaluar }):
//       Promise<string[]>   (ids en el orden de `nuevas`)
//       Origen sire con su propuesta; version 1 (accion 'original') de cada una; evalua cada una y guarda sus hallazgos con
//       version_n = 1. Todo o nada; una clave viva repetida lanza ComprasRepoError { codigo: '23505' }. Parte la insercion en lotes.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  barrera,
  claveCompra,
  codigoDe,
  contarFilas,
  EscenarioCompras,
  errorDe,
  evaluadorFalso,
  MONTOS_DG,
  montos,
  PERIODO,
  sinHallazgos,
  transformarFalso,
  type CompraLeida,
  type DatosVersion,
  type Evaluar,
  type IdentidadCompra,
  type Montos,
  type ParametrosFalsos,
  type Transformar,
  type VersionFila,
} from "./compras-soporte";

interface Funciones {
  evaluar: Evaluar;
}
const crearVersion = (
  tx: Tx,
  e: {
    compraId: string;
    versionBase: number;
    datos: DatosVersion;
    accion: string;
    usuarioId: string;
    operacionId?: string | null;
  },
  f: Funciones,
) =>
  exportado<(tx: Tx, e: unknown, f: Funciones) => Promise<VersionFila>>(
    "crearVersion",
  )(tx, e, f);
const aplicarAccion = (
  tx: Tx,
  e: {
    compraId: string;
    versionBase: number;
    accion: string;
    parametros: ParametrosFalsos;
    usuarioId: string;
  },
  f: Funciones & { transformar: Transformar },
) =>
  exportado<
    (
      tx: Tx,
      e: unknown,
      f: unknown,
    ) => Promise<{ operacionId: string; version: VersionFila }>
  >("aplicarAccion")(tx, e, f);
const agregarCompra = (
  tx: Tx,
  e: {
    clienteId: string;
    periodo: string;
    usuarioId: string;
    identidad: IdentidadCompra;
    montos: Montos;
  },
  f: Funciones,
) =>
  exportado<
    (
      tx: Tx,
      e: unknown,
      f: Funciones,
    ) => Promise<{ id: string; version: VersionFila }>
  >("agregarCompra")(tx, e, f);
const descartar = (
  tx: Tx,
  e: { compraId: string; versionBase: number; usuarioId: string },
) => exportado<(tx: Tx, e: unknown) => Promise<void>>("descartar")(tx, e);
const insertarCompras = (
  tx: Tx,
  c: { clienteId: string; periodo: string; propuestaId: string },
  nuevas: (IdentidadCompra & { montos: Montos })[],
  f: Funciones,
) =>
  exportado<
    (tx: Tx, c: unknown, n: unknown, f: Funciones) => Promise<string[]>
  >("insertarCompras")(tx, c, nuevas, f);

let admin: Pool;
let ec: EscenarioCompras;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let ux2: string;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioCompras(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  ux2 = (await ec.miembro(X, "contador")).id;
  backend = crearDb("contapp_backend", 12);
  worker = crearDb("contapp_worker", 4);
  propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  backend.withTenant({ tenantId }, fn);
const versionesDe = async (compraId: string) =>
  (
    await admin.query(
      "select * from compra_version where compra_id = $1 order by n",
      [compraId],
    )
  ).rows;
const punteroDe = async (compraId: string) =>
  (
    await admin.query("select version_vigente from compra where id = $1", [
      compraId,
    ])
  ).rows[0]?.version_vigente as number;
const hallazgosDe = async (compraId: string) =>
  (
    await admin.query(
      "select version_n, regla, sugerencia, lecturas, requiere_confirmacion from compra_hallazgo where compra_id = $1 order by version_n, regla",
      [compraId],
    )
  ).rows;
const datos = (
  m: Partial<Montos>,
  resto: Partial<DatosVersion> = {},
): DatosVersion => ({
  montos: montos(m),
  excluida: false,
  motivo: null,
  clasificada: false,
  ...resto,
});
const identidad = (
  serie: string,
  numero: string,
  o: Partial<IdentidadCompra> = {},
): IdentidadCompra => ({
  clave: claveCompra("01", serie, numero, "6", "20100070970"),
  tipoDoc: "01",
  serie,
  numero,
  docTipo: "6",
  docNumero: "20100070970",
  razonSocial: "PROVEEDOR SINTETICO SAC",
  fecha: "2026-10-05",
  moneda: "PEN",
  tipoCambio: null,
  ...o,
});

// =================================================================================================
describe("crearVersion · punto unico de escritura de version (D-1, D-2, D-4)", () => {
  it("inserta la version n+1, mueve el puntero y deja intacta la version 1 (CA-2)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX, montos: MONTOS_DG });
    const antes = (await versionesDe(c.id))[0];
    const { evaluar } = sinHallazgos();
    const v = await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: c.id,
          versionBase: 1,
          datos: datos(
            { biDg: "900.00", igvDg: "162.00" },
            { clasificada: true },
          ),
          accion: "editar",
          usuarioId: ux,
        },
        { evaluar },
      ),
    );
    expect(v).toMatchObject({
      compraId: c.id,
      n: 2,
      accion: "editar",
      usuarioId: ux,
      operacionId: null,
      clasificada: true,
      excluida: false,
    });
    expect(v.montos).toEqual(montos({ biDg: "900.00", igvDg: "162.00" }));
    expect(v.creadaEn).toBeInstanceOf(Date);
    expect(await punteroDe(c.id)).toBe(2);
    const filas = await versionesDe(c.id);
    expect(filas.map((f) => f.n)).toEqual([1, 2]);
    expect(filas[0]).toEqual(antes);
    expect(filas[1].total).toBe("1062.00");
  });

  it("versionBase obsoleta: version_obsoleta con la version vigente, sin escribir nada y sin llamar a evaluar", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    await ec.version(X, c.id, 2, {
      montos: { biDg: "900.00", igvDg: "162.00" },
    });
    const e = evaluadorFalso();
    const err = await errorDe(
      comoBackend((tx) =>
        crearVersion(
          tx,
          {
            compraId: c.id,
            versionBase: 1,
            datos: datos({ biDg: "1.00" }),
            accion: "editar",
            usuarioId: ux,
          },
          { evaluar: e.evaluar },
        ),
      ),
    );
    expect(err).toMatchObject({
      codigo: "version_obsoleta",
      versionVigente: 2,
    });
    expect((await versionesDe(c.id)).map((f) => f.n)).toEqual([1, 2]);
    expect(await punteroDe(c.id)).toBe(2);
    expect(e.llamadas).toHaveLength(0);
    expect(await hallazgosDe(c.id)).toEqual([]);
  });

  it("una versionBase futura tampoco escribe (no es la vigente)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const codigo = await codigoDe(
      comoBackend((tx) =>
        crearVersion(
          tx,
          {
            compraId: c.id,
            versionBase: 5,
            datos: datos({}),
            accion: "editar",
            usuarioId: ux,
          },
          sinHallazgos(),
        ),
      ),
    );
    expect(codigo).toBe("version_obsoleta");
    expect(await versionesDe(c.id)).toHaveLength(1);
  });

  it("re-evalua la fila con la version NUEVA y guarda sus hallazgos con version_n = n; los de la version anterior quedan (nota [014])", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX, montos: MONTOS_DG });
    await admin.query(
      "insert into compra_evaluacion (tenant_id, compra_id, version_n, n) values ($1, $2, 1, 1) on conflict do nothing",
      [X, c.id],
    );
    await admin.query(
      "insert into compra_hallazgo (tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion) values ($1, $2, 1, 1, 'R-VIEJA', '{}', '{}', false)",
      [X, c.id],
    );
    const e = evaluadorFalso();
    await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: c.id,
          versionBase: 1,
          datos: datos({ biDg: "770.00", igvDg: "138.60" }),
          accion: "editar",
          usuarioId: ux,
        },
        { evaluar: e.evaluar },
      ),
    );
    expect(e.llamadas).toHaveLength(1);
    const vista = e.llamadas[0] as CompraLeida;
    expect(vista).toMatchObject({
      id: c.id,
      clienteId: cx.id,
      periodo: PERIODO,
      origen: "sire",
      version: 2,
      clave: c.clave,
    });
    expect(vista.montos.biDg).toBe("770.00");
    const h = await hallazgosDe(c.id);
    expect(h.map((x) => [x.version_n, x.regla])).toEqual([
      [1, "R-VIEJA"],
      [2, "R-FALSA"],
    ]);
    expect(h[1]).toMatchObject({
      sugerencia: { destino: "DNG" },
      lecturas: { biDg: "770.00" },
      requiere_confirmacion: false,
    });
  });

  it("si evaluar no devuelve hallazgos, la version nueva queda sin ellos (la fila sin hallazgos vigentes)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: c.id,
          versionBase: 1,
          datos: datos({}),
          accion: "editar",
          usuarioId: ux,
        },
        sinHallazgos(),
      ),
    );
    expect(await hallazgosDe(c.id)).toEqual([]);
  });

  it("si evaluar lanza, no queda version, ni puntero movido, ni hallazgos (todo en una transaccion)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const mala: Evaluar = () => {
      throw new Error("la regla fallo");
    };
    const codigo = await codigoDe(
      comoBackend((tx) =>
        crearVersion(
          tx,
          {
            compraId: c.id,
            versionBase: 1,
            datos: datos({}),
            accion: "editar",
            usuarioId: ux,
          },
          { evaluar: mala },
        ),
      ),
    );
    expect(codigo).not.toBe("ok");
    expect(await versionesDe(c.id)).toHaveLength(1);
    expect(await punteroDe(c.id)).toBe(1);
    expect(await hallazgosDe(c.id)).toEqual([]);
  });

  it("una compra inexistente, de otro estudio o descartada es no_encontrada (el mismo codigo, sin revelar)", async () => {
    const ajena = await ec.compra(Y, cy);
    const descartada = await ec.compra(X, cx, { origen: "agregada" });
    await admin.query("update compra set descartada_en = now() where id = $1", [
      descartada.id,
    ]);
    for (const id of [
      ajena.id,
      "00000000-0000-4000-8000-000000000009",
      descartada.id,
    ]) {
      const codigo = await codigoDe(
        comoBackend((tx) =>
          crearVersion(
            tx,
            {
              compraId: id,
              versionBase: 1,
              datos: datos({}),
              accion: "editar",
              usuarioId: ux,
            },
            sinHallazgos(),
          ),
        ),
      );
      expect(codigo, id).toBe("no_encontrada");
    }
    expect(await versionesDe(ajena.id)).toHaveLength(1);
  });

  it("guarda excluida, motivo y clasificada y devuelve los montos como cadenas exactas (negativos incluidos)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const v = await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: c.id,
          versionBase: 1,
          datos: datos(
            { biDg: "-100.00", igvDg: "-18.00" },
            {
              excluida: true,
              motivo: "Zapatillas de uso personal",
              clasificada: true,
            },
          ),
          accion: "excluir",
          usuarioId: ux,
        },
        sinHallazgos(),
      ),
    );
    expect(v).toMatchObject({
      excluida: true,
      motivo: "Zapatillas de uso personal",
      clasificada: true,
    });
    expect(v.montos).toMatchObject({
      biDg: "-100.00",
      igvDg: "-18.00",
      total: "-118.00",
    });
    for (const k of Object.values(v.montos)) expect(typeof k).toBe("string");
  });

  it("CA-3 · 25 rondas: dos acciones simultaneas con el mismo versionBase, una gana y la otra recibe version_obsoleta sin escribir", async () => {
    for (let ronda = 0; ronda < 25; ronda++) {
      const c = await ec.compra(X, cx, { propuestaId: propX });
      const llegar = barrera(2);
      const accion = (biDg: string) =>
        comoBackend(async (tx) => {
          await llegar();
          return crearVersion(
            tx,
            {
              compraId: c.id,
              versionBase: 1,
              datos: datos({ biDg }),
              accion: "editar",
              usuarioId: ux,
            },
            sinHallazgos(),
          );
        });
      const r = await Promise.allSettled([accion("100.00"), accion("200.00")]);
      const ok = r.filter((x) => x.status === "fulfilled");
      const mal = r.filter(
        (x): x is PromiseRejectedResult => x.status === "rejected",
      );
      expect(ok, `ronda ${ronda}: exactamente una gana`).toHaveLength(1);
      expect(
        mal.map(
          (x) =>
            (x.reason as { codigo?: string; code?: string }).codigo ??
            (x.reason as { code?: string }).code,
        ),
        `ronda ${ronda}`,
      ).toEqual(["version_obsoleta"]);
      expect(
        (await versionesDe(c.id)).map((f) => f.n),
        `ronda ${ronda}: sin huecos ni versiones de mas`,
      ).toEqual([1, 2]);
      expect(await punteroDe(c.id)).toBe(2);
    }
  });

  it("CA-3 · ocho acciones simultaneas con el mismo versionBase dejan exactamente una version nueva", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const llegar = barrera(8);
    const r = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        comoBackend(async (tx) => {
          await llegar();
          return crearVersion(
            tx,
            {
              compraId: c.id,
              versionBase: 1,
              datos: datos({ biDg: `${100 + i}.00` }),
              accion: "editar",
              usuarioId: ux,
            },
            sinHallazgos(),
          );
        }),
      ),
    );
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      r
        .filter((x): x is PromiseRejectedResult => x.status === "rejected")
        .every(
          (x) =>
            (x.reason as { codigo?: string }).codigo === "version_obsoleta",
        ),
    ).toBe(true);
    expect((await versionesDe(c.id)).map((f) => f.n)).toEqual([1, 2]);
  });

  it("acciones simultaneas sobre filas distintas no se estorban: las dos entran", async () => {
    const a = await ec.compra(X, cx, { propuestaId: propX });
    const b = await ec.compra(X, cx, { propuestaId: propX });
    const llegar = barrera(2);
    const accion = (id: string) =>
      comoBackend(async (tx) => {
        await llegar();
        return crearVersion(
          tx,
          {
            compraId: id,
            versionBase: 1,
            datos: datos({ biDg: "50.00" }),
            accion: "editar",
            usuarioId: ux,
          },
          sinHallazgos(),
        );
      });
    const r = await Promise.allSettled([accion(a.id), accion(b.id)]);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});

// =================================================================================================
describe("aplicarAccion · una accion de fila con operacion (D-2, D-5, D-6, D-14)", () => {
  it("clasificar como DNG: version nueva con operacion, BI e IGV pasan a las columnas 3 y el total no cambia (CA-4)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX, montos: MONTOS_DG });
    const e = evaluadorFalso();
    const r = await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: c.id,
          versionBase: 1,
          accion: "clasificar",
          parametros: { tipo: "dng" },
          usuarioId: ux,
        },
        { transformar: transformarFalso, evaluar: e.evaluar },
      ),
    );
    expect(r.version).toMatchObject({
      n: 2,
      accion: "clasificar",
      operacionId: r.operacionId,
      usuarioId: ux,
      clasificada: true,
    });
    expect(r.version.montos).toMatchObject({
      biDg: "0.00",
      igvDg: "0.00",
      biDng: "1000.00",
      igvDng: "180.00",
      total: "1180.00",
    });
    const op = (
      await admin.query("select * from compra_operacion where id = $1", [
        r.operacionId,
      ])
    ).rows[0];
    expect(op).toMatchObject({
      cliente_id: cx.id,
      periodo: PERIODO,
      usuario_id: ux,
      tipo: "clasificar",
      estado: "vigente",
      deshecha_en: null,
    });
    expect(e.llamadas).toHaveLength(1);
    expect((await versionesDe(c.id))[0].total).toBe("1180.00");
  });

  it("transformar recibe la compra vigente (cadenas) y los parametros tal cual", async () => {
    const c = await ec.compra(X, cx, {
      propuestaId: propX,
      montos: MONTOS_DG,
      moneda: "USD",
      tipoCambio: "3.456",
    });
    const vistas: { actual: CompraLeida; parametros: unknown }[] = [];
    const t: Transformar = (actual, parametros) => {
      vistas.push({ actual, parametros });
      return datos({ biDg: "10.00" });
    };
    await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: c.id,
          versionBase: 1,
          accion: "editar",
          parametros: { tipo: "bi", valor: "10.00" },
          usuarioId: ux,
        },
        { transformar: t, evaluar: sinHallazgos().evaluar },
      ),
    );
    expect(vistas).toHaveLength(1);
    expect(vistas[0].parametros).toEqual({ tipo: "bi", valor: "10.00" });
    expect(vistas[0].actual).toMatchObject({
      id: c.id,
      version: 1,
      moneda: "USD",
      tipoCambio: "3.456",
      origen: "sire",
      excluida: false,
    });
    expect(vistas[0].actual.montos).toEqual(MONTOS_DG);
  });

  it("versionBase obsoleta: version_obsoleta, sin version ni operacion nueva", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    await ec.version(X, c.id, 2, {
      montos: { biDg: "900.00", igvDg: "162.00" },
    });
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    const err = await errorDe(
      comoBackend((tx) =>
        aplicarAccion(
          tx,
          {
            compraId: c.id,
            versionBase: 1,
            accion: "clasificar",
            parametros: { tipo: "dng" },
            usuarioId: ux,
          },
          { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
        ),
      ),
    );
    expect(err).toMatchObject({
      codigo: "version_obsoleta",
      versionVigente: 2,
    });
    expect(await versionesDe(c.id)).toHaveLength(2);
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
    ).toBe(ops);
  });

  it("una fila excluida solo admite restaurar: cualquier otra accion es fila_excluida (D-6)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    await ec.version(X, c.id, 2, {
      excluida: true,
      motivo: "zapatillas",
      accion: "excluir",
    });
    for (const p of [
      { tipo: "dng" },
      { tipo: "bi", valor: "5.00" },
      { tipo: "excluir" },
    ] as ParametrosFalsos[]) {
      const codigo = await codigoDe(
        comoBackend((tx) =>
          aplicarAccion(
            tx,
            {
              compraId: c.id,
              versionBase: 2,
              accion: p.tipo,
              parametros: p,
              usuarioId: ux,
            },
            { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
          ),
        ),
      );
      expect(codigo, p.tipo).toBe("fila_excluida");
    }
    expect(await versionesDe(c.id)).toHaveLength(2);
    const r = await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: c.id,
          versionBase: 2,
          accion: "restaurar",
          parametros: { tipo: "restaurar" },
          usuarioId: ux,
        },
        { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
      ),
    );
    expect(r.version).toMatchObject({
      n: 3,
      excluida: false,
      motivo: null,
      accion: "restaurar",
    });
  });

  it("excluir guarda el motivo en la version nueva y deja la 1 intacta (CA-7, zapatilla)", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const r = await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: c.id,
          versionBase: 1,
          accion: "excluir",
          parametros: { tipo: "excluir", motivo: "zapatillas" },
          usuarioId: ux,
        },
        { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
      ),
    );
    expect(r.version).toMatchObject({ excluida: true, motivo: "zapatillas" });
    expect((await versionesDe(c.id))[0]).toMatchObject({
      excluida: false,
      motivo: null,
    });
  });

  it("un rechazo de transformar se lanza con su codigo y no escribe version ni operacion", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    for (const rechazo of ["requiere_dato", "revisar_de_nuevo"]) {
      const codigo = await codigoDe(
        comoBackend((tx) =>
          aplicarAccion(
            tx,
            {
              compraId: c.id,
              versionBase: 1,
              accion: "sugerencia",
              parametros: { tipo: "rechazar", codigo: rechazo },
              usuarioId: ux,
            },
            { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
          ),
        ),
      );
      expect(codigo).toBe(rechazo);
    }
    expect(await versionesDe(c.id)).toHaveLength(1);
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
    ).toBe(ops);
  });

  it("si transformar lanza, nada queda escrito", async () => {
    const c = await ec.compra(X, cx, { propuestaId: propX });
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    const codigo = await codigoDe(
      comoBackend((tx) =>
        aplicarAccion(
          tx,
          {
            compraId: c.id,
            versionBase: 1,
            accion: "editar",
            parametros: { tipo: "lanzar" },
            usuarioId: ux,
          },
          { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
        ),
      ),
    );
    expect(codigo).not.toBe("ok");
    expect(await versionesDe(c.id)).toHaveLength(1);
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
    ).toBe(ops);
  });

  it("una operacion nueva pasa a caducada las deshecha de ESE usuario, cliente y periodo (rehacer vale hasta la siguiente accion)", async () => {
    const c = await ec.cliente(X);
    const compra = await ec.compra(X, c, { propuestaId: propX });
    const propia = await ec.operacion(X, c, {
      usuarioId: ux,
      estado: "deshecha",
    });
    const propiaVigente = await ec.operacion(X, c, {
      usuarioId: ux,
      estado: "vigente",
    });
    const deOtro = await ec.operacion(X, c, {
      usuarioId: ux2,
      estado: "deshecha",
    });
    const otroPeriodo = await ec.operacion(X, c, {
      usuarioId: ux,
      estado: "deshecha",
      periodo: "202609",
    });
    const otroCliente = await ec.operacion(X, cx, {
      usuarioId: ux,
      estado: "deshecha",
    });
    await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: compra.id,
          versionBase: 1,
          accion: "editar",
          parametros: { tipo: "bi", valor: "1.00" },
          usuarioId: ux,
        },
        { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
      ),
    );
    const estado = async (id: string) =>
      (
        await admin.query("select estado from compra_operacion where id = $1", [
          id,
        ])
      ).rows[0].estado;
    expect(await estado(propia)).toBe("caducada");
    expect(await estado(propiaVigente)).toBe("vigente");
    expect(await estado(deOtro), "la pila de otro usuario no se toca").toBe(
      "deshecha",
    );
    expect(await estado(otroPeriodo), "otro periodo").toBe("deshecha");
    expect(await estado(otroCliente), "otro cliente").toBe("deshecha");
  });
});

// =================================================================================================
describe("agregarCompra y descartar (D-7, DU-16, CA-8)", () => {
  it("crea la compra agregada con su version 1, sin propuesta y sin operacion; evalua y guarda los hallazgos de la version 1", async () => {
    const c = await ec.cliente(X);
    const e = evaluadorFalso();
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    const r = await comoBackend((tx) =>
      agregarCompra(
        tx,
        {
          clienteId: c.id,
          periodo: PERIODO,
          usuarioId: ux,
          identidad: identidad("F777", "5"),
          montos: MONTOS_DG,
        },
        { evaluar: e.evaluar },
      ),
    );
    expect(r.version).toMatchObject({
      n: 1,
      accion: "agregada",
      usuarioId: ux,
      operacionId: null,
    });
    const fila = (
      await admin.query(
        "select origen, propuesta_id, version_vigente, descartada_en, clave, serie, numero from compra where id = $1",
        [r.id],
      )
    ).rows[0];
    expect(fila).toMatchObject({
      origen: "agregada",
      propuesta_id: null,
      version_vigente: 1,
      descartada_en: null,
      serie: "F777",
      numero: "5",
    });
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
      "agregar no entra en deshacer (DU-14)",
    ).toBe(ops);
    expect(e.llamadas).toHaveLength(1);
    expect((await hallazgosDe(r.id)).map((h) => h.version_n)).toEqual([1]);
  });

  it("repetir una clave viva da duplicado con el id de la existente: de una fila sire, de una excluida y de otra agregada (HU-18)", async () => {
    const c = await ec.cliente(X);
    const sire = await ec.compra(X, c, {
      serie: "F100",
      numero: "1",
      propuestaId: propX,
    });
    const excluida = await ec.compra(X, c, {
      serie: "F100",
      numero: "2",
      propuestaId: propX,
    });
    await ec.version(X, excluida.id, 2, {
      excluida: true,
      motivo: "x",
      accion: "excluir",
    });
    const agregada = await ec.compra(X, c, {
      serie: "F100",
      numero: "3",
      origen: "agregada",
    });
    for (const [numero, existente] of [
      ["1", sire],
      ["2", excluida],
      ["3", agregada],
    ] as const) {
      const err = await errorDe(
        comoBackend((tx) =>
          agregarCompra(
            tx,
            {
              clienteId: c.id,
              periodo: PERIODO,
              usuarioId: ux,
              identidad: identidad("F100", numero),
              montos: MONTOS_DG,
            },
            sinHallazgos(),
          ),
        ),
      );
      expect(err, numero).toMatchObject({
        codigo: "duplicado",
        ids: [existente.id],
      });
    }
    expect(await contarFilas(admin, "compra", "cliente_id = $1", [c.id])).toBe(
      3,
    );
  });

  it("la misma clave en otro periodo o en otro cliente no es duplicado", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, { serie: "F200", numero: "1", propuestaId: propX });
    const alta = (clienteId: string, periodo: string) =>
      comoBackend((tx) =>
        agregarCompra(
          tx,
          {
            clienteId,
            periodo,
            usuarioId: ux,
            identidad: identidad("F200", "1"),
            montos: MONTOS_DG,
          },
          sinHallazgos(),
        ),
      );
    expect((await alta(c.id, "202609")).version.n).toBe(1);
    expect((await alta(cx.id, PERIODO)).version.n).toBe(1);
  });

  it("descartar una agregada la quita sin version ni operacion, libera la clave y permite agregarla de nuevo (CA-8)", async () => {
    const c = await ec.cliente(X);
    const a = await comoBackend((tx) =>
      agregarCompra(
        tx,
        {
          clienteId: c.id,
          periodo: PERIODO,
          usuarioId: ux,
          identidad: identidad("F300", "9"),
          montos: MONTOS_DG,
        },
        sinHallazgos(),
      ),
    );
    const ops = await contarFilas(admin, "compra_operacion", "tenant_id = $1", [
      X,
    ]);
    await comoBackend((tx) =>
      descartar(tx, { compraId: a.id, versionBase: 1, usuarioId: ux }),
    );
    expect(
      (
        await admin.query(
          "select descartada_en is not null as d from compra where id = $1",
          [a.id],
        )
      ).rows[0].d,
    ).toBe(true);
    expect(await versionesDe(a.id)).toHaveLength(1);
    expect(
      await contarFilas(admin, "compra_operacion", "tenant_id = $1", [X]),
    ).toBe(ops);
    const otra = await comoBackend((tx) =>
      agregarCompra(
        tx,
        {
          clienteId: c.id,
          periodo: PERIODO,
          usuarioId: ux,
          identidad: identidad("F300", "9"),
          montos: MONTOS_DG,
        },
        sinHallazgos(),
      ),
    );
    expect(otra.id).not.toBe(a.id);
  });

  it("las filas del SIRE no se descartan (no_descartable: se excluyen); descartar con versionBase obsoleta o un id ajeno no escribe", async () => {
    const sire = await ec.compra(X, cx, { propuestaId: propX });
    expect(
      await codigoDe(
        comoBackend((tx) =>
          descartar(tx, { compraId: sire.id, versionBase: 1, usuarioId: ux }),
        ),
      ),
    ).toBe("no_descartable");
    const a = await ec.compra(X, cx, { origen: "agregada" });
    await ec.version(X, a.id, 2);
    expect(
      await codigoDe(
        comoBackend((tx) =>
          descartar(tx, { compraId: a.id, versionBase: 1, usuarioId: ux }),
        ),
      ),
    ).toBe("version_obsoleta");
    const ajena = await ec.compra(Y, cy, { origen: "agregada" });
    expect(
      await codigoDe(
        comoBackend((tx) =>
          descartar(tx, { compraId: ajena.id, versionBase: 1, usuarioId: ux }),
        ),
      ),
    ).toBe("no_encontrada");
    expect(
      await contarFilas(
        admin,
        "compra",
        "id = any($1::uuid[]) and descartada_en is not null",
        [[sire.id, a.id, ajena.id]],
      ),
    ).toBe(0);
  });

  it("dos altas simultaneas de la misma clave dejan una sola compra y la otra recibe duplicado (o 23505), nunca 40P01", async () => {
    const c = await ec.cliente(X);
    for (let ronda = 0; ronda < 15; ronda++) {
      const llegar = barrera(2);
      const alta = () =>
        comoBackend(async (tx) => {
          await llegar();
          return agregarCompra(
            tx,
            {
              clienteId: c.id,
              periodo: PERIODO,
              usuarioId: ux,
              identidad: identidad("F400", String(ronda)),
              montos: MONTOS_DG,
            },
            sinHallazgos(),
          );
        });
      const r = await Promise.allSettled([alta(), alta()]);
      expect(
        r.filter((x) => x.status === "fulfilled"),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      const mal = r.find(
        (x): x is PromiseRejectedResult => x.status === "rejected",
      )!;
      expect(["duplicado", "23505"], `ronda ${ronda}`).toContain(
        (mal.reason as { codigo?: string }).codigo,
      );
    }
  });
});

// =================================================================================================
describe("insertarCompras · lo que persiste la descarga (D-3, CA-1)", () => {
  const nueva = (
    serie: string,
    numero: string,
    m: Partial<Montos> = {},
    o: Partial<IdentidadCompra> = {},
  ) => ({
    ...identidad(serie, numero, o),
    montos: montos({ biDg: "1000.00", igvDg: "180.00", ...m }),
  });

  it("inserta cada compra como sire con su propuesta y su version 1 identica (cadenas exactas) y devuelve los ids en orden", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 3,
    });
    const filas = [
      nueva(
        "F001",
        "1040",
        { biDg: "770.00", igvDg: "138.60" },
        {
          docNumero: "20100070970",
          clave: claveCompra("01", "F001", "1040", "6", "20100070970"),
        },
      ),
      nueva(
        "F001",
        "2056",
        { biDg: "21.48", igvDg: "1.61", noGravado: "8.97" },
        {
          docNumero: "20100070971",
          clave: claveCompra("01", "F001", "2056", "6", "20100070971"),
        },
      ),
      nueva(
        "F001",
        "4062",
        { biDg: "100.00", igvDg: "18.00" },
        {
          moneda: "USD",
          tipoCambio: "3.456",
          docNumero: "20100070972",
          clave: claveCompra("01", "F001", "4062", "6", "20100070972"),
        },
      ),
    ];
    const e = evaluadorFalso();
    const ids = await comoBackend((tx) =>
      insertarCompras(
        tx,
        { clienteId: c.id, periodo: PERIODO, propuestaId },
        filas,
        { evaluar: e.evaluar },
      ),
    );
    expect(ids).toHaveLength(3);
    const compras = (
      await admin.query(
        "select id, origen, propuesta_id, version_vigente, serie, numero, moneda, tipo_cambio, descartada_en, razon_social from compra where cliente_id = $1 order by numero",
        [c.id],
      )
    ).rows;
    expect(compras.map((x) => x.id).sort()).toEqual([...ids].sort());
    expect(
      compras.every(
        (x) =>
          x.origen === "sire" &&
          x.propuesta_id === propuestaId &&
          x.version_vigente === 1 &&
          x.descartada_en === null,
      ),
    ).toBe(true);
    expect(compras.find((x) => x.numero === "4062")).toMatchObject({
      moneda: "USD",
      tipo_cambio: "3.456",
    });
    const porId = (id: string) => versionesDe(id);
    const v1 = (await porId(ids[0]))[0];
    expect(v1).toMatchObject({
      n: 1,
      bi_dg: "770.00",
      igv_dg: "138.60",
      total: "908.60",
      accion: "original",
      operacion_id: null,
      excluida: false,
      clasificada: false,
    });
    expect((await porId(ids[1]))[0]).toMatchObject({
      bi_dg: "21.48",
      igv_dg: "1.61",
      no_gravado: "8.97",
      total: "32.06",
    });
  });

  it("evalua cada compra una vez y guarda sus hallazgos con version_n = 1", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 4,
    });
    const e = evaluadorFalso();
    const ids = await comoBackend((tx) =>
      insertarCompras(
        tx,
        { clienteId: c.id, periodo: PERIODO, propuestaId },
        [
          nueva("F500", "1"),
          nueva("F500", "2"),
          nueva("F500", "3"),
          nueva("F500", "4"),
        ],
        { evaluar: e.evaluar },
      ),
    );
    expect(e.llamadas).toHaveLength(4);
    expect(
      e.llamadas.every(
        (l) =>
          l.version === 1 &&
          l.origen === "sire" &&
          l.propuestaId === propuestaId,
      ),
    ).toBe(true);
    expect(new Set(e.llamadas.map((l) => l.id))).toEqual(new Set(ids));
    const h = (
      await admin.query(
        "select version_n, count(*)::int as n from compra_hallazgo where compra_id = any($1::uuid[]) group by version_n",
        [ids],
      )
    ).rows;
    expect(h).toEqual([{ version_n: 1, n: 4 }]);
  });

  it("todo o nada: una clave repetida en el lote o ya viva da 23505 y no queda ninguna fila ni hallazgo", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 3,
    });
    const e = evaluadorFalso();
    const repetida = await codigoDe(
      comoBackend((tx) =>
        insertarCompras(
          tx,
          { clienteId: c.id, periodo: PERIODO, propuestaId },
          [nueva("F600", "1"), nueva("F600", "2"), nueva("F600", "1")],
          { evaluar: e.evaluar },
        ),
      ),
    );
    expect(repetida).toBe("23505");
    expect(await contarFilas(admin, "compra", "cliente_id = $1", [c.id])).toBe(
      0,
    );
    await ec.compra(X, c, { serie: "F600", numero: "9", propuestaId });
    const viva = await codigoDe(
      comoBackend((tx) =>
        insertarCompras(
          tx,
          { clienteId: c.id, periodo: PERIODO, propuestaId },
          [nueva("F600", "3"), nueva("F600", "9")],
          { evaluar: e.evaluar },
        ),
      ),
    );
    expect(viva).toBe("23505");
    expect(await contarFilas(admin, "compra", "cliente_id = $1", [c.id])).toBe(
      1,
    );
  });

  it("la insercion de una compra con un monto que no cabe en NUMERIC(14,2) falla entera (22003) sin dejar filas", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 2,
    });
    const codigo = await codigoDe(
      comoBackend((tx) =>
        insertarCompras(
          tx,
          { clienteId: c.id, periodo: PERIODO, propuestaId },
          [
            nueva("F700", "1"),
            nueva("F700", "2", {
              biDg: "1000000000000.00",
              total: "1000000000000.00",
            }),
          ],
          sinHallazgos(),
        ),
      ),
    );
    expect(codigo).toBe("22003");
    expect(await contarFilas(admin, "compra", "cliente_id = $1", [c.id])).toBe(
      0,
    );
  });

  it("las inserta por lotes: 1.500 compras en una transaccion con una version 1 cada una (no cabe en un solo INSERT parametrizado)", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 1500,
    });
    const filas = Array.from({ length: 1500 }, (_, i) =>
      nueva("F800", String(i + 1)),
    );
    const ids = await comoBackend((tx) =>
      insertarCompras(
        tx,
        { clienteId: c.id, periodo: PERIODO, propuestaId },
        filas,
        sinHallazgos(),
      ),
    );
    expect(new Set(ids).size).toBe(1500);
    expect(await contarFilas(admin, "compra", "cliente_id = $1", [c.id])).toBe(
      1500,
    );
    expect(
      await contarFilas(
        admin,
        "compra_version",
        "compra_id = any($1::uuid[]) and n = 1",
        [ids],
      ),
    ).toBe(1500);
  }, 60_000);

  it("el worker (el que persiste la descarga) tambien puede insertar; el estudio ajeno no ve lo insertado", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 1,
    });
    const ids = await worker.withTenant({ tenantId: X }, (tx) =>
      insertarCompras(
        tx,
        { clienteId: c.id, periodo: PERIODO, propuestaId },
        [nueva("F900", "1")],
        sinHallazgos(),
      ),
    );
    expect(ids).toHaveLength(1);
    const ajeno = await backend.withTenant({ tenantId: Y }, (tx) =>
      tx.query("select 1 from compra where id = $1", [ids[0]]),
    );
    expect(ajeno.rowCount).toBe(0);
  });
});
