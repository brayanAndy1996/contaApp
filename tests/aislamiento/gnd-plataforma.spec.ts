// Spec 027 (T3, rojo): las cuatro funciones de plataforma `auth.gnd_global_*` de la migracion 0070 (D-2, D-3, R-6; CA-7, CA-14): el
// diccionario global lo edita solo el super-admin (sesion viva con alta en `admin_plataforma`, revalidada en cada llamada), con
// compare-and-set por version (CA409), palabra repetida (CA420), entradas invalidas (22023), historial global con el actor y paginado por
// fecha, y sin leer ni escribir tablas del estudio. Catalogo: dueno contapp_auth, search_path fijo, EXECUTE solo contapp_backend (patron de
// `auth.plan_crear`, 0024). Contrato en `gnd-soporte.ts`. Hasta T10 fallan por funcion o tabla inexistente. Modelo: `planes-funciones.spec.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, abrirApp, llamar, type Llamada } from "./auth-soporte";
import { EscenarioPlanes } from "./planes-soporte";
import {
  CANARIO,
  CATEGORIAS,
  conExecute,
  EscenarioGnd,
  FIRMAS_PLATAFORMA,
  idNuevo,
  infoFuncion,
  ROLES_FUNCION,
  SQL_PLATAFORMA as SQL,
  TABLAS_GND_ESTUDIO,
} from "./gnd-soporte";

let admin: Pool;
let app: Pool;
let pl: EscenarioPlanes;
let eg: EscenarioGnd;
let adm: { id: string; token: Buffer };

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirApp(10);
  pl = new EscenarioPlanes(admin);
  eg = new EscenarioGnd(admin);
  const a = await pl.administrador();
  adm = { id: a.usuario.id, token: a.sesion };
});
afterAll(async () => {
  await eg?.limpiar();
  await pl?.limpiar();
  await Promise.all([eg?.cerrar()].map((p) => p?.catch(() => undefined)));
  await app?.end();
  await admin?.end();
});

// ---- Ayudas --------------------------------------------------------------------------------------------------------------------
const cod = (r: Llamada) => (r.ok ? "ok" : r.code);
function filas(r: Llamada): any[] {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.rows;
}
const listar = (t: Buffer = adm.token) => llamar(app, SQL.listar, [t]);
const agregar = (
  palabra: string,
  categoria = "juguetes",
  excepciones: string[] = [],
  t: Buffer = adm.token,
) => llamar(app, SQL.agregar, [t, palabra, categoria, excepciones]);
const editar = (
  id: string,
  categoria: string,
  excepciones: string[],
  activa: boolean,
  version: number,
  t: Buffer = adm.token,
) => llamar(app, SQL.editar, [t, id, categoria, excepciones, activa, version]);
const historial = (
  limite: number | null,
  antes: string | null = null,
  t: Buffer = adm.token,
) => llamar(app, SQL.historial, [t, limite, antes]);
const nuevaGlobal = async (
  categoria = "juguetes",
  excepciones: string[] = [],
) => {
  const palabra = eg.palabraNueva();
  const f = filas(await agregar(palabra, categoria, excepciones))[0];
  return { palabra, id: f.id as string, fila: f };
};

/** Una sesion viva de una cuenta SIN alta en admin_plataforma (con o sin estudio). */
async function sesionDeEstudio(): Promise<Buffer> {
  const x = await pl.ea.estudio();
  const u = await pl.ea.miembro(x.id, "dueno");
  return pl.ea.esc.sesion(u.id, x.id);
}

// =================================================================================================
describe("0070 · las cuatro funciones de plataforma en el catalogo (D-2, CA-7)", () => {
  for (const [k, firma] of Object.entries(FIRMAS_PLATAFORMA)) {
    it(`${k}: ${firma}: SECURITY DEFINER de contapp_auth, search_path fijo, sin PUBLIC; solo contapp_backend la ejecuta`, async () => {
      const i = await infoFuncion(admin, firma).catch(() => {
        throw new Error(`falta la funcion ${firma} (migracion 0070)`);
      });
      expect(i).toEqual({
        secdef: true,
        config: ["search_path=pg_catalog, pg_temp"],
        dueno: "contapp_auth",
        duenoSuper: false,
        duenoBypass: false,
      });
      // el dueno (contapp_auth) ejecuta por serlo: se excluye de la lista, como contapp_migrator en las de public
      expect(
        await conExecute(
          admin,
          firma,
          ROLES_FUNCION.filter((r) => r !== "contapp_auth"),
        ),
      ).toEqual(["contapp_backend"]);
    });
  }

  it("ninguna lee tablas del estudio ni la auditoria (solo plataforma, sesion y las dos gnd_ globales)", async () => {
    const r = await admin.query(
      `select p.proname, p.prosrc from pg_proc p
        where p.pronamespace = 'auth'::regnamespace and p.proname like 'gnd\\_global\\_%'`,
    );
    expect(r.rows, "faltan funciones (migracion 0070)").toHaveLength(4);
    const prohibidas = [
      ...TABLAS_GND_ESTUDIO,
      "cliente",
      "compra",
      "documento_xml",
      "auditoria",
      "membresia",
      "notificacion",
    ];
    for (const f of r.rows)
      for (const t of prohibidas)
        expect(
          new RegExp(`\\b${t}\\b`, "i").test(f.prosrc),
          `${f.proname} menciona ${t}`,
        ).toBe(false);
  });
});

// =================================================================================================
describe("0070 · quien llama: sesion viva con alta en admin_plataforma, revalidada en cada llamada (42501, CA-7)", () => {
  let g: { id: string; palabra: string };

  beforeAll(async () => {
    g = await nuevaGlobal();
  });

  /** Una llamada valida de cada funcion con `t` como sesion. */
  const con = (t: Buffer): [string, Promise<Llamada>][] => [
    ["listar", listar(t)],
    ["agregar", agregar(eg.palabraNueva(), "juguetes", [], t)],
    ["editar", editar(g.id, "juguetes", [], false, 1, t)],
    ["historial", historial(10, null, t)],
  ];

  async function rechazadas(t: Buffer, nombre: string) {
    const antes = await totales();
    for (const [k, p] of con(t))
      expect(cod(await p), `${nombre}: ${k}`).toBe("42501");
    expect(await totales(), `${nombre}: sin efectos`).toEqual(antes);
  }
  const totales = async () => ({
    globales: Number(
      (await admin.query("select count(*)::int as n from gnd_palabra_global"))
        .rows[0].n,
    ),
    historial: Number(
      (await admin.query("select count(*)::int as n from gnd_global_historial"))
        .rows[0].n,
    ),
    version: (await eg.global(g.id))!.version,
  });

  it("un token que no es de ninguna sesion da 42501 en las cuatro", async () => {
    await rechazadas(Buffer.alloc(32, 7), "token desconocido");
  });

  it("una sesion viva de un usuario de estudio (Dueno) sin alta en admin_plataforma da 42501 en las cuatro", async () => {
    await rechazadas(await sesionDeEstudio(), "usuario de estudio");
  });

  it("una sesion de un administrador revocada, vencida o cuya alta se retiro da 42501 en las cuatro", async () => {
    const a1 = await pl.administrador();
    await admin.query(
      "update auth.sesion set revocada_en = now() where token_hash = $1",
      [a1.sesion],
    );
    await rechazadas(a1.sesion, "revocada");
    const a2 = await pl.administrador();
    await admin.query(
      "update auth.sesion set ultimo_uso = now() - interval '3 hours' where token_hash = $1",
      [a2.sesion],
    );
    await rechazadas(a2.sesion, "inactiva mas de 2 horas");
    const a3 = await pl.administrador();
    await admin.query("delete from admin_plataforma where usuario_id = $1", [
      a3.usuario.id,
    ]);
    await rechazadas(a3.sesion, "alta retirada");
  });

  it("el administrador con sesion viva si las ejecuta (la prueba no es vacua)", async () => {
    for (const [k, p] of con(adm.token)) {
      expect(cod(await p), k).toBe("ok");
    }
  });

  it("el rol equivocado (worker, contapp_app) ni siquiera ejecuta la funcion: 42501", async () => {
    for (const rol of ["contapp_worker", "contapp_app", "contapp_platform"]) {
      expect(cod(await llamar(app, SQL.listar, [adm.token], rol)), rol).toBe(
        "42501",
      );
    }
  });
});

// =================================================================================================
describe("auth.gnd_global_listar (D-2)", () => {
  it("devuelve las globales con sus columnas, la semilla y las de la prueba, incluso las inactivas", async () => {
    const inactiva = await eg.palabraGlobal({ activa: false });
    const f = filas(await listar());
    expect(f.length).toBeGreaterThanOrEqual(72);
    const por = Object.fromEntries(f.map((x) => [x.palabra, x]));
    expect(por.zapatilla).toMatchObject({
      categoria: "calzado-ropa",
      activa: true,
      version: 1,
    });
    expect([...por.zapatilla.excepciones].sort()).toEqual([
      "punta de acero",
      "seguridad",
    ]);
    expect(Object.keys(por.zapatilla)).toEqual(
      expect.arrayContaining([
        "id",
        "palabra",
        "categoria",
        "excepciones",
        "activa",
        "version",
        "actualizada_en",
      ]),
    );
    expect(por[inactiva.palabra]).toMatchObject({
      id: inactiva.id,
      activa: false,
    });
  });
});

// =================================================================================================
describe("auth.gnd_global_agregar (D-2, CA420, CA-14)", () => {
  it("inserta la global activa version 1 y la devuelve; deja su fila `agregada` en el historial con el actor, antes nulo y despues con la fila", async () => {
    const palabra = eg.palabraNueva();
    const r = filas(
      await agregar(palabra, "cuidado-personal", [
        "seguridad",
        "punta de acero",
      ]),
    );
    expect(r).toHaveLength(1);
    const g = r[0];
    expect(g).toMatchObject({
      palabra,
      categoria: "cuidado-personal",
      excepciones: ["seguridad", "punta de acero"],
      activa: true,
      version: 1,
    });
    expect(await eg.global(g.id)).toMatchObject({
      palabra,
      categoria: "cuidado-personal",
      activa: true,
      version: 1,
    });
    const h = await eg.historial(g.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({
      palabra_global_id: g.id,
      accion: "agregada",
      antes: null,
      usuario_id: adm.id,
    });
    expect(h[0]!.despues).toEqual({
      palabra,
      categoria: "cuidado-personal",
      excepciones: ["seguridad", "punta de acero"],
      activa: true,
      version: 1,
    });
  });

  it("las 6 categorias valen", async () => {
    for (const c of CATEGORIAS)
      expect(cod(await agregar(eg.palabraNueva(), c)), c).toBe("ok");
  });

  it("CA420: repetir una global (propia de la prueba o de la semilla) da CA420 y no escribe ni deja historial", async () => {
    const g = await nuevaGlobal();
    const antes = (
      await admin.query("select count(*)::int as n from gnd_global_historial")
    ).rows[0].n;
    expect(cod(await agregar(g.palabra, "juguetes"))).toBe("CA420");
    expect(cod(await agregar("zapatilla", "calzado-ropa"))).toBe("CA420");
    expect(
      (await admin.query("select count(*)::int as n from gnd_global_historial"))
        .rows[0].n,
    ).toBe(antes);
    expect(await eg.historial(g.id)).toHaveLength(1);
  });

  it("entradas invalidas dan 22023 y no escriben: palabra no normalizada, categoria fuera de las 6, excepciones mal formadas, nulos", async () => {
    const antes = Number(
      (await admin.query("select count(*)::int as n from gnd_palabra_global"))
        .rows[0].n,
    );
    const p = eg.palabraNueva();
    const malas: [unknown[], string][] = [
      [["ab", "juguetes", []], "2 caracteres"],
      [["x".repeat(41), "juguetes", []], "41 caracteres"],
      [["Mayuscula", "juguetes", []], "mayuscula"],
      [["con espacio", "juguetes", []], "espacio"],
      [["cámara", "juguetes", []], "tilde"],
      [[null, "juguetes", []], "palabra nula"],
      [[p, "otra", []], "categoria fuera de las 6"],
      [[p, null, []], "categoria nula"],
      [[p, "juguetes", ["a", "b", "c", "d", "e", "f"]], "6 excepciones"],
      [[p, "juguetes", ["uno dos tres cuatro"]], "frase de 4 palabras"],
      [[p, "juguetes", ["Seguridad"]], "frase con mayuscula"],
      [[p, "juguetes", [""]], "frase vacia"],
      [[p, "juguetes", null], "excepciones nulas"],
    ];
    for (const [v, n] of malas)
      expect(cod(await llamar(app, SQL.agregar, [adm.token, ...v])), n).toBe(
        "22023",
      );
    expect(
      Number(
        (await admin.query("select count(*)::int as n from gnd_palabra_global"))
          .rows[0].n,
      ),
    ).toBe(antes);
    expect(await eg.globalPorPalabra(p)).toBeUndefined();
  });

  it("el mensaje de un rechazo no repite lo recibido", async () => {
    const r = await agregar(CANARIO.glosa);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("22023");
      expect(r.message).not.toContain(CANARIO.glosa);
    }
  });

  it("no toca tablas del estudio ni la auditoria de ningun estudio", async () => {
    const cuenta = async () =>
      (
        await Promise.all(
          [...TABLAS_GND_ESTUDIO, "auditoria"].map(
            async (t) =>
              (await admin.query(`select count(*)::int as n from ${t}`)).rows[0]
                .n as number,
          ),
        )
      ).join(",");
    const antes = await cuenta();
    await nuevaGlobal();
    expect(await cuenta()).toBe(antes);
  });
});

// =================================================================================================
describe("auth.gnd_global_editar (D-2, CA409, CA-14)", () => {
  it("cambia categoria, excepciones y activa con la version vigente: devuelve la fila con version + 1 y deja la fila `editada` con antes y despues", async () => {
    const g = await nuevaGlobal("juguetes", ["seguridad"]);
    const r = filas(
      await editar(
        g.id,
        "entretenimiento",
        ["punta de acero", "jebe"],
        false,
        1,
      ),
    )[0];
    expect(r).toMatchObject({
      id: g.id,
      palabra: g.palabra,
      categoria: "entretenimiento",
      excepciones: ["punta de acero", "jebe"],
      activa: false,
      version: 2,
    });
    expect(await eg.global(g.id)).toMatchObject({
      categoria: "entretenimiento",
      activa: false,
      version: 2,
    });
    const h = await eg.historial(g.id);
    expect(h.map((x) => x.accion)).toEqual(["agregada", "editada"]);
    expect(h[1]).toMatchObject({ usuario_id: adm.id });
    expect(h[1]!.antes).toEqual({
      palabra: g.palabra,
      categoria: "juguetes",
      excepciones: ["seguridad"],
      activa: true,
      version: 1,
    });
    expect(h[1]!.despues).toEqual({
      palabra: g.palabra,
      categoria: "entretenimiento",
      excepciones: ["punta de acero", "jebe"],
      activa: false,
      version: 2,
    });
    // reactivar con la version nueva
    const r2 = filas(await editar(g.id, "entretenimiento", [], true, 2))[0];
    expect([r2.activa, r2.version]).toEqual([true, 3]);
    expect((await eg.historial(g.id)).map((x) => x.accion)).toEqual([
      "agregada",
      "editada",
      "editada",
    ]);
  });

  it("CA409: la version vieja o futura no cambia la fila ni deja historial; las demas globales no se tocan", async () => {
    const g = await nuevaGlobal();
    const otra = await nuevaGlobal();
    expect(cod(await editar(g.id, "juguetes", [], false, 5)), "futura").toBe(
      "CA409",
    );
    expect(cod(await editar(g.id, "juguetes", [], false, 0)), "cero").toBe(
      "CA409",
    );
    expect(await eg.global(g.id)).toMatchObject({ activa: true, version: 1 });
    expect(await eg.historial(g.id)).toHaveLength(1);
    expect(await eg.historial(otra.id)).toHaveLength(1);
    expect((await eg.global(otra.id))!.version).toBe(1);
  });

  it("una global inexistente da P0002 sin escribir", async () => {
    expect(cod(await editar(idNuevo(), "juguetes", [], true, 1))).toBe("P0002");
  });

  it("entradas invalidas dan 22023 y no escriben: categoria fuera de las 6, excepciones mal formadas, activa o version nulas", async () => {
    const g = await nuevaGlobal();
    const malas: [unknown[], string][] = [
      [["otra", [], true, 1], "categoria fuera de las 6"],
      [[null, [], true, 1], "categoria nula"],
      [["juguetes", ["a", "b", "c", "d", "e", "f"], true, 1], "6 excepciones"],
      [["juguetes", ["uno dos tres cuatro"], true, 1], "frase de 4 palabras"],
      [["juguetes", ["Seguridad"], true, 1], "frase con mayuscula"],
      [["juguetes", null, true, 1], "excepciones nulas"],
      [["juguetes", [], null, 1], "activa nula"],
      [["juguetes", [], true, null], "version nula"],
      [["juguetes", [], true, -1], "version negativa"],
    ];
    for (const [v, n] of malas)
      expect(
        cod(await llamar(app, SQL.editar, [adm.token, g.id, ...v])),
        n,
      ).toBe("22023");
    expect(await eg.global(g.id)).toMatchObject({ version: 1, activa: true });
    expect(await eg.historial(g.id)).toHaveLength(1);
  });

  it("desactivar una global no toca lo que los estudios desactivaron ni sus palabras propias (la mezcla se hace al leer el contexto)", async () => {
    const x = await pl.ea.estudio();
    const u = await eg.usuarioDe(x.id);
    const g = await nuevaGlobal();
    await eg.desactivadaGlobal(x.id, g.id, u);
    await eg.palabraEstudio(x.id, { palabra: g.palabra });
    expect(cod(await editar(g.id, "juguetes", [], false, 1))).toBe("ok");
    expect(await eg.desactivadas(x.id)).toEqual([g.id]);
    expect((await eg.propia(x.id, g.palabra))!.activa).toBe(true);
  });
});

// =================================================================================================
describe("auth.gnd_global_historial (D-2, CA-14)", () => {
  it("devuelve los cambios con el actor, los mas recientes primero, y pagina por fecha con `antes` y `limite`", async () => {
    const g = await nuevaGlobal();
    expect(cod(await editar(g.id, "juguetes", ["seguridad"], true, 1))).toBe(
      "ok",
    );
    expect(cod(await editar(g.id, "juguetes", [], false, 2))).toBe("ok");
    const ids = (await eg.historial(g.id)).map((h) => h.id); // por fecha ascendente
    expect(ids).toHaveLength(3);
    const p1 = filas(await historial(2));
    expect(p1.map((h) => h.id)).toEqual([ids[2], ids[1]]);
    expect(Object.keys(p1[0])).toEqual(
      expect.arrayContaining([
        "id",
        "palabra_global_id",
        "accion",
        "antes",
        "despues",
        "usuario_id",
        "ocurrida_en",
      ]),
    );
    expect(p1[0]).toMatchObject({
      palabra_global_id: g.id,
      accion: "editada",
      usuario_id: adm.id,
    });
    const corte = (
      await admin.query(
        "select ocurrida_en::text as t from gnd_global_historial where id = $1",
        [ids[1]],
      )
    ).rows[0].t as string;
    const p2 = filas(await historial(2, corte));
    expect(p2[0].id).toBe(ids[0]);
    expect(p2[0]).toMatchObject({ accion: "agregada", usuario_id: adm.id });
    // todos los de la pagina son anteriores al corte y vienen en orden descendente
    const tiempos = p2.map((h) => new Date(h.ocurrida_en).getTime());
    expect([...tiempos].sort((a, b) => b - a)).toEqual(tiempos);
    expect(tiempos.every((t) => t < new Date(corte).getTime() + 1)).toBe(true);
  });

  it("el limite va de 1 a 200: 0, 201, negativo y nulo dan 22023; los bordes 1 y 200 valen", async () => {
    for (const n of [0, 201, -1, null])
      expect(cod(await historial(n)), String(n)).toBe("22023");
    expect(filas(await historial(1))).toHaveLength(1);
    expect(filas(await historial(200)).length).toBeLessThanOrEqual(200);
  });

  it("no muestra datos de estudios: solo columnas del historial global (sin tenant_id)", async () => {
    const r = filas(await historial(5));
    expect(r.length).toBeGreaterThan(0);
    expect(Object.keys(r[0])).not.toContain("tenant_id");
  });
});
