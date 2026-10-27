// Spec 008 (T3, rojo): repositorios de `packages/db/src/trabajos/**` y `credenciales/estado.ts` contra la BD real
// (CA-5, CA-7, CA-9, CA-12, CA-13, CA-14; D1, D2, D8, D16, D17, D18). Se importan de `@contapp/db` por nombre (si faltan, la
// prueba dice cual); cada archivo crea sus estudios, usuarios, clientes y trabajos (EscenarioTrabajos) y los borra al final.
//
// FIRMAS que fija (T7). Todas reciben la `tx` de withTenant como primer argumento, salvo las de `withSistema`. Las filas
// salen en camelCase con Date para las fechas y Buffer para bytea; los errores de pg se reducen a TrabajosRepoError.
//   ALINEADO con packages/queue/src/soporte-pruebas/bd-falsa.ts (T4): insertarTrabajo, trabajoVivoPorClave y listarTrabajos devuelven
//   TrabajoVista (shared: id, tipo, clienteId, estado, posicion = null, intentos, motivo, creadoEn/iniciadoEn/terminadoEn como
//   string ISO, creadoPor { usuarioId } | null); siguienteDisponible y leerTrabajo devuelven TrabajoFila (siguienteDisponible puede
//   limitarse a TrabajoDespacho = id, tenantId, clienteId, ruc, tipo, cola, canal, prioridad, creadoPor, creadoEn, intentos);
//   estadoCredencial devuelve solo el estado ('configurada' | 'verificada' | 'invalida') o null.
//   type TrabajoFila = { id, tenantId, clienteId, ruc, tipo, cola, canal, prioridad, estado, parametros, claveDedupe: Buffer,
//     creadoPor: string | null, intentos, maxIntentos, motivo: string | null, resultado: unknown | null,
//     disponibleDesde: Date, creadoEn: Date, iniciadoEn: Date | null, terminadoEn: Date | null, actualizadoEn: Date }
//   insertarTrabajo(tx, { clienteId, ruc, tipo, cola, canal, prioridad, parametros, claveDedupe: Buffer, creadoPor: string | null,
//     maxIntentos }) -> TrabajoVista                     (rol backend; estado en_cola; tenant del contexto)
//   trabajoVivoPorClave(tx, claveDedupe: Buffer) -> TrabajoVista | null           (en_cola o ejecutando; D8)
//   contarPendientes(tx, cola) -> number                                           (solo en_cola de esa cola y del estudio)
//   siguienteDisponible(tx, cola, ahora: Date) -> TrabajoFila | null              (en_cola con disponible_desde <= ahora;
//                                                      interactivo antes que programado, luego creado_en, luego id; rol worker)
//   transicionar(tx, id, desde, hacia, campos?: { motivo?, intentos?, resultado?, disponibleDesde?: Date }) -> boolean
//        UPDATE ... WHERE id = $ AND estado = desde; true solo si cambio una fila (ganador unico, D2). Fija iniciado_en = now()
//        cuando hacia = 'ejecutando', terminado_en = now() cuando hacia es terminal y actualizado_en = now() siempre; no toca
//        ninguna otra columna. El backend solo puede en_cola -> cancelado (los grants de columna lo imponen: 42501).
//   leerTrabajo(tx, id) -> TrabajoFila | null
//   listarTrabajos(tx, alcance: Alcance, filtros?: { clienteId?, estado? }) -> TrabajoVista[]   (creado_en DESC, maximo 100)
//   posicion(tx, id) -> number | null           (1 + en_cola del mismo estudio y cola que salen antes; null si no esta en_cola)
//   purgarTerminados(tx, antesDe: Date) -> number     (borra completado/error/cancelado con terminado_en < antesDe; rol worker)
//   revalidarEncolado(tx, { clienteId, creadoPor: string | null, rolesPermitidos: readonly string[] | null })
//        -> 'ok' | 'acceso_retirado'                  (D17; rol worker; lecturas sin FOR UPDATE)
//        (puede recibir ademas el resto del TrabajoDespacho, p. ej. `id`, que queue pasa tal cual; solo se leen esos 3 campos)
//        - el cliente debe existir en el estudio; creadoPor null (programado) solo exige eso;
//        - si no: membresia ACTIVA, rol dentro de rolesPermitidos (null = sin permiso requerido) y, para roles distintos de
//          dueno y admin, una asignacion al cliente (alcance 'asignado', como filtroAlcance).
//   marcarCredencialInvalida(tx, clienteId, tipo, motivo = 'credencial_invalida') -> boolean   (rol worker; true solo si la
//        credencial existia y no estaba ya 'invalida'; fija estado, estado_motivo y estado_at)
//   estadoCredencial(tx, clienteId, tipo) -> 'configurada' | 'verificada' | 'invalida' | null
//   withSistema: leerConfig(tx) -> Map<NombreCola, { cola, concurrenciaGlobal, concurrenciaTenant, esperaRucMs, reintentos,
//        backoffBaseMs, maxPendientesTenant }>; estudiosIds(tx) -> string[]; estudiosConTrabajos(tx, estados, antiguedadSeg) ->
//        string[]; purgarAuth(tx, { sesionDias, tokenDias, intentoDias, limiteDias }) -> { sesiones, tokens, intentos, limites }
//   TrabajosRepoError: `codigo` = SQLSTATE y nada mas del error de pg (sin detail, where, constraint, table, column, cause).
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { enRollback, type ContappDb } from "./soporte";
import {
  conSistema,
  crearDb,
  EscenarioTrabajos,
  exportado,
  UUID,
  type ClientePrueba,
  type SistemaDb,
} from "./trabajos-soporte";

type Fn = (...a: any[]) => Promise<any>;
const f = (nombre: string) => exportado<Fn>(nombre);
const GLOBAL = { tipo: "global" } as const;

let admin: Pool;
let et: EscenarioTrabajos;
const dbs: ContappDb[] = [];
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let dueno: string;
let admin1: string;
let contador: string;
let asistente: string;
let lectura: string;
let usuarioY: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  et = new EscenarioTrabajos(admin);
  X = (await et.estudio()).id;
  Y = (await et.estudio()).id;
  cx = await et.cliente(X);
  cy = await et.cliente(Y);
  dueno = (await et.miembro(X, "dueno")).id;
  admin1 = (await et.miembro(X, "admin")).id;
  contador = (await et.miembro(X, "contador")).id;
  asistente = (await et.miembro(X, "asistente")).id;
  lectura = (await et.miembro(X, "lectura")).id;
  usuarioY = (await et.miembro(Y, "contador")).id;
});
afterAll(async () => {
  await et?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await admin?.end();
});

const dbDe = (rol: "contapp_backend" | "contapp_worker", max = 3): ContappDb => {
  const d = crearDb(rol, max);
  dbs.push(d);
  return d;
};
const backend = () => dbDe("contapp_backend");
const worker = () => dbDe("contapp_worker");

const nuevo = (c: ClientePrueba, o: Record<string, unknown> = {}) => ({
  clienteId: c.id,
  ruc: c.ruc,
  tipo: "prueba.eco",
  cola: "sire",
  canal: "sire",
  prioridad: "interactivo",
  parametros: { n: 1 },
  claveDedupe: randomBytes(32),
  creadoPor: null,
  maxIntentos: 3,
  ...o,
});

/** Estudio aislado con su cliente, para pruebas que cuentan filas (cola vacia al empezar). */
async function estudioNuevo() {
  const t = (await et.estudio()).id;
  return { t, c: await et.cliente(t) };
}

// =================================================================================================
describe("insertarTrabajo, trabajoVivoPorClave y contarPendientes (CA-1, D8)", () => {
  it("lo insertado queda en el estudio del contexto con todos sus datos (se comprueba en la tabla, no en la vista)", async () => {
    const e = nuevo(cx, { creadoPor: contador, parametros: { rango: "2026-01", n: 7 }, cola: "sol", canal: "sol", prioridad: "programado" });
    const r = await backend().withTenant({ tenantId: X }, async (tx) => (await f("insertarTrabajo")(tx, e)).id);
    const fila = await et.fila(r);
    expect(fila).toMatchObject({ tenant_id: X, cliente_id: cx.id, ruc: cx.ruc, tipo: "prueba.eco", cola: "sol", canal: "sol", prioridad: "programado", estado: "en_cola", parametros: { rango: "2026-01", n: 7 }, creado_por: contador, intentos: 0, max_intentos: 3 });
    expect(Buffer.compare(fila.clave_dedupe, e.claveDedupe)).toBe(0);
  });

  it("inserta en el estudio del contexto, nace en_cola con intentos 0 y devuelve la fila en camelCase", async () => {
    const e = nuevo(cx, { creadoPor: contador, parametros: { rango: "2026-01", n: 7 }, cola: "sol", canal: "sol", prioridad: "programado" });
    const t = await enRollback(backend(), { tenantId: X }, (tx) => f("insertarTrabajo")(tx, e));
    expect(t.id).toMatch(UUID);
    expect(t).toMatchObject({
      tipo: "prueba.eco",
      clienteId: cx.id,
      estado: "en_cola",
      posicion: null,
      intentos: 0,
      motivo: null,
      iniciadoEn: null,
      terminadoEn: null,
      creadoPor: { usuarioId: contador },
    });
    expect(Number.isNaN(Date.parse(t.creadoEn)), "creadoEn es un string ISO").toBe(false);
    expect(Object.keys(t)).not.toEqual(expect.arrayContaining(["ruc", "tenantId", "claveDedupe", "parametros"]));
  });

  it("creadoPor null (programado) entra", async () => {
    const t = await enRollback(backend(), { tenantId: X }, (tx) => f("insertarTrabajo")(tx, nuevo(cx, { creadoPor: null })));
    expect(t.creadoPor).toBeNull();
  });

  it("errores de pg -> TrabajosRepoError con solo el SQLSTATE: FK 23503, CHECK 23514 y dedupe 23505", async () => {
    const Error_ = exportado<new (...a: any[]) => Error & { codigo: string }>("TrabajosRepoError");
    const caso = async (e: object) =>
      enRollback(backend(), { tenantId: X }, async (tx) => {
        await tx.query("SAVEPOINT s");
        try {
          await f("insertarTrabajo")(tx, e);
          return null;
        } catch (err) {
          await tx.query("ROLLBACK TO SAVEPOINT s");
          return err as Error & { codigo: string };
        }
      });
    const fk = await caso(nuevo(cy)); // cliente de otro estudio
    const ck = await caso(nuevo(cx, { tipo: "Mal Tipo" }));
    for (const [err, codigo] of [[fk, "23503"], [ck, "23514"]] as const) {
      expect(err, codigo).toBeInstanceOf(Error_);
      expect(err!.codigo).toBe(codigo);
      expect(err).not.toHaveProperty("detail");
      expect(err).not.toHaveProperty("constraint");
      expect(err).not.toHaveProperty("table");
      expect(err!.cause).toBeUndefined();
      expect(err!.message).not.toContain(cx.ruc);
      expect(err!.message).not.toContain(cy.ruc);
    }
    const clave = randomBytes(32);
    const dup = await enRollback(backend(), { tenantId: X }, async (tx) => {
      await f("insertarTrabajo")(tx, nuevo(cx, { claveDedupe: clave }));
      await tx.query("SAVEPOINT s2");
      try {
        await f("insertarTrabajo")(tx, nuevo(cx, { claveDedupe: clave }));
        return null;
      } catch (err) {
        await tx.query("ROLLBACK TO SAVEPOINT s2");
        return err as { codigo: string };
      }
    });
    expect(dup!.codigo).toBe("23505");
  });

  it("trabajoVivoPorClave halla en_cola y ejecutando; no halla terminados, de otro estudio ni inexistentes", async () => {
    const claves = { cola: randomBytes(32), ejec: randomBytes(32), fin: randomBytes(32), ajeno: randomBytes(32) };
    const idCola = await et.job(X, cx, { claveDedupe: claves.cola });
    const idEjec = await et.job(X, cx, { claveDedupe: claves.ejec, estado: "ejecutando" });
    await et.job(X, cx, { claveDedupe: claves.fin, estado: "completado", hace: 5 });
    await et.job(Y, cy, { claveDedupe: claves.ajeno });
    const r = await backend().withTenant({ tenantId: X }, async (tx) => ({
      cola: await f("trabajoVivoPorClave")(tx, claves.cola),
      ejec: await f("trabajoVivoPorClave")(tx, claves.ejec),
      fin: await f("trabajoVivoPorClave")(tx, claves.fin),
      ajeno: await f("trabajoVivoPorClave")(tx, claves.ajeno),
      nada: await f("trabajoVivoPorClave")(tx, randomBytes(32)),
    }));
    expect(r.cola.id).toBe(idCola);
    expect(r.ejec.id).toBe(idEjec);
    expect(r.fin).toBeNull();
    expect(r.ajeno).toBeNull();
    expect(r.nada).toBeNull();
  });

  it("contarPendientes cuenta solo los en_cola de esa cola y de ese estudio", async () => {
    const { t, c } = await estudioNuevo();
    const otro = await estudioNuevo();
    for (const o of [{}, {}, { prioridad: "programado" }, { cola: "sol", canal: "sol" }, { estado: "ejecutando" }, { estado: "completado", hace: 9 }]) {
      await et.job(t, c, o);
    }
    await et.job(otro.t, otro.c);
    const r = await backend().withTenant({ tenantId: t }, async (tx) => ({
      sire: await f("contarPendientes")(tx, "sire"),
      sol: await f("contarPendientes")(tx, "sol"),
      xml: await f("contarPendientes")(tx, "xml"),
    }));
    expect(r).toEqual({ sire: 3, sol: 1, xml: 0 });
  });
});

// =================================================================================================
describe("siguienteDisponible (CA-2: prioridad dentro del estudio)", () => {
  it("interactivo antes que programado aunque el programado sea mas viejo; luego creado_en; ignora futuros, no en_cola y otras colas", async () => {
    const { t, c } = await estudioNuevo();
    const progViejo = await et.job(t, c, { prioridad: "programado", hace: 900 });
    const interNuevo = await et.job(t, c, { prioridad: "interactivo", hace: 10 });
    const interViejo = await et.job(t, c, { prioridad: "interactivo", hace: 100 });
    await et.job(t, c, { prioridad: "interactivo", hace: 5000, estado: "ejecutando" });
    const futuroId = await et.job(t, c, { prioridad: "interactivo", hace: 5000, disponibleEn: 3600 });
    await et.job(t, c, { prioridad: "interactivo", hace: 5000, cola: "sol", canal: "sol" });
    const w = worker();
    const secuencia: string[] = [];
    await w.withTenant({ tenantId: t }, async (tx) => {
      for (let i = 0; i < 3; i++) {
        const s = await f("siguienteDisponible")(tx, "sire", new Date());
        secuencia.push(s.id);
        await tx.query("update job_registro set estado = 'ejecutando' where id = $1", [s.id]); // lo saca de la cola
      }
      secuencia.push(await f("siguienteDisponible")(tx, "sire", new Date()));
    });
    expect(secuencia).toEqual([interViejo, interNuevo, progViejo, null]);
    // El de disponible_desde futuro aparece cuando `ahora` lo alcanza.
    const futuro = await w.withTenant({ tenantId: t }, (tx) => f("siguienteDisponible")(tx, "sire", new Date(Date.now() + 2 * 3600_000)));
    expect(futuro?.id).toBe(futuroId);
  });

  it("no ve los trabajos de otro estudio y devuelve null con la cola vacia", async () => {
    const { t, c } = await estudioNuevo();
    const otro = await estudioNuevo();
    await et.job(otro.t, otro.c);
    const r = await worker().withTenant({ tenantId: t }, (tx) => f("siguienteDisponible")(tx, "sire", new Date()));
    expect(r).toBeNull();
    const id = await et.job(t, c);
    const r2 = await worker().withTenant({ tenantId: t }, (tx) => f("siguienteDisponible")(tx, "sire", new Date()));
    expect(r2.id).toBe(id);
  });
});

// =================================================================================================
describe("transicionar: ganador unico por UPDATE ... WHERE estado = desde (CA-7, D2)", () => {
  it("en_cola -> ejecutando fija iniciadoEn y actualizadoEn; repetirla devuelve false", async () => {
    const id = await et.job(X, cx);
    const w = worker();
    const antes = await et.fila(id);
    const r = await w.withTenant({ tenantId: X }, async (tx) => {
      const a = await f("transicionar")(tx, id, "en_cola", "ejecutando");
      const b = await f("transicionar")(tx, id, "en_cola", "ejecutando");
      return { a, b, fila: await f("leerTrabajo")(tx, id) };
    });
    expect(r.a).toBe(true);
    expect(r.b).toBe(false);
    expect(r.fila.estado).toBe("ejecutando");
    expect(r.fila.iniciadoEn).toBeInstanceOf(Date);
    expect(r.fila.terminadoEn).toBeNull();
    expect(r.fila.actualizadoEn.getTime()).toBeGreaterThanOrEqual(antes.actualizado_en.getTime());
  });

  it("con `desde` equivocado devuelve false y no cambia nada", async () => {
    const id = await et.job(X, cx, { estado: "ejecutando" });
    const r = await worker().withTenant({ tenantId: X }, async (tx) => ({
      ok: await f("transicionar")(tx, id, "en_cola", "cancelado", { motivo: "cancelado_usuario" }),
      fila: await f("leerTrabajo")(tx, id),
    }));
    expect(r.ok).toBe(false);
    expect(r.fila).toMatchObject({ estado: "ejecutando", motivo: null, terminadoEn: null });
  });

  it("ejecutando -> completado guarda el resultado y terminadoEn", async () => {
    const id = await et.job(X, cx, { estado: "ejecutando" });
    const r = await worker().withTenant({ tenantId: X }, async (tx) => {
      const ok = await f("transicionar")(tx, id, "ejecutando", "completado", { resultado: { filas: 12 } });
      return { ok, fila: await f("leerTrabajo")(tx, id) };
    });
    expect(r.ok).toBe(true);
    expect(r.fila).toMatchObject({ estado: "completado", resultado: { filas: 12 }, motivo: null });
    expect(r.fila.terminadoEn).toBeInstanceOf(Date);
  });

  it("ejecutando -> error guarda motivo e intentos", async () => {
    const id = await et.job(X, cx, { estado: "ejecutando", intentos: 2 });
    const r = await worker().withTenant({ tenantId: X }, async (tx) => {
      const ok = await f("transicionar")(tx, id, "ejecutando", "error", { motivo: "sunat_no_responde", intentos: 3 });
      return { ok, fila: await f("leerTrabajo")(tx, id) };
    });
    expect(r.ok).toBe(true);
    expect(r.fila).toMatchObject({ estado: "error", motivo: "sunat_no_responde", intentos: 3 });
    expect(r.fila.terminadoEn).toBeInstanceOf(Date);
  });

  it("ejecutando -> en_cola (reintento) fija intentos y disponibleDesde y no marca terminadoEn", async () => {
    const id = await et.job(X, cx, { estado: "ejecutando", intentos: 1 });
    const luego = new Date(Date.now() + 20_000);
    const r = await worker().withTenant({ tenantId: X }, async (tx) => {
      const ok = await f("transicionar")(tx, id, "ejecutando", "en_cola", { intentos: 2, disponibleDesde: luego });
      return { ok, fila: await f("leerTrabajo")(tx, id) };
    });
    expect(r.ok).toBe(true);
    expect(r.fila).toMatchObject({ estado: "en_cola", intentos: 2, terminadoEn: null });
    expect(Math.abs(r.fila.disponibleDesde.getTime() - luego.getTime())).toBeLessThan(1000);
  });

  it("el backend cancela en_cola -> cancelado (cancelado_usuario) pero no puede pasar a ejecutando (42501)", async () => {
    const a = await et.job(X, cx);
    const b = await et.job(X, cx);
    const Error_ = exportado<new (...x: any[]) => Error & { codigo: string }>("TrabajosRepoError");
    const r = await backend().withTenant({ tenantId: X }, async (tx) => {
      const ok = await f("transicionar")(tx, a, "en_cola", "cancelado", { motivo: "cancelado_usuario" });
      const fila = await f("leerTrabajo")(tx, a);
      return { ok, fila };
    });
    expect(r.ok).toBe(true);
    expect(r.fila).toMatchObject({ estado: "cancelado", motivo: "cancelado_usuario" });
    expect(r.fila.terminadoEn).toBeInstanceOf(Date);
    await expect(
      backend().withTenant({ tenantId: X }, (tx) => f("transicionar")(tx, b, "en_cola", "ejecutando")),
    ).rejects.toSatisfy((e: unknown) => e instanceof Error_ && (e as { codigo: string }).codigo === "42501");
    expect((await et.fila(b)).estado).toBe("en_cola");
  });

  it("id inexistente o de otro estudio -> false", async () => {
    const ajeno = await et.job(Y, cy);
    const r = await worker().withTenant({ tenantId: X }, async (tx) => ({
      ajeno: await f("transicionar")(tx, ajeno, "en_cola", "ejecutando"),
      nada: await f("transicionar")(tx, "00000000-0000-4000-8000-000000000000", "en_cola", "ejecutando"),
    }));
    expect(r).toEqual({ ajeno: false, nada: false });
    expect((await et.fila(ajeno)).estado).toBe("en_cola");
  });

  it("carrera cancelar (backend) vs despachar (worker): exactamente un ganador y el estado final es coherente", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await et.job(X, cx);
      const [cancel, despacho] = await Promise.all([
        backend().withTenant({ tenantId: X }, (tx) => f("transicionar")(tx, id, "en_cola", "cancelado", { motivo: "cancelado_usuario" })),
        worker().withTenant({ tenantId: X }, (tx) => f("transicionar")(tx, id, "en_cola", "ejecutando")),
      ]);
      expect([cancel, despacho].filter(Boolean), `vuelta ${i}`).toHaveLength(1);
      expect((await et.fila(id)).estado).toBe(cancel ? "cancelado" : "ejecutando");
    }
  });

  it("20 despachadores simultaneos sobre el mismo trabajo: uno solo lo toma", async () => {
    const id = await et.job(X, cx);
    const w = dbDe("contapp_worker", 8);
    const r = await Promise.all(
      Array.from({ length: 20 }, () => w.withTenant({ tenantId: X }, (tx) => f("transicionar")(tx, id, "en_cola", "ejecutando"))),
    );
    expect(r.filter(Boolean)).toHaveLength(1);
  });
});

// =================================================================================================
describe("leerTrabajo, listarTrabajos y posicion (CA-5)", () => {
  it("leerTrabajo devuelve la fila propia; null si es de otro estudio o no existe; un id mal formado falla con TrabajosRepoError 22P02", async () => {
    const propio = await et.job(X, cx);
    const ajeno = await et.job(Y, cy);
    const Error_ = exportado<new (...x: any[]) => Error & { codigo: string }>("TrabajosRepoError");
    const r = await backend().withTenant({ tenantId: X }, async (tx) => ({
      propio: await f("leerTrabajo")(tx, propio),
      ajeno: await f("leerTrabajo")(tx, ajeno),
      nada: await f("leerTrabajo")(tx, "00000000-0000-4000-8000-000000000000"),
    }));
    expect(r.propio.id).toBe(propio);
    expect(r.ajeno).toBeNull();
    expect(r.nada).toBeNull();
    await expect(backend().withTenant({ tenantId: X }, (tx) => f("leerTrabajo")(tx, "no-es-uuid"))).rejects.toSatisfy(
      (e: unknown) => e instanceof Error_ && (e as { codigo: string }).codigo === "22P02",
    );
  });

  it("listarTrabajos: alcance global ve todo el estudio (y solo el estudio), del mas nuevo al mas viejo", async () => {
    const { t, c } = await estudioNuevo();
    const otro = await estudioNuevo();
    const viejo = await et.job(t, c, { hace: 300 });
    const medio = await et.job(t, c, { hace: 200, estado: "completado" });
    const nuevo_ = await et.job(t, c, { hace: 100, estado: "error", motivo: "sunat_no_responde" });
    const ajeno = await et.job(otro.t, otro.c);
    const r = await backend().withTenant({ tenantId: t }, (tx) => f("listarTrabajos")(tx, GLOBAL, {}));
    expect(r.map((x: { id: string }) => x.id)).toEqual([nuevo_, medio, viejo]);
    expect(r.map((x: { id: string }) => x.id)).not.toContain(ajeno);
  });

  it("listarTrabajos con filtros de clienteId y estado; y con un clienteId ajeno devuelve []", async () => {
    const { t, c } = await estudioNuevo();
    const c2 = await et.cliente(t);
    const otro = await estudioNuevo();
    const a = await et.job(t, c, { estado: "completado", hace: 50 });
    const b = await et.job(t, c2, { hace: 40 });
    await et.job(t, c2, { estado: "completado", hace: 30 });
    const r = await backend().withTenant({ tenantId: t }, async (tx) => ({
      porCliente: (await f("listarTrabajos")(tx, GLOBAL, { clienteId: c2.id })).length,
      porEstado: (await f("listarTrabajos")(tx, GLOBAL, { estado: "completado" })).map((x: { id: string }) => x.id),
      ambos: (await f("listarTrabajos")(tx, GLOBAL, { clienteId: c2.id, estado: "en_cola" })).map((x: { id: string }) => x.id),
      ajeno: await f("listarTrabajos")(tx, GLOBAL, { clienteId: otro.c.id }),
    }));
    expect(r.porCliente).toBe(2);
    expect(r.porEstado).toHaveLength(2);
    expect(r.porEstado).toContain(a);
    expect(r.ambos).toEqual([b]);
    expect(r.ajeno).toEqual([]);
  });

  it("listarTrabajos con alcance asignado: solo los clientes del usuario; sin asignaciones, nada", async () => {
    const { t, c } = await estudioNuevo();
    const c2 = await et.cliente(t);
    const u = (await et.miembro(t, "asistente")).id;
    const sin = (await et.miembro(t, "asistente")).id;
    await et.asignar(t, c.id, u);
    const visible = await et.job(t, c);
    await et.job(t, c2);
    const db = backend();
    const r = await db.withTenant({ tenantId: t }, async (tx) => ({
      u: (await f("listarTrabajos")(tx, { tipo: "asignado", usuarioId: u }, {})).map((x: { id: string }) => x.id),
      sin: await f("listarTrabajos")(tx, { tipo: "asignado", usuarioId: sin }, {}),
      noAsignado: await f("listarTrabajos")(tx, { tipo: "asignado", usuarioId: u }, { clienteId: c2.id }),
    }));
    expect(r.u).toEqual([visible]);
    expect(r.sin).toEqual([]);
    expect(r.noAsignado).toEqual([]);
  });

  it("listarTrabajos devuelve como maximo 100 filas, las mas nuevas", async () => {
    const { t, c } = await estudioNuevo();
    await admin.query(
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, max_intentos, creado_en)
       select $1, $2, $3, 'prueba.eco', 'sire', 'sire', 'interactivo', 'completado', '{}'::jsonb, decode(md5(g::text || random()::text) || md5(random()::text || g::text), 'hex'), 3, now() - make_interval(secs => g)
         from generate_series(1, 105) g`,
      [t, c.id, c.ruc],
    );
    const r = await backend().withTenant({ tenantId: t }, (tx) => f("listarTrabajos")(tx, GLOBAL, {}));
    expect(r).toHaveLength(100);
    const fechas = r.map((x: { creadoEn: string }) => Date.parse(x.creadoEn));
    expect(fechas).toEqual([...fechas].sort((a, b) => b - a));
  });

  it("posicion: 1 + los en_cola del mismo estudio y cola que salen antes; null si no esta en_cola; no cuenta otros estudios ni colas", async () => {
    const { t, c } = await estudioNuevo();
    const otro = await estudioNuevo();
    const p1 = await et.job(t, c, { prioridad: "programado", hace: 900 });
    const i1 = await et.job(t, c, { prioridad: "interactivo", hace: 100 });
    const i2 = await et.job(t, c, { prioridad: "interactivo", hace: 50 });
    const p2 = await et.job(t, c, { prioridad: "programado", hace: 400 });
    const ejec = await et.job(t, c, { estado: "ejecutando", hace: 2000 });
    await et.job(t, c, { cola: "sol", canal: "sol", hace: 3000 });
    await et.job(otro.t, otro.c, { prioridad: "interactivo", hace: 5000 });
    const r = await backend().withTenant({ tenantId: t }, async (tx) => {
      const out: Record<string, number | null> = {};
      for (const [k, id] of Object.entries({ i1, i2, p1, p2, ejec })) out[k] = await f("posicion")(tx, id);
      return out;
    });
    expect(r).toEqual({ i1: 1, i2: 2, p1: 3, p2: 4, ejec: null });
  });

  it("posicion de un id ajeno o inexistente es null (no se filtra informacion de otros estudios)", async () => {
    const ajeno = await et.job(Y, cy);
    const r = await backend().withTenant({ tenantId: X }, async (tx) => ({
      ajeno: await f("posicion")(tx, ajeno),
      nada: await f("posicion")(tx, "00000000-0000-4000-8000-000000000000"),
    }));
    expect(r).toEqual({ ajeno: null, nada: null });
  });
});

// =================================================================================================
describe("purgarTerminados (D16, CA-13)", () => {
  it("borra los terminados con terminado_en anterior al corte, en el estudio del contexto, y devuelve cuantos", async () => {
    const { t, c } = await estudioNuevo();
    const otro = await estudioNuevo();
    const viejos = [
      await et.job(t, c, { estado: "completado", hace: 100 * 86400 }),
      await et.job(t, c, { estado: "error", hace: 95 * 86400, motivo: "sunat_no_responde" }),
      await et.job(t, c, { estado: "cancelado", hace: 91 * 86400, motivo: "cancelado_usuario" }),
    ];
    const recien = await et.job(t, c, { estado: "completado", hace: 10 * 86400 });
    const vivoViejo = await et.job(t, c, { estado: "ejecutando", hace: 200 * 86400 });
    const colaVieja = await et.job(t, c, { estado: "en_cola", hace: 200 * 86400 });
    const ajeno = await et.job(otro.t, otro.c, { estado: "completado", hace: 100 * 86400 });
    const corte = new Date(Date.now() - 90 * 86400_000);
    const n = await worker().withTenant({ tenantId: t }, (tx) => f("purgarTerminados")(tx, corte));
    expect(n).toBe(3);
    for (const id of viejos) expect(await et.fila(id), `borrado ${id}`).toBeUndefined();
    for (const id of [recien, vivoViejo, colaVieja, ajeno]) expect(await et.fila(id), `intacto ${id}`).toBeDefined();
  });

  it("el backend no puede purgar (TrabajosRepoError 42501)", async () => {
    const Error_ = exportado<new (...x: any[]) => Error & { codigo: string }>("TrabajosRepoError");
    await expect(backend().withTenant({ tenantId: X }, (tx) => f("purgarTerminados")(tx, new Date()))).rejects.toSatisfy(
      (e: unknown) => e instanceof Error_ && (e as { codigo: string }).codigo === "42501",
    );
  });
});

// =================================================================================================
describe("revalidarEncolado (D17, CA-14)", () => {
  const revalida = (tenantId: string, args: object) => worker().withTenant({ tenantId }, (tx) => f("revalidarEncolado")(tx, args));
  const TODOS = ["dueno", "admin", "contador", "asistente", "lectura"];

  it("programado (creadoPor null): solo exige que el cliente exista", async () => {
    expect(await revalida(X, { clienteId: cx.id, creadoPor: null, rolesPermitidos: ["dueno"] })).toBe("ok");
    expect(await revalida(X, { clienteId: "00000000-0000-4000-8000-000000000000", creadoPor: null, rolesPermitidos: null })).toBe("acceso_retirado");
    expect(await revalida(X, { clienteId: cy.id, creadoPor: null, rolesPermitidos: null })).toBe("acceso_retirado"); // cliente de otro estudio
  });

  it("Dueño y Administrador con permiso: alcance global (ven todos los clientes) sin asignacion", async () => {
    for (const u of [dueno, admin1]) {
      expect(await revalida(X, { clienteId: cx.id, creadoPor: u, rolesPermitidos: TODOS })).toBe("ok");
    }
  });

  it("contador y asistente solo con asignacion al cliente; sin ella, acceso_retirado", async () => {
    const { t, c } = await estudioNuevo();
    const cont = (await et.miembro(t, "contador")).id;
    const asis = (await et.miembro(t, "asistente")).id;
    for (const u of [cont, asis]) {
      expect(await revalida(t, { clienteId: c.id, creadoPor: u, rolesPermitidos: TODOS }), `sin asignar ${u}`).toBe("acceso_retirado");
      await et.asignar(t, c.id, u, "colaborador");
      expect(await revalida(t, { clienteId: c.id, creadoPor: u, rolesPermitidos: TODOS }), `asignado ${u}`).toBe("ok");
    }
  });

  it("el rol debe estar entre los permitidos del tipo (p. ej. lectura no puede encolar)", async () => {
    expect(await revalida(X, { clienteId: cx.id, creadoPor: lectura, rolesPermitidos: ["dueno", "admin", "contador"] })).toBe("acceso_retirado");
    expect(await revalida(X, { clienteId: cx.id, creadoPor: dueno, rolesPermitidos: ["contador"] })).toBe("acceso_retirado");
    // rolesPermitidos null = el tipo no pide permiso: basta ser miembro activo con alcance.
    expect(await revalida(X, { clienteId: cx.id, creadoPor: dueno, rolesPermitidos: null })).toBe("ok");
  });

  it("membresia desactivada, usuario de otro estudio o inexistente -> acceso_retirado", async () => {
    const { t, c } = await estudioNuevo();
    const inactivo = (await et.miembro(t, "dueno", { desactivada: true })).id;
    expect(await revalida(t, { clienteId: c.id, creadoPor: inactivo, rolesPermitidos: TODOS })).toBe("acceso_retirado");
    expect(await revalida(X, { clienteId: cx.id, creadoPor: usuarioY, rolesPermitidos: TODOS })).toBe("acceso_retirado");
    expect(await revalida(X, { clienteId: cx.id, creadoPor: "00000000-0000-4000-8000-000000000000", rolesPermitidos: TODOS })).toBe("acceso_retirado");
  });

  it("revalida el estado ACTUAL: desasignar o cambiar el rol despues de encolar retira el acceso", async () => {
    const { t, c } = await estudioNuevo();
    await et.miembro(t, "dueno"); // el trigger del ultimo Dueño (005) exige otro Dueño activo para degradar a `u` despues
    const u = (await et.miembro(t, "contador")).id;
    await et.asignar(t, c.id, u);
    expect(await revalida(t, { clienteId: c.id, creadoPor: u, rolesPermitidos: TODOS })).toBe("ok");
    await admin.query("delete from asignacion where tenant_id = $1 and usuario_id = $2", [t, u]);
    expect(await revalida(t, { clienteId: c.id, creadoPor: u, rolesPermitidos: TODOS })).toBe("acceso_retirado");
    await admin.query("update membresia set rol = 'dueno' where tenant_id = $1 and usuario_id = $2", [t, u]);
    expect(await revalida(t, { clienteId: c.id, creadoPor: u, rolesPermitidos: TODOS })).toBe("ok"); // ahora es global
    await admin.query("update membresia set rol = 'lectura' where tenant_id = $1 and usuario_id = $2", [t, u]);
    expect(await revalida(t, { clienteId: c.id, creadoPor: u, rolesPermitidos: ["dueno", "admin", "contador"] })).toBe("acceso_retirado");
  });

  it("no bloquea filas: corre sin FOR UPDATE (otra transaccion con la membresia bloqueada no la detiene)", async () => {
    const bloqueador = await admin.connect();
    try {
      await bloqueador.query("BEGIN");
      await bloqueador.query("select 1 from membresia where tenant_id = $1 and usuario_id = $2 for update", [X, dueno]);
      await bloqueador.query("select 1 from asignacion where tenant_id = $1 for update", [X]);
      const r = await Promise.race([
        revalida(X, { clienteId: cx.id, creadoPor: dueno, rolesPermitidos: TODOS }),
        new Promise((res) => setTimeout(() => res("bloqueado"), 3000)),
      ]);
      expect(r).toBe("ok");
    } finally {
      await bloqueador.query("ROLLBACK").catch(() => undefined);
      bloqueador.release();
    }
  });
});

// =================================================================================================
describe("marcarCredencialInvalida y estadoCredencial (D13, CA-9)", () => {
  it("el worker marca invalida una sola vez (true, luego false) y el backend lee el estado", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id, "sol");
    const w = worker();
    const r = await w.withTenant({ tenantId: X }, async (tx) => ({
      antes: await f("estadoCredencial")(tx, cli.id, "sol"),
      a: await f("marcarCredencialInvalida")(tx, cli.id, "sol", "credencial_invalida"),
      b: await f("marcarCredencialInvalida")(tx, cli.id, "sol", "credencial_invalida"),
    }));
    expect(r.antes).toBe("configurada");
    expect([r.a, r.b]).toEqual([true, false]);
    const leido = await backend().withTenant({ tenantId: X }, (tx) => f("estadoCredencial")(tx, cli.id, "sol"));
    expect(leido).toBe("invalida");
    const fila = (await admin.query("select estado, estado_motivo, estado_at from credencial where id = $1", [id])).rows[0];
    expect(fila.estado).toBe("invalida");
    expect(fila.estado_motivo).toBe("credencial_invalida");
    expect(fila.estado_at).toBeInstanceOf(Date);
  });

  it("solo toca el tipo indicado (sol vs sire_api) y el cliente indicado", async () => {
    const cli = await et.cliente(X);
    const otro = await et.cliente(X);
    await et.credencial(X, cli.id, "sol");
    await et.credencial(X, cli.id, "sire_api");
    await et.credencial(X, otro.id, "sol");
    const r = await worker().withTenant({ tenantId: X }, async (tx) => {
      await f("marcarCredencialInvalida")(tx, cli.id, "sol", "credencial_invalida");
      return {
        sol: await f("estadoCredencial")(tx, cli.id, "sol"),
        sire: await f("estadoCredencial")(tx, cli.id, "sire_api"),
        otro: await f("estadoCredencial")(tx, otro.id, "sol"),
      };
    });
    expect(r).toEqual({ sol: "invalida", sire: "configurada", otro: "configurada" });
  });

  it("sin credencial: marcar devuelve false y estadoCredencial null; un cliente de otro estudio no se toca", async () => {
    const sinCred = await et.cliente(X);
    const credY = await et.credencial(Y, cy.id, "sol");
    const r = await worker().withTenant({ tenantId: X }, async (tx) => ({
      marca: await f("marcarCredencialInvalida")(tx, sinCred.id, "sol", "credencial_invalida"),
      estado: await f("estadoCredencial")(tx, sinCred.id, "sol"),
      ajeno: await f("marcarCredencialInvalida")(tx, cy.id, "sol", "credencial_invalida"),
    }));
    expect(r).toEqual({ marca: false, estado: null, ajeno: false });
    expect((await admin.query("select estado from credencial where id = $1", [credY])).rows[0].estado).toBe("configurada");
  });

  it("reemplazar el ciphertext (guardarSobre) la devuelve a 'configurada' y marcarla de nuevo vuelve a dar true", async () => {
    const cli = await et.cliente(X);
    await et.credencial(X, cli.id, "sol");
    const w = worker();
    await w.withTenant({ tenantId: X }, (tx) => f("marcarCredencialInvalida")(tx, cli.id, "sol", "credencial_invalida"));
    await backend().withTenant({ tenantId: X }, (tx) =>
      f("guardarSobre")(tx, {
        clienteId: cli.id,
        tipo: "sol",
        sobre: { ciphertext: randomBytes(64), nonce: randomBytes(12), tag: randomBytes(16), dekEnvuelta: randomBytes(512), kekId: "k1", version: 1 },
      }),
    );
    const e = await backend().withTenant({ tenantId: X }, (tx) => f("estadoCredencial")(tx, cli.id, "sol"));
    expect(e).toBe("configurada");
    expect(await w.withTenant({ tenantId: X }, (tx) => f("marcarCredencialInvalida")(tx, cli.id, "sol", "credencial_invalida"))).toBe(true);
  });

  it("el backend no puede marcar (TrabajosRepoError/CredencialRepoError 42501)", async () => {
    const cli = await et.cliente(X);
    await et.credencial(X, cli.id, "sol");
    await expect(
      backend().withTenant({ tenantId: X }, (tx) => f("marcarCredencialInvalida")(tx, cli.id, "sol", "credencial_invalida")),
    ).rejects.toMatchObject({ codigo: "42501" });
  });
});

// =================================================================================================
describe("repos de withSistema: leerConfig, estudiosIds, estudiosConTrabajos y purgarAuth (D16, D18, CA-4, CA-12, CA-13)", () => {
  let sis: SistemaDb;
  beforeAll(() => {
    sis = conSistema("contapp_worker", 2);
    dbs.push(sis);
  });

  it("leerConfig devuelve un Map por cola con los limites de D12 en camelCase", async () => {
    const m = await sis.withSistema((tx) => f("leerConfig")(tx));
    expect(m).toBeInstanceOf(Map);
    expect(m.get("sire")).toMatchObject({ cola: "sire", concurrenciaGlobal: 4, concurrenciaTenant: 2, esperaRucMs: 2000, reintentos: 3, backoffBaseMs: 5000, maxPendientesTenant: 2000 });
    expect(m.get("sol")).toMatchObject({ concurrenciaGlobal: 2, concurrenciaTenant: 1 });
    expect(m.get("xml")).toMatchObject({ concurrenciaGlobal: 8, concurrenciaTenant: 4 });
    for (const v of m.values()) for (const k of ["concurrenciaGlobal", "concurrenciaTenant", "esperaRucMs", "reintentos", "backoffBaseMs", "maxPendientesTenant"]) {
      expect(typeof v[k], `${v.cola}.${k}`).toBe("number");
    }
  });

  it("estudiosIds devuelve solo UUID de todos los estudios; sin contexto de estudio no ve filas de negocio", async () => {
    const ids = await sis.withSistema((tx) => f("estudiosIds")(tx));
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) expect(typeof id === "string" && UUID.test(id), String(id)).toBe(true);
    expect(ids).toEqual(expect.arrayContaining([X, Y]));
    const todos = (await admin.query("select id from tenant")).rows.map((r) => r.id as string);
    expect([...ids].sort()).toEqual(todos.sort());
  });

  it("estudiosConTrabajos(estados, antiguedadSeg) lista los estudios con trabajos en esos estados y esa antiguedad", async () => {
    const { t, c } = await estudioNuevo();
    const reciente = await estudioNuevo();
    await et.job(t, c, { estado: "en_cola", hace: 900 });
    await et.job(reciente.t, reciente.c, { estado: "en_cola", hace: 0 });
    const r = await sis.withSistema(async (tx) => ({
      viejos: await f("estudiosConTrabajos")(tx, ["en_cola"], 300),
      todos: await f("estudiosConTrabajos")(tx, ["en_cola"], 0),
      otroEstado: await f("estudiosConTrabajos")(tx, ["ejecutando"], 300),
    }));
    expect(r.viejos).toContain(t);
    expect(r.viejos).not.toContain(reciente.t);
    expect(r.todos).toEqual(expect.arrayContaining([t, reciente.t]));
    expect(r.otroEstado).not.toContain(t);
  });

  it("purgarAuth aplica las retenciones en dias y devuelve los 4 conteos como numeros; una retencion < 1 dia lanza TrabajosRepoError", async () => {
    const cuenta = await et.ea.cuenta();
    const vieja = (
      await admin.query(
        `insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta, revocada_en, motivo)
         values ($1, $2, now() - interval '500 days', now() - interval '500 days', now() + interval '1 day', now() - interval '400 days', 'logout') returning id`,
        [randomBytes(32), cuenta.id],
      )
    ).rows[0].id as string;
    const reciente = (
      await admin.query(
        `insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta, revocada_en, motivo)
         values ($1, $2, now() - interval '5 days', now() - interval '5 days', now() + interval '1 day', now() - interval '2 days', 'logout') returning id`,
        [randomBytes(32), cuenta.id],
      )
    ).rows[0].id as string;
    // Retenciones enormes salvo la de sesion (365 dias): solo la sesion revocada hace 400 dias cae.
    const r = await sis.withSistema((tx) => f("purgarAuth")(tx, { sesionDias: 365, tokenDias: 36500, intentoDias: 36500, limiteDias: 36500 }));
    expect(Object.keys(r).sort()).toEqual(["intentos", "limites", "sesiones", "tokens"]);
    for (const v of Object.values(r)) expect(typeof v).toBe("number");
    expect(r.sesiones).toBeGreaterThanOrEqual(1);
    expect((await admin.query("select 1 from auth.sesion where id = $1", [vieja])).rowCount).toBe(0);
    expect((await admin.query("select 1 from auth.sesion where id = $1", [reciente])).rowCount).toBe(1);
    const Error_ = exportado<new (...x: any[]) => Error & { codigo: string }>("TrabajosRepoError");
    await expect(sis.withSistema((tx) => f("purgarAuth")(tx, { sesionDias: 0, tokenDias: 7, intentoDias: 90, limiteDias: 1 }))).rejects.toBeInstanceOf(Error_);
  });
});
