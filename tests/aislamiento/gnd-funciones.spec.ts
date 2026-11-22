// Spec 027 (T3, rojo): las siete funciones acotadas de `public` de la migracion 0070 en BD real (R-6, R-7, R-11 a R-14, D-2 a D-4;
// CA-7 a CA-10, CA-14, CA-16). Catalogo (SECURITY DEFINER de contapp_migrator, search_path fijo, EXECUTE solo al rol del plan), quien llama
// (42501), ids ajenos (P0002) y cliente archivado (55000), agregar (CA420, CA421, 22023), cambiar el estado de una propia (CA409, CA421,
// «sin cambios»), desactivar una global, umbral y categorias del cliente (CAS por version), aprender (CA422, CA423, 22023 a todo, omitidas,
// limite) y `gnd_ciiu_guardar` del worker; auditoria con `datos` exactos y sin glosas (canarios). Contrato en `gnd-soporte.ts`.
// Hasta T10 fallan por funcion o tabla inexistente. Modelo: `prorrata-funciones.spec.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { unaFila } from "./auditoria-soporte";
import { crearDb, type ContappDb } from "./soporte";
import {
  CANARIO,
  CATEGORIAS,
  codigoDe,
  comoRolSql,
  conExecute,
  EJECUTA,
  EscenarioGnd,
  FIRMAS,
  idNuevo,
  infoFuncion,
  LIMITE_PROPIAS,
  llamar,
  llamarOk,
  ROLES_FUNCION,
  SQL,
  type ClientePrueba,
  type Llamada,
} from "./gnd-soporte";

let admin: Pool;
let eg: EscenarioGnd;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let ux: string; // contador activo de X
let uD: string; // miembro desactivado de X
let uy: string; // contador activo de Y
let cx: ClientePrueba;
let cy: ClientePrueba;

const comoX = () => ({ tenantId: X, userId: ux });
const cod = (r: Llamada) => codigoDe(r);

beforeAll(async () => {
  admin = abrirAdmin(8);
  eg = new EscenarioGnd(admin);
  X = (await eg.estudio()).id;
  Y = (await eg.estudio()).id;
  ux = await eg.usuarioDe(X);
  uD = (await eg.miembro(X, "contador", { desactivada: true })).id;
  uy = await eg.usuarioDe(Y);
  cx = await eg.cliente(X);
  cy = await eg.cliente(Y);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await eg?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), eg?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

// ---- Ayudas --------------------------------------------------------------------------------------------------------------------
/** Estudio nuevo con su usuario (para las pruebas que llenan el diccionario o fijan el umbral sin pisar a otras). */
async function estudioNuevo() {
  const e = await eg.estudio();
  const u = await eg.usuarioDe(e.id);
  const c = await eg.cliente(e.id);
  return { id: e.id, u, c, ctx: { tenantId: e.id, userId: u } };
}
const agregar = (
  palabra: string,
  categoria = "juguetes",
  excepciones: string[] = [],
  ctx: { tenantId: string; userId?: string } = comoX(),
) => llamar(backend, ctx, SQL.agregar, [palabra, categoria, excepciones]);
const estado = (
  id: string,
  activa: boolean,
  version: number,
  ctx: { tenantId: string; userId?: string } = comoX(),
) => llamar(backend, ctx, SQL.estado, [id, activa, version]);
const globalEstado = (
  id: string,
  activa: boolean,
  ctx: { tenantId: string; userId?: string } = comoX(),
) => llamar(backend, ctx, SQL.globalEstado, [id, activa]);
const umbral = (
  n: number | null,
  version: number | null,
  ctx: { tenantId: string; userId?: string } = comoX(),
) => llamar(backend, ctx, SQL.umbral, [n, version]);
const categorias = (
  c: ClientePrueba | string,
  permitidas: string[],
  quitadas: string[],
  version: number,
  ctx: { tenantId: string; userId?: string } = comoX(),
) =>
  llamar(backend, ctx, SQL.categorias, [
    typeof c === "string" ? c : c.id,
    permitidas,
    quitadas,
    version,
  ]);
const aprender = (
  c: ClientePrueba | string,
  compra: string,
  terminos: unknown,
  ctx: { tenantId: string; userId?: string } = comoX(),
) =>
  llamar(backend, ctx, SQL.aprender, [
    typeof c === "string" ? c : c.id,
    compra,
    JSON.stringify(terminos),
  ]);
const ciiu = (entradas: unknown, tenantId = X) =>
  llamar(worker, { tenantId }, SQL.ciiu, [JSON.stringify(entradas)]);
const termino = (t: string, categoria = "entretenimiento") => ({
  termino: t,
  categoria,
});

function filas(r: Llamada): any[] {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.rows;
}

// =================================================================================================
describe("0070 · las siete funciones en el catalogo (CA-7)", () => {
  for (const k of Object.keys(FIRMAS) as (keyof typeof FIRMAS)[]) {
    it(`${FIRMAS[k]}: SECURITY DEFINER de contapp_migrator, search_path fijo, sin PUBLIC; solo ${EJECUTA[k]} la ejecuta`, async () => {
      const i = await infoFuncion(admin, FIRMAS[k]).catch(() => {
        throw new Error(`falta la funcion ${FIRMAS[k]} (migracion 0070)`);
      });
      expect(i).toEqual({
        secdef: true,
        config: ["search_path=pg_catalog, pg_temp"],
        dueno: "contapp_migrator",
        duenoSuper: false,
        duenoBypass: false,
      });
      expect(await conExecute(admin, FIRMAS[k], ROLES_FUNCION)).toEqual([
        EJECUTA[k],
      ]);
    });
  }

  it("ninguna usa EXCEPTION ni SAVEPOINT (el worker corre en su transaccion; plan: Funciones nuevas)", async () => {
    const r = await admin.query(
      `select p.proname, p.prosrc from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])`,
      [Object.values(FIRMAS).map((f) => f.replace(/\(.*$/, ""))],
    );
    expect(r.rows, "faltan funciones (migracion 0070)").toHaveLength(7);
    for (const f of r.rows) {
      expect(
        /\bEXCEPTION\s+WHEN\b/i.test(f.prosrc),
        `${f.proname}: EXCEPTION WHEN`,
      ).toBe(false);
      expect(/\bSAVEPOINT\b/i.test(f.prosrc), `${f.proname}: SAVEPOINT`).toBe(
        false,
      );
    }
  });
});

// =================================================================================================
describe("0070 · quien llama: estudio, usuario y membresia activa (42501)", () => {
  let pS: string; // palabra propia de X
  let gS: string; // global
  let compraS: string;

  beforeAll(async () => {
    pS = (await eg.palabraEstudio(X)).id;
    gS = (await eg.palabraGlobal()).id;
    compraS = (await eg.compraExcluida(X, cx)).id;
  });

  /** Llamada valida de cada funcion, con la que se prueban los rechazos de quien llama. */
  const llamadaDe = (k: keyof typeof FIRMAS): [string, unknown[]] => {
    switch (k) {
      case "agregar":
        return [SQL.agregar, [eg.palabraNueva(), "juguetes", []]];
      case "estado":
        return [SQL.estado, [pS, false, 1]];
      case "globalEstado":
        return [SQL.globalEstado, [gS, false]];
      case "umbral":
        return [SQL.umbral, [4, 0]];
      case "categorias":
        return [SQL.categorias, [cx.id, ["juguetes"], [], 0]];
      case "aprender":
        return [
          SQL.aprender,
          [cx.id, compraS, JSON.stringify([termino("audifonos")])],
        ];
      case "ciiu":
        return [
          SQL.ciiu,
          [JSON.stringify([{ ruc: "20100070970", ciiu: null }])],
        ];
    }
  };

  for (const k of Object.keys(FIRMAS) as (keyof typeof FIRMAS)[]) {
    const rol = EJECUTA[k];
    const otroRol =
      rol === "contapp_backend" ? "contapp_worker" : "contapp_backend";
    it(`${k}: sin estudio en la sesion, el rol equivocado y contapp_app dan 42501`, async () => {
      const [sql, valores] = llamadaDe(k);
      const sinEstudio = await comoRolSql(
        admin,
        rol,
        { tenantId: null, userId: ux },
        sql,
        valores,
      );
      expect(sinEstudio.ok ? "ok" : sinEstudio.code, "sin estudio").toBe(
        "42501",
      );
      for (const r of [otroRol, "contapp_app"]) {
        const x = await comoRolSql(
          admin,
          r,
          { tenantId: X, userId: ux },
          sql,
          valores,
        );
        expect(x.ok ? "ok" : x.code, `rol ${r}`).toBe("42501");
      }
    });

    if (rol === "contapp_backend") {
      it(`${k}: sin usuario, miembro desactivado y usuario de otro estudio dan 42501 y no escriben nada`, async () => {
        const [sql, valores] = llamadaDe(k);
        const antes = await eg.totales(X);
        expect(
          cod(await llamar(backend, { tenantId: X }, sql, valores)),
          "sin usuario",
        ).toBe("42501");
        expect(
          cod(await llamar(backend, { tenantId: X, userId: uD }, sql, valores)),
          "miembro desactivado",
        ).toBe("42501");
        expect(
          cod(await llamar(backend, { tenantId: X, userId: uy }, sql, valores)),
          "usuario de otro estudio",
        ).toBe("42501");
        expect(await eg.totales(X)).toEqual(antes);
      });
    }
  }
});

// =================================================================================================
describe("0070 · ids de otro estudio o inexistentes (P0002) y cliente archivado (55000)", () => {
  it("gnd_palabra_estado: una palabra de otro estudio y una inexistente dan P0002 y no cambian nada", async () => {
    const deY = await eg.palabraEstudio(Y);
    expect(cod(await estado(deY.id, false, 1)), "palabra de Y desde X").toBe(
      "P0002",
    );
    expect(cod(await estado(idNuevo(), false, 1)), "inexistente").toBe("P0002");
    expect((await eg.propia(Y, deY.palabra))!.activa).toBe(true);
  });

  it("gnd_global_estado: una global inexistente y una global inactiva dan P0002 (nada en gnd_global_desactivada)", async () => {
    const inactiva = await eg.palabraGlobal({ activa: false });
    expect(cod(await globalEstado(idNuevo(), false)), "inexistente").toBe(
      "P0002",
    );
    expect(cod(await globalEstado(inactiva.id, false)), "inactiva").toBe(
      "P0002",
    );
    expect(await eg.desactivadas(X)).not.toContain(inactiva.id);
  });

  it("gnd_cliente_categorias_fijar: un cliente de otro estudio y uno inexistente dan P0002; uno archivado da 55000 y no escribe nada", async () => {
    expect(
      cod(await categorias(cy, ["juguetes"], [], 0)),
      "de otro estudio",
    ).toBe("P0002");
    expect(
      cod(await categorias(idNuevo(), ["juguetes"], [], 0)),
      "inexistente",
    ).toBe("P0002");
    const arch = await eg.cliente(X);
    await eg.archivar(arch.id);
    expect(cod(await categorias(arch, ["juguetes"], [], 0)), "archivado").toBe(
      "55000",
    );
    expect(await eg.categoriasDe(arch.id)).toBeUndefined();
    expect(await eg.categoriasDe(cy.id)).toBeUndefined();
  });

  it("gnd_aprender: cliente ajeno o inexistente, compra de otro estudio, de otro cliente o inexistente dan P0002; cliente archivado da 55000; no guardan nada", async () => {
    const mia = await eg.compraExcluida(X, cx);
    const deY = await eg.compraExcluida(Y, cy);
    const otro = await eg.cliente(X);
    const deOtro = await eg.compraExcluida(X, otro);
    const t = [termino("audifonos")];
    const antes = await eg.totalesGnd(X);
    expect(cod(await aprender(cy, deY.id, t)), "cliente de otro estudio").toBe(
      "P0002",
    );
    expect(
      cod(await aprender(idNuevo(), mia.id, t)),
      "cliente inexistente",
    ).toBe("P0002");
    expect(cod(await aprender(cx, deY.id, t)), "compra de otro estudio").toBe(
      "P0002",
    );
    expect(
      cod(await aprender(cx, deOtro.id, t)),
      "compra de otro cliente",
    ).toBe("P0002");
    expect(cod(await aprender(cx, idNuevo(), t)), "compra inexistente").toBe(
      "P0002",
    );
    const arch = await eg.cliente(X);
    const deArch = await eg.compraExcluida(X, arch);
    await eg.archivar(arch.id);
    expect(cod(await aprender(arch, deArch.id, t)), "archivado").toBe("55000");
    expect(await eg.totalesGnd(X)).toEqual(antes);
  });
});

// =================================================================================================
describe("gnd_palabra_agregar (R-4, R-6, D-4, CA-7, CA-14)", () => {
  it("inserta una propia manual activa version 1 con el usuario, devuelve su id y audita con datos exactos", async () => {
    const palabra = eg.palabraNueva();
    const { filas: aud, resultado } = await eg.capturar(
      X,
      "gnd.palabra_agregada",
      () =>
        llamarOk(backend, comoX(), SQL.agregar, [
          palabra,
          "entretenimiento",
          ["seguridad", "punta de acero"],
        ]),
    );
    const id = resultado[0].id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const f = (await eg.propia(X, palabra))!;
    expect(f).toMatchObject({
      id,
      tenant_id: X,
      categoria: "entretenimiento",
      excepciones: ["seguridad", "punta de acero"],
      origen: "manual",
      activa: true,
      version: 1,
      creado_por: ux,
      compra_origen_id: null,
    });
    unaFila(aud, "gnd.palabra_agregada", {
      actorTipo: "usuario",
      usuarioId: ux,
      clienteId: null,
      entidad: "gnd_palabra_estudio",
      entidadId: id,
      datos: { palabra, categoria: "entretenimiento", origen: "manual" },
    });
  });

  it("las 6 categorias valen; con excepciones vacias o hasta 5 frases de 1 a 3 palabras", async () => {
    for (const c of CATEGORIAS)
      expect(cod(await agregar(eg.palabraNueva(), c)), c).toBe("ok");
    expect(
      cod(
        await agregar(eg.palabraNueva(), "juguetes", [
          "seguridad",
          "punta de acero",
          "a tierra",
          "jebe",
          "x1 y2 z3",
        ]),
      ),
    ).toBe("ok");
  });

  it("una propia con la misma palabra que una global es valida (la reemplaza): «zapatilla» sin tocar la global", async () => {
    const e = await estudioNuevo();
    const antes = await eg.globalPorPalabra("zapatilla");
    const r = await agregar("zapatilla", "calzado-ropa", [], e.ctx);
    expect(cod(r)).toBe("ok");
    expect((await eg.propia(e.id, "zapatilla"))!.excepciones).toEqual([]);
    expect(await eg.globalPorPalabra("zapatilla")).toEqual(antes);
  });

  it("CA420: repetir una propia (activa o desactivada) da CA420 y no escribe; otro estudio puede tener la misma palabra", async () => {
    const e = await estudioNuevo();
    const otro = await estudioNuevo();
    const p = eg.palabraNueva();
    expect(cod(await agregar(p, "juguetes", [], e.ctx))).toBe("ok");
    const antes = await eg.totalesGnd(e.id);
    const aud = await eg.cuantas(e.id);
    expect(cod(await agregar(p, "juguetes", [], e.ctx)), "activa").toBe(
      "CA420",
    );
    await eg.admin.query(
      "update gnd_palabra_estudio set activa = false where tenant_id = $1",
      [e.id],
    );
    expect(
      cod(await agregar(p, "cuidado-personal", [], e.ctx)),
      "desactivada",
    ).toBe("CA420");
    expect(await eg.totalesGnd(e.id)).toEqual(antes);
    expect(await eg.cuantas(e.id)).toBe(aud);
    expect(
      cod(await agregar(p, "juguetes", [], otro.ctx)),
      "otro estudio",
    ).toBe("ok");
  });

  it("entradas invalidas dan 22023 y no escriben: palabra no normalizada, categoria fuera de las 6, excepciones mal formadas, nulos", async () => {
    const e = await estudioNuevo();
    const antes = await eg.totalesGnd(e.id);
    const malas: [string, unknown[], string][] = [
      ["ab", ["ab", "juguetes", []], "2 caracteres"],
      ["x".repeat(41), ["x".repeat(41), "juguetes", []], "41 caracteres"],
      ["Mayuscula", ["Mayuscula", "juguetes", []], "mayuscula"],
      ["con espacio", ["con espacio", "juguetes", []], "espacio"],
      ["tilde", ["cámara", "juguetes", []], "tilde"],
      ["nula", [null, "juguetes", []], "palabra nula"],
      ["categoria", ["abcde", "otra", []], "categoria fuera de las 6"],
      ["categoria nula", ["abcde", null, []], "categoria nula"],
      [
        "6 frases",
        ["abcde", "juguetes", ["a", "b", "c", "d", "e", "f"]],
        "6 excepciones",
      ],
      [
        "4 palabras",
        ["abcde", "juguetes", ["uno dos tres cuatro"]],
        "frase de 4 palabras",
      ],
      [
        "mayuscula exc",
        ["abcde", "juguetes", ["Seguridad"]],
        "frase con mayuscula",
      ],
      ["vacia exc", ["abcde", "juguetes", [""]], "frase vacia"],
      ["nula exc", ["abcde", "juguetes", null], "excepciones nulas"],
    ];
    for (const [, valores, nombre] of malas)
      expect(
        cod(await llamar(backend, e.ctx, SQL.agregar, valores)),
        nombre,
      ).toBe("22023");
    expect(await eg.totalesGnd(e.id)).toEqual(antes);
  });

  it("el mensaje de un rechazo no repite lo recibido (sin glosas ni canarios)", async () => {
    const r = await agregar(`${CANARIO.glosa}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("22023");
      expect(r.message).not.toContain(CANARIO.glosa);
    }
  });

  it("CA421: con 2.000 activas la siguiente da CA421; desactivar una deja agregar; las desactivadas no cuentan", async () => {
    const e = await estudioNuevo();
    await eg.llenarPalabras(e.id, LIMITE_PROPIAS - 1);
    await eg.llenarPalabras(e.id, 5, { activa: false, prefijo: "inact" });
    expect(
      cod(await agregar(eg.palabraNueva(), "juguetes", [], e.ctx)),
      "la 2000",
    ).toBe("ok");
    expect(await eg.activas(e.id)).toBe(LIMITE_PROPIAS);
    const antes = await eg.totalesGnd(e.id);
    expect(
      cod(await agregar(eg.palabraNueva(), "juguetes", [], e.ctx)),
      "la 2001",
    ).toBe("CA421");
    expect(await eg.totalesGnd(e.id)).toEqual(antes);
    const una = (await eg.propias(e.id)).find((p) => p.activa)!;
    expect(cod(await estado(una.id, false, 1, e.ctx))).toBe("ok");
    expect(
      cod(await agregar(eg.palabraNueva(), "juguetes", [], e.ctx)),
      "tras desactivar",
    ).toBe("ok");
  }, 60_000);
});

// =================================================================================================
describe("gnd_palabra_estado (R-6, CA409, CA421, CA-14)", () => {
  it("desactivar y reactivar: devuelve version + 1, deja activa y version, actualiza el reloj y audita con datos exactos", async () => {
    const p = await eg.palabraEstudio(X, {
      categoria: "cuidado-personal",
      version: 1,
    });
    const des = await eg.capturar(X, "gnd.palabra_desactivada", () =>
      llamarOk(backend, comoX(), SQL.estado, [p.id, false, 1]),
    );
    expect(des.resultado[0].version).toBe(2);
    const f2 = (await eg.propia(X, p.palabra))!;
    expect([f2.activa, f2.version]).toEqual([false, 2]);
    expect(f2.actualizada_en.getTime()).toBeGreaterThanOrEqual(
      p.actualizada_en.getTime(),
    );
    unaFila(des.filas, "gnd.palabra_desactivada", {
      actorTipo: "usuario",
      usuarioId: ux,
      clienteId: null,
      entidad: "gnd_palabra_estudio",
      entidadId: p.id,
      datos: {
        palabra: p.palabra,
        categoria: "cuidado-personal",
        origen: "manual",
      },
    });
    const rea = await eg.capturar(X, "gnd.palabra_reactivada", () =>
      llamarOk(backend, comoX(), SQL.estado, [p.id, true, 2]),
    );
    expect(rea.resultado[0].version).toBe(3);
    const f3 = (await eg.propia(X, p.palabra))!;
    expect([f3.activa, f3.version]).toEqual([true, 3]);
    unaFila(rea.filas, "gnd.palabra_reactivada", {
      actorTipo: "usuario",
      usuarioId: ux,
      clienteId: null,
      entidad: "gnd_palabra_estudio",
      entidadId: p.id,
      datos: {
        palabra: p.palabra,
        categoria: "cuidado-personal",
        origen: "manual",
      },
    });
  });

  it("CA409: una version que no es la vigente no cambia nada ni audita; las demas filas no se tocan", async () => {
    const p = await eg.palabraEstudio(X);
    const otra = await eg.palabraEstudio(X);
    const antes = await eg.cuantas(X);
    expect(cod(await estado(p.id, false, 7)), "version futura").toBe("CA409");
    expect(cod(await estado(p.id, false, 0)), "version 0").toBe("CA409");
    expect((await eg.propia(X, p.palabra))!.activa).toBe(true);
    expect(await eg.cuantas(X)).toBe(antes);
    expect((await eg.propia(X, otra.palabra))!.version).toBe(1);
  });

  it("«sin cambios»: pedir el estado que ya tiene da 22023 y no escribe ni audita", async () => {
    const act = await eg.palabraEstudio(X);
    const ina = await eg.palabraEstudio(X, { activa: false });
    const antes = await eg.cuantas(X);
    expect(cod(await estado(act.id, true, 1)), "ya activa").toBe("22023");
    expect(cod(await estado(ina.id, false, 1)), "ya desactivada").toBe("22023");
    expect(await eg.cuantas(X)).toBe(antes);
    expect((await eg.propia(X, act.palabra))!.version).toBe(1);
  });

  it("entradas invalidas dan 22023: activa nula, version nula o negativa", async () => {
    const p = await eg.palabraEstudio(X);
    for (const [a, v, n] of [
      [null, 1, "activa nula"],
      [false, null, "version nula"],
      [false, -1, "version negativa"],
    ] as const)
      expect(
        cod(await llamar(backend, comoX(), SQL.estado, [p.id, a, v])),
        n,
      ).toBe("22023");
  });

  it("CA421: reactivar en el limite: con 1.999 activas reactiva la 2000; con 2.000 otra reactivacion da CA421 y no cambia nada", async () => {
    const e = await estudioNuevo();
    await eg.llenarPalabras(e.id, LIMITE_PROPIAS - 1);
    const a = await eg.palabraEstudio(e.id, { activa: false });
    const b = await eg.palabraEstudio(e.id, { activa: false });
    expect(await eg.activas(e.id)).toBe(LIMITE_PROPIAS - 1);
    expect(cod(await estado(a.id, true, 1, e.ctx)), "la 2000").toBe("ok");
    expect(await eg.activas(e.id)).toBe(LIMITE_PROPIAS);
    const aud = await eg.cuantas(e.id);
    expect(cod(await estado(b.id, true, 1, e.ctx)), "la 2001").toBe("CA421");
    expect((await eg.propia(e.id, b.palabra))!.activa).toBe(false);
    expect((await eg.propia(e.id, b.palabra))!.version).toBe(1);
    expect(await eg.cuantas(e.id)).toBe(aud);
    // desactivar nunca da CA421
    expect(cod(await estado(a.id, false, 2, e.ctx))).toBe("ok");
  }, 60_000);
});

// =================================================================================================
describe("gnd_global_estado (R-6, D-2, CA-7, CA-14)", () => {
  it("desactivar para el estudio inserta la fila con el usuario y audita; reactivar la borra y audita; los demas estudios no cambian", async () => {
    const e = await estudioNuevo();
    const g = await eg.palabraGlobal({ categoria: "cuidado-personal" });
    await eg.desactivadaGlobal(Y, g.id);
    const des = await eg.capturar(e.id, "gnd.global_desactivada", () =>
      llamarOk(backend, e.ctx, SQL.globalEstado, [g.id, false]),
    );
    expect(await eg.desactivadas(e.id)).toEqual([g.id]);
    const fila = (
      await admin.query(
        "select usuario_id from gnd_global_desactivada where tenant_id = $1",
        [e.id],
      )
    ).rows[0];
    expect(fila.usuario_id).toBe(e.u);
    unaFila(des.filas, "gnd.global_desactivada", {
      actorTipo: "usuario",
      usuarioId: e.u,
      clienteId: null,
      entidad: "gnd_palabra_global",
      entidadId: g.id,
      datos: { palabra: g.palabra, categoria: "cuidado-personal" },
    });
    expect(await eg.desactivadas(Y)).toEqual([g.id]);
    const rea = await eg.capturar(e.id, "gnd.global_reactivada", () =>
      llamarOk(backend, e.ctx, SQL.globalEstado, [g.id, true]),
    );
    expect(await eg.desactivadas(e.id)).toEqual([]);
    unaFila(rea.filas, "gnd.global_reactivada", {
      actorTipo: "usuario",
      usuarioId: e.u,
      clienteId: null,
      entidad: "gnd_palabra_global",
      entidadId: g.id,
      datos: { palabra: g.palabra, categoria: "cuidado-personal" },
    });
    expect(await eg.desactivadas(Y)).toEqual([g.id]);
    // la global misma no cambia
    expect(await eg.global(g.id)).toMatchObject({ activa: true, version: 1 });
  });

  it("«sin cambios»: desactivar una ya desactivada y reactivar una que no lo esta dan 22023, sin escribir ni auditar", async () => {
    const e = await estudioNuevo();
    const g = await eg.palabraGlobal();
    const antes = await eg.cuantas(e.id);
    expect(
      cod(await globalEstado(g.id, true, e.ctx)),
      "reactivar sin desactivar",
    ).toBe("22023");
    expect(cod(await globalEstado(g.id, false, e.ctx))).toBe("ok");
    const aud = await eg.cuantas(e.id);
    expect(aud).toBe(antes + 1);
    expect(cod(await globalEstado(g.id, false, e.ctx)), "ya desactivada").toBe(
      "22023",
    );
    expect(await eg.cuantas(e.id)).toBe(aud);
    expect(await eg.desactivadas(e.id)).toEqual([g.id]);
  });

  it("una global de la semilla se puede desactivar y reactivar para el estudio (polo)", async () => {
    const e = await estudioNuevo();
    const polo = (await eg.globalPorPalabra("polo"))!;
    expect(cod(await globalEstado(polo.id, false, e.ctx))).toBe("ok");
    expect(await eg.desactivadas(e.id)).toEqual([polo.id]);
    expect(cod(await globalEstado(polo.id, true, e.ctx))).toBe("ok");
    expect(await eg.desactivadas(e.id)).toEqual([]);
  });

  it("entradas invalidas dan 22023: activa nula", async () => {
    const g = await eg.palabraGlobal();
    expect(
      cod(await llamar(backend, comoX(), SQL.globalEstado, [g.id, null])),
    ).toBe("22023");
  });
});

// =================================================================================================
describe("gnd_umbral_fijar (R-11, CA-10, CA-14)", () => {
  it("sin fila la version vigente es 0: fija 5 con version 0 (devuelve 1) y audita antes = 3; luego 9 con version 1 (devuelve 2) y audita antes = 5", async () => {
    const e = await estudioNuevo();
    const a = await eg.capturar(e.id, "gnd.umbral_cambiado", () =>
      llamarOk(backend, e.ctx, SQL.umbral, [5, 0]),
    );
    expect(a.resultado[0].version).toBe(1);
    expect(await eg.configDe(e.id)).toEqual({ umbral: 5, version: 1 });
    unaFila(a.filas, "gnd.umbral_cambiado", {
      actorTipo: "usuario",
      usuarioId: e.u,
      clienteId: null,
      entidad: "gnd_config",
      datos: { antes: 3, despues: 5 },
    });
    const b = await eg.capturar(e.id, "gnd.umbral_cambiado", () =>
      llamarOk(backend, e.ctx, SQL.umbral, [9, 1]),
    );
    expect(b.resultado[0].version).toBe(2);
    expect(await eg.configDe(e.id)).toEqual({ umbral: 9, version: 2 });
    unaFila(b.filas, "gnd.umbral_cambiado", {
      actorTipo: "usuario",
      usuarioId: e.u,
      clienteId: null,
      entidad: "gnd_config",
      datos: { antes: 5, despues: 9 },
    });
  });

  it("los bordes 1 y 20 valen; 0, 21, negativos y nulo dan 22023 sin escribir (CA-10)", async () => {
    const e = await estudioNuevo();
    expect(cod(await umbral(1, 0, e.ctx))).toBe("ok");
    expect(cod(await umbral(20, 1, e.ctx))).toBe("ok");
    const antes = await eg.configDe(e.id);
    const aud = await eg.cuantas(e.id);
    for (const n of [0, 21, -1, 100, null])
      expect(cod(await umbral(n, 2, e.ctx)), String(n)).toBe("22023");
    expect(cod(await umbral(5, null, e.ctx)), "version nula").toBe("22023");
    expect(cod(await umbral(5, -1, e.ctx)), "version negativa").toBe("22023");
    expect(await eg.configDe(e.id)).toEqual(antes);
    expect(await eg.cuantas(e.id)).toBe(aud);
  });

  it("CA409: una version vieja o futura no cambia nada; con fila y con version 0 sin fila", async () => {
    const e = await estudioNuevo();
    expect(cod(await umbral(5, 3, e.ctx)), "sin fila con version 3").toBe(
      "CA409",
    );
    expect(await eg.configDe(e.id)).toBeUndefined();
    expect(cod(await umbral(5, 0, e.ctx))).toBe("ok");
    const aud = await eg.cuantas(e.id);
    expect(cod(await umbral(8, 0, e.ctx)), "version vieja").toBe("CA409");
    expect(cod(await umbral(8, 9, e.ctx)), "version futura").toBe("CA409");
    expect(await eg.configDe(e.id)).toEqual({ umbral: 5, version: 1 });
    expect(await eg.cuantas(e.id)).toBe(aud);
  });

  it("«sin cambios»: fijar el mismo umbral con la version vigente da 22023 y no audita", async () => {
    const e = await estudioNuevo();
    expect(cod(await umbral(6, 0, e.ctx))).toBe("ok");
    const aud = await eg.cuantas(e.id);
    expect(cod(await umbral(6, 1, e.ctx))).toBe("22023");
    expect(await eg.configDe(e.id)).toEqual({ umbral: 6, version: 1 });
    expect(await eg.cuantas(e.id)).toBe(aud);
  });

  it("cada estudio tiene su umbral: fijar el de uno no cambia el del otro (CA-7)", async () => {
    const a = await estudioNuevo();
    const b = await estudioNuevo();
    await eg.config(b.id, 12, 4);
    expect(cod(await umbral(2, 0, a.ctx))).toBe("ok");
    expect(await eg.configDe(b.id)).toEqual({ umbral: 12, version: 4 });
  });
});

// =================================================================================================
describe("gnd_cliente_categorias_fijar (R-13, D-6, CA-14)", () => {
  it("sin fila la version es 0: crea la fila (devuelve 1) y audita con el cliente y las listas antes y despues; luego CAS con version 1", async () => {
    const e = await estudioNuevo();
    const a = await eg.capturar(e.id, "gnd.categorias_cliente", () =>
      llamarOk(backend, e.ctx, SQL.categorias, [
        e.c.id,
        ["juguetes", "utiles-escolares"],
        ["calzado-ropa"],
        0,
      ]),
    );
    expect(a.resultado[0].version).toBe(1);
    expect(await eg.categoriasDe(e.c.id)).toMatchObject({
      tenant_id: e.id,
      permitidas: ["juguetes", "utiles-escolares"],
      quitadas: ["calzado-ropa"],
      version: 1,
    });
    unaFila(a.filas, "gnd.categorias_cliente", {
      actorTipo: "usuario",
      usuarioId: e.u,
      clienteId: e.c.id,
      entidad: "gnd_cliente_categorias",
      datos: {
        clienteId: e.c.id,
        antes: { permitidas: [], quitadas: [] },
        despues: {
          permitidas: ["juguetes", "utiles-escolares"],
          quitadas: ["calzado-ropa"],
        },
      },
    });
    const b = await eg.capturar(e.id, "gnd.categorias_cliente", () =>
      llamarOk(backend, e.ctx, SQL.categorias, [
        e.c.id,
        ["calzado-ropa"],
        [],
        1,
      ]),
    );
    expect(b.resultado[0].version).toBe(2);
    expect(await eg.categoriasDe(e.c.id)).toMatchObject({
      permitidas: ["calzado-ropa"],
      quitadas: [],
      version: 2,
    });
    unaFila(b.filas, "gnd.categorias_cliente", {
      actorTipo: "usuario",
      usuarioId: e.u,
      clienteId: e.c.id,
      entidad: "gnd_cliente_categorias",
      datos: {
        clienteId: e.c.id,
        antes: {
          permitidas: ["juguetes", "utiles-escolares"],
          quitadas: ["calzado-ropa"],
        },
        despues: { permitidas: ["calzado-ropa"], quitadas: [] },
      },
    });
  });

  it("vaciar las dos listas es valido; permitir las 6 tambien", async () => {
    const e = await estudioNuevo();
    expect(cod(await categorias(e.c, [...CATEGORIAS], [], 0, e.ctx))).toBe(
      "ok",
    );
    expect(cod(await categorias(e.c, [], [], 1, e.ctx))).toBe("ok");
    expect(await eg.categoriasDe(e.c.id)).toMatchObject({
      permitidas: [],
      quitadas: [],
      version: 2,
    });
  });

  it("entradas invalidas dan 22023 y no escriben: categoria fuera de las 6, listas que se cruzan, nulos, version negativa", async () => {
    const e = await estudioNuevo();
    const aud = await eg.cuantas(e.id);
    const malas: [string[] | null, string[] | null, number | null, string][] = [
      [["otra"], [], 0, "permitida fuera de las 6"],
      [[], ["Juguetes"], 0, "quitada fuera de las 6"],
      [["juguetes", "calzado-ropa"], ["calzado-ropa"], 0, "no disjuntas"],
      [null, [], 0, "permitidas nulas"],
      [[], null, 0, "quitadas nulas"],
      [["juguetes"], [], null, "version nula"],
      [["juguetes"], [], -1, "version negativa"],
    ];
    for (const [p, q, v, n] of malas)
      expect(
        cod(await llamar(backend, e.ctx, SQL.categorias, [e.c.id, p, q, v])),
        n,
      ).toBe("22023");
    expect(await eg.categoriasDe(e.c.id)).toBeUndefined();
    expect(await eg.cuantas(e.id)).toBe(aud);
  });

  it("CA409 con version vieja o futura (con fila y sin ella) y «sin cambios» da 22023; nada se escribe", async () => {
    const e = await estudioNuevo();
    expect(
      cod(await categorias(e.c, ["juguetes"], [], 2, e.ctx)),
      "sin fila v2",
    ).toBe("CA409");
    expect(cod(await categorias(e.c, ["juguetes"], [], 0, e.ctx))).toBe("ok");
    const aud = await eg.cuantas(e.id);
    expect(
      cod(await categorias(e.c, [], ["juguetes"], 0, e.ctx)),
      "version vieja",
    ).toBe("CA409");
    expect(
      cod(await categorias(e.c, [], ["juguetes"], 5, e.ctx)),
      "version futura",
    ).toBe("CA409");
    expect(
      cod(await categorias(e.c, ["juguetes"], [], 1, e.ctx)),
      "sin cambios",
    ).toBe("22023");
    expect(await eg.categoriasDe(e.c.id)).toMatchObject({
      permitidas: ["juguetes"],
      version: 1,
    });
    expect(await eg.cuantas(e.id)).toBe(aud);
  });

  it("el ajuste es por cliente: fijar el de uno no toca al otro cliente del estudio (CA-7)", async () => {
    const e = await estudioNuevo();
    const otro = await eg.cliente(e.id);
    await eg.categorias(e.id, otro, { permitidas: ["juguetes"], version: 3 });
    expect(cod(await categorias(e.c, ["calzado-ropa"], [], 0, e.ctx))).toBe(
      "ok",
    );
    expect(await eg.categoriasDe(otro.id)).toMatchObject({
      permitidas: ["juguetes"],
      version: 3,
    });
  });
});

// =================================================================================================
describe("gnd_aprender (R-7, HU-42, CA-9, CA-14, CA-11)", () => {
  it("guarda las elegidas como propias «aprendidas» (usuario, compra de origen, version 1, activas), devuelve guardadas y omitidas y audita una por guardada con datos exactos y sin glosas", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    const a = await eg.capturar(e.id, "gnd.palabra_aprendida", () =>
      llamarOk(backend, e.ctx, SQL.aprender, [
        e.c.id,
        compra.id,
        JSON.stringify([
          termino("audifonos", "entretenimiento"),
          termino("bluetooth", "juguetes"),
        ]),
      ]),
    );
    expect(a.resultado[0].r).toEqual({
      guardadas: ["audifonos", "bluetooth"],
      omitidas: [],
    });
    const p = await eg.propia(e.id, "audifonos");
    expect(p).toMatchObject({
      categoria: "entretenimiento",
      excepciones: [],
      origen: "aprendida",
      activa: true,
      version: 1,
      creado_por: e.u,
      compra_origen_id: compra.id,
    });
    expect(await eg.propia(e.id, "bluetooth")).toMatchObject({
      categoria: "juguetes",
      origen: "aprendida",
    });
    expect(a.filas).toHaveLength(2);
    for (const f of a.filas) {
      expect(f.actor_tipo).toBe("usuario");
      expect(f.usuario_id).toBe(e.u);
      expect(f.cliente_id).toBe(e.c.id);
      expect(f.entidad).toBe("gnd_palabra_estudio");
    }
    const porPalabra = Object.fromEntries(
      a.filas.map((f) => [(f.datos as { palabra: string }).palabra, f]),
    );
    expect(porPalabra.audifonos!.datos).toEqual({
      palabra: "audifonos",
      categoria: "entretenimiento",
      compraId: compra.id,
    });
    expect(porPalabra.audifonos!.entidad_id).toBe(p!.id);
    expect(porPalabra.bluetooth!.datos).toEqual({
      palabra: "bluetooth",
      categoria: "juguetes",
      compraId: compra.id,
    });
    // CA-11: ni la glosa (XML), ni la razon social, ni el RUC, ni el motivo, ni montos en la auditoria
    const texto = JSON.stringify(a.filas.map((f) => f.datos));
    for (const c of [
      CANARIO.glosa,
      CANARIO.razonSocial,
      CANARIO.ruc,
      CANARIO.motivo,
    ])
      expect(texto, c).not.toContain(c);
  });

  it("no toca la compra, sus versiones, el XML ni el estado de la exclusion (solo agrega palabras)", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    const antes = await eg.totales(e.id);
    expect(
      cod(await aprender(e.c, compra.id, [termino("audifonos")], e.ctx)),
    ).toBe("ok");
    const despues = await eg.totales(e.id);
    expect(despues.gnd_palabra_estudio).toBe(antes.gnd_palabra_estudio! + 1);
    for (const t of [
      "compra",
      "compra_version",
      "documento_xml",
      "cliente",
      "membresia",
    ])
      expect(despues[t], t).toBe(antes[t]);
    const v = (
      await admin.query("select version_vigente from compra where id = $1", [
        compra.id,
      ])
    ).rows[0].version_vigente;
    expect(v).toBe(2);
  });

  it("omite lo que ya existe (propia activa, propia desactivada, global activa) sin error, y guarda el resto; el limite no cuenta las omitidas", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    await eg.palabraEstudio(e.id, { palabra: "bluetooth" });
    await eg.palabraEstudio(e.id, { palabra: "jbl", activa: false });
    const nueva = eg.palabraNueva();
    const antesAud = await eg.cuantas(e.id);
    const a = await eg.capturar(e.id, "gnd.palabra_aprendida", () =>
      llamarOk(backend, e.ctx, SQL.aprender, [
        e.c.id,
        compra.id,
        JSON.stringify([
          termino("bluetooth"),
          termino("jbl"),
          termino("zapatilla", "calzado-ropa"),
          termino(nueva),
        ]),
      ]),
    );
    expect(a.resultado[0].r).toEqual({
      guardadas: [nueva],
      omitidas: ["bluetooth", "jbl", "zapatilla"],
    });
    expect(a.filas).toHaveLength(1);
    expect(await eg.cuantas(e.id)).toBe(antesAud + 1);
    // lo existente no cambia
    expect(await eg.propia(e.id, "bluetooth")).toMatchObject({
      origen: "manual",
      version: 1,
    });
    expect(await eg.propia(e.id, "jbl")).toMatchObject({ activa: false });
    expect(await eg.propia(e.id, "zapatilla")).toBeUndefined();
  });

  it("entradas invalidas dan 22023 a TODO: la valida de la misma lista tampoco se guarda (0, 11 terminos, termino o categoria invalidos, no arreglo)", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    const antes = await eg.totalesGnd(e.id);
    const aud = await eg.cuantas(e.id);
    const buena = termino(eg.palabraNueva());
    const malas: [unknown, string][] = [
      [[], "ningun termino"],
      [
        Array.from({ length: 11 }, (_, i) => termino(`palabra${i}x`)),
        "11 terminos",
      ],
      [[buena, termino("ab")], "termino de 2 caracteres"],
      [[buena, termino("x".repeat(41))], "termino de 41 caracteres"],
      [[buena, termino("Audifonos")], "termino con mayuscula"],
      [[buena, termino("dos palabras")], "termino con espacio"],
      [[buena, termino("cámara")], "termino con tilde"],
      [[buena, termino("audifonos", "otra")], "categoria fuera de las 6"],
      [[buena, { termino: "audifonos" }], "sin categoria"],
      [[buena, { categoria: "juguetes" }], "sin termino"],
      [[buena, { termino: 7, categoria: "juguetes" }], "termino numerico"],
      [[buena, "audifonos"], "elemento que no es objeto"],
      [
        { termino: "audifonos", categoria: "juguetes" },
        "objeto en vez de arreglo",
      ],
      ["audifonos", "cadena"],
      [null, "nulo"],
    ];
    for (const [t, n] of malas)
      expect(cod(await aprender(e.c, compra.id, t, e.ctx)), n).toBe("22023");
    expect(await eg.totalesGnd(e.id)).toEqual(antes);
    expect(await eg.cuantas(e.id)).toBe(aud);
    expect(
      await eg.propia(e.id, (buena as { termino: string }).termino),
    ).toBeUndefined();
  });

  it("exactamente 10 terminos valen (el borde)", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    const diez = Array.from({ length: 10 }, (_, i) => termino(`borde${i}x`));
    const r = await aprender(e.c, compra.id, diez, e.ctx);
    expect(filas(r)[0].r.guardadas).toHaveLength(10);
    expect(await eg.activas(e.id)).toBe(10);
  });

  it("CA422: una compra sin la version vigente excluida (nunca excluida, o restaurada despues) da CA422 y no guarda nada", async () => {
    const e = await estudioNuevo();
    const viva = await eg.compraExcluida(e.id, e.c, { excluida: false });
    const restaurada = await eg.compraExcluida(e.id, e.c);
    await eg.version(e.id, restaurada.id, 3, {
      excluida: false,
      motivo: null,
      accion: "restaurar",
      usuarioId: e.u,
    });
    const antes = await eg.totalesGnd(e.id);
    expect(
      cod(await aprender(e.c, viva.id, [termino("audifonos")], e.ctx)),
      "nunca excluida",
    ).toBe("CA422");
    expect(
      cod(await aprender(e.c, restaurada.id, [termino("audifonos")], e.ctx)),
      "excluida y restaurada",
    ).toBe("CA422");
    expect(await eg.totalesGnd(e.id)).toEqual(antes);
  });

  it("CA423: una compra excluida sin XML vigente da CA423 y no guarda nada; sin excluir y sin XML da CA422 (primero la exclusion)", async () => {
    const e = await estudioNuevo();
    const sinXml = await eg.compraExcluida(e.id, e.c, { conXml: false });
    const ninguna = await eg.compraExcluida(e.id, e.c, {
      excluida: false,
      conXml: false,
    });
    const antes = await eg.totalesGnd(e.id);
    expect(
      cod(await aprender(e.c, sinXml.id, [termino("audifonos")], e.ctx)),
    ).toBe("CA423");
    expect(
      cod(await aprender(e.c, ninguna.id, [termino("audifonos")], e.ctx)),
    ).toBe("CA422");
    expect(await eg.totalesGnd(e.id)).toEqual(antes);
  });

  it("CA421: lo que pasa de 2.000 activas da CA421 a todo; con lugar para una, guarda una; las omitidas no ocupan lugar", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    await eg.llenarPalabras(e.id, LIMITE_PROPIAS - 1);
    await eg.palabraEstudio(e.id, { palabra: "yaexiste" });
    // ahora hay 2.000 activas: una nueva no cabe, pero una omitida no es nueva
    const aud = await eg.cuantas(e.id);
    expect(
      cod(await aprender(e.c, compra.id, [termino("nueva1x")], e.ctx)),
      "la 2001",
    ).toBe("CA421");
    expect(
      filas(await aprender(e.c, compra.id, [termino("yaexiste")], e.ctx))[0].r,
    ).toEqual({ guardadas: [], omitidas: ["yaexiste"] });
    expect(await eg.activas(e.id)).toBe(LIMITE_PROPIAS);
    expect(await eg.cuantas(e.id)).toBe(aud);
    // con 1.999 caben una pero no dos: CA421 a todo, nada se guarda
    await eg.admin.query(
      "delete from gnd_palabra_estudio where tenant_id = $1 and palabra = 'yaexiste'",
      [e.id],
    );
    expect(
      cod(
        await aprender(
          e.c,
          compra.id,
          [termino("nueva1x"), termino("nueva2x")],
          e.ctx,
        ),
      ),
      "dos con lugar para una",
    ).toBe("CA421");
    expect(await eg.activas(e.id)).toBe(LIMITE_PROPIAS - 1);
    expect(await eg.propia(e.id, "nueva1x")).toBeUndefined();
    expect(
      filas(await aprender(e.c, compra.id, [termino("nueva1x")], e.ctx))[0].r
        .guardadas,
    ).toEqual(["nueva1x"]);
    expect(await eg.activas(e.id)).toBe(LIMITE_PROPIAS);
  }, 60_000);

  it("los mensajes de error no repiten terminos, glosas ni motivos", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    const mal = await aprender(e.c, compra.id, [termino(CANARIO.glosa)], e.ctx);
    expect(mal.ok).toBe(false);
    if (!mal.ok) {
      expect(mal.code).toBe("22023");
      for (const c of [CANARIO.glosa, CANARIO.razonSocial, CANARIO.motivo])
        expect(mal.message, c).not.toContain(c);
    }
  });
});

// =================================================================================================
describe("gnd_ciiu_guardar (worker; R-14, CA-16)", () => {
  it("inserta las entradas del estudio (con y sin dato) y devuelve cuantas; no escribe en ninguna otra tabla ni audita", async () => {
    const e = await estudioNuevo();
    const antes = await eg.totales(e.id);
    const aud = await eg.cuantas(e.id);
    const r = await ciiu(
      [
        { ruc: "20100070970", ciiu: "4752" },
        { ruc: "20100070971", ciiu: null },
      ],
      e.id,
    );
    expect(filas(r)[0].n).toBe(2);
    const f = await eg.ciiuDe(e.id);
    expect(f.map((x) => [x.ruc, x.ciiu])).toEqual([
      ["20100070970", "4752"],
      ["20100070971", null],
    ]);
    const despues = await eg.totales(e.id);
    expect(despues.gnd_ciiu).toBe(2);
    for (const t of Object.keys(antes).filter((k) => k !== "gnd_ciiu"))
      expect(despues[t], t).toBe(antes[t]);
    expect(await eg.cuantas(e.id)).toBe(aud);
  });

  it("actualiza lo que ya existe (ciiu y consultado_en), incluso de dato a «sin dato» y de «sin dato» a dato; no toca otros RUC ni otros estudios", async () => {
    const e = await estudioNuevo();
    const otro = await estudioNuevo();
    await eg.ciiu(e.id, "20100070970", "4752", { haceDias: 40 });
    await eg.ciiu(e.id, "20100070971", null, { haceDias: 40 });
    await eg.ciiu(e.id, "20100070972", "5610", { haceDias: 40 });
    await eg.ciiu(otro.id, "20100070970", "9999", { haceDias: 40 });
    const antes = await eg.ciiuDe(e.id);
    const antesOtro = await eg.ciiuDe(otro.id);
    const r = await ciiu(
      [
        { ruc: "20100070970", ciiu: null },
        { ruc: "20100070971", ciiu: "4771" },
      ],
      e.id,
    );
    expect(filas(r)[0].n).toBe(2);
    const f = Object.fromEntries(
      (await eg.ciiuDe(e.id)).map((x) => [x.ruc, x]),
    );
    expect(f["20100070970"]!.ciiu).toBeNull();
    expect(f["20100070971"]!.ciiu).toBe("4771");
    expect(f["20100070972"]).toEqual(
      antes.find((x) => x.ruc === "20100070972"),
    );
    expect(f["20100070970"]!.consultado_en.getTime()).toBeGreaterThan(
      antes[0]!.consultado_en.getTime() + 39 * 86_400_000,
    );
    expect(await eg.ciiuDe(otro.id)).toEqual(antesOtro);
  });

  it("consultado_en es el reloj de la BD al llamar (clock_timestamp), no el inicio de la transaccion", async () => {
    const e = await estudioNuevo();
    await eg.ciiu(e.id, "20100070970", "4752", { haceDias: 40 });
    const r = await worker.withTenant({ tenantId: e.id }, async (tx) => {
      await tx.query("select pg_sleep(0.05)");
      await tx.query(SQL.ciiu, [
        JSON.stringify([{ ruc: "20100070970", ciiu: "4752" }]),
      ]);
      return (
        await tx.query(
          "select consultado_en > now() as despues from gnd_ciiu where ruc = '20100070970'",
        )
      ).rows[0].despues as boolean;
    });
    expect(r).toBe(true);
  });

  it("hasta 50 entradas valen; 51 dan 22023 y no guardan ninguna", async () => {
    const e = await estudioNuevo();
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ruc: `2010${String(i).padStart(7, "0")}`,
        ciiu: "4752",
      }));
    expect(filas(await ciiu(mk(50), e.id))[0].n).toBe(50);
    expect((await eg.ciiuDe(e.id)).length).toBe(50);
    const e2 = await estudioNuevo();
    expect(cod(await ciiu(mk(51), e2.id))).toBe("22023");
    expect(await eg.ciiuDe(e2.id)).toEqual([]);
  });

  it("RUC o CIIU invalidos dan 22023 a TODO: la entrada valida de la misma llamada tampoco se guarda", async () => {
    const e = await estudioNuevo();
    const buena = { ruc: "20100070970", ciiu: "4752" };
    const malas: [unknown, string][] = [
      [[buena, { ruc: "2010007097", ciiu: "4752" }], "RUC de 10 digitos"],
      [[buena, { ruc: "201000709701", ciiu: "4752" }], "RUC de 12 digitos"],
      [[buena, { ruc: "2010007097a", ciiu: "4752" }], "RUC con letra"],
      [[buena, { ruc: "20100070971", ciiu: "475" }], "CIIU de 3 digitos"],
      [[buena, { ruc: "20100070971", ciiu: "47521" }], "CIIU de 5 digitos"],
      [[buena, { ruc: "20100070971", ciiu: "47a2" }], "CIIU con letra"],
      [[buena, { ciiu: "4752" }], "sin RUC"],
      [[buena, { ruc: "20100070971" }], "sin clave ciiu"],
      [[buena, { ruc: 20100070971, ciiu: "4752" }], "RUC numerico"],
      [[buena, "20100070971"], "elemento que no es objeto"],
      [{ ruc: "20100070970", ciiu: "4752" }, "objeto en vez de arreglo"],
      [null, "nulo"],
    ];
    for (const [t, n] of malas)
      expect(cod(await ciiu(t, e.id)), n).toBe("22023");
    expect(await eg.ciiuDe(e.id)).toEqual([]);
  });

  it("el mensaje de un rechazo no repite el RUC recibido", async () => {
    const e = await estudioNuevo();
    const r = await ciiu([{ ruc: CANARIO.glosa, ciiu: "4752" }], e.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(CANARIO.glosa);
  });

  it("solo escribe en el estudio de la sesion: el RUC de otro estudio con la misma clave es otra fila", async () => {
    const a = await estudioNuevo();
    const b = await estudioNuevo();
    expect(cod(await ciiu([{ ruc: "20100070970", ciiu: "4752" }], a.id))).toBe(
      "ok",
    );
    expect(cod(await ciiu([{ ruc: "20100070970", ciiu: "4771" }], b.id))).toBe(
      "ok",
    );
    expect((await eg.ciiuDe(a.id))[0]!.ciiu).toBe("4752");
    expect((await eg.ciiuDe(b.id))[0]!.ciiu).toBe("4771");
  });
});
