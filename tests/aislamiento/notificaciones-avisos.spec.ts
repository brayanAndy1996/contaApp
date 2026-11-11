// Spec 017 (T3, rojo): avisos de credencial invalida (CA-8, HU-10, P-4) y de trabajo terminado (CA-9, P-3) contra la BD
// real. La notificacion la crea un trigger SECURITY DEFINER en la misma transaccion del hecho (D-9): si el hecho se
// confirma, la notificacion existe; si se revierte, no. Contrato en notificaciones-soporte.ts. Falla hoy por tabla
// `notificacion` ausente (0043 de T7). El aviso en vivo (Redis) y la muerte del worker son de T4.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import { enRollback } from "./soporte";
import {
  abrirAdmin,
  crearDb,
  EscenarioNotif,
  exportado,
  sobreFalso,
  UUID,
  type ClientePrueba,
} from "./notificaciones-soporte";

type Fn = (...a: any[]) => Promise<any>;
const f = (nombre: string) => exportado<Fn>(nombre);

let admin: Pool;
let en: EscenarioNotif;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let dueno: string;
let dueno2: string;
let adm: string;
let contador: string;
let responsable: string;
let asistente: string;
let desactivado: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  en = new EscenarioNotif(admin);
  X = (await en.estudio()).id;
  dueno = (await en.et.miembro(X, "dueno")).id;
  dueno2 = (await en.et.miembro(X, "dueno")).id;
  adm = (await en.et.miembro(X, "admin")).id;
  contador = (await en.et.miembro(X, "contador")).id;
  responsable = (await en.et.miembro(X, "contador")).id;
  asistente = (await en.et.miembro(X, "asistente")).id;
  desactivado = (await en.et.miembro(X, "admin", { desactivada: true })).id;
  backend = crearDb("contapp_backend", 6);
  worker = crearDb("contapp_worker", 6);
});
afterAll(async () => {
  await en?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const invalidar = (c: ClientePrueba, tipo: "sol" | "sire_api" = "sol", ctx: object = {}): Promise<boolean> =>
  worker.withTenant({ tenantId: X, ...ctx }, (tx) => f("marcarCredencialInvalida")(tx, c.id, tipo, "credencial_invalida"));
const destinatarios = async (clienteId: string, tipo = "credencial_invalida"): Promise<string[]> =>
  (await en.notifs(X, { clienteId, tipo })).map((n) => n.usuario_id).sort();
const ordenados = (...v: string[]) => [...v].sort();

// =================================================================================================
describe("CA-8 · credencial invalida -> notificacion (HU-10, P-4)", () => {
  it("con responsable activo: una notificacion solo para el responsable, con tipo, cliente y params", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, responsable, "responsable");
    await en.et.asignar(X, c.id, contador, "colaborador");
    const credId = await en.et.credencial(X, c.id, "sol");
    expect(await invalidar(c)).toBe(true);
    const ns = await en.notifs(X, { clienteId: c.id });
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({
      usuario_id: responsable,
      tipo: "credencial_invalida",
      cliente_id: c.id,
      trabajo_id: null,
      leida_en: null,
      params: { credencial: "sol" },
    });
    expect(ns[0].id).toMatch(UUID);
    expect(ns[0].clave_dedupe.startsWith(`credencial_invalida:${credId}:`)).toBe(true);
    expect(Object.keys(ns[0].params)).toEqual(["credencial"]);
  });

  it("sin responsable: a los Duenos y Administradores ACTIVOS, no a desactivados ni a otros roles", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, contador, "colaborador"); // un colaborador no es responsable
    await en.et.credencial(X, c.id, "sol");
    expect(await invalidar(c)).toBe(true);
    expect(await destinatarios(c.id)).toEqual(ordenados(dueno, dueno2, adm));
    expect(await destinatarios(c.id)).not.toContain(desactivado);
    expect(await destinatarios(c.id)).not.toContain(asistente);
    expect(await destinatarios(c.id)).not.toContain(contador);
  });

  it("responsable desactivado: no cuenta, se avisa a los Duenos y Administradores activos", async () => {
    const baja = (await en.et.miembro(X, "contador", { desactivada: true })).id;
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, baja, "responsable");
    await en.et.credencial(X, c.id, "sire_api");
    expect(await invalidar(c, "sire_api")).toBe(true);
    expect(await destinatarios(c.id)).toEqual(ordenados(dueno, dueno2, adm));
    const ns = await en.notifs(X, { clienteId: c.id });
    expect(ns.every((n) => n.params.credencial === "sire_api")).toBe(true);
  });

  it("si la transaccion se revierte, no hay notificacion ni cambio de estado", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, responsable, "responsable");
    const credId = await en.et.credencial(X, c.id, "sol");
    const marcada = await enRollback(worker, { tenantId: X }, (tx) =>
      f("marcarCredencialInvalida")(tx, c.id, "sol", "credencial_invalida"),
    );
    expect(marcada).toBe(true);
    expect(await en.notifs(X, { clienteId: c.id })).toHaveLength(0);
    expect((await admin.query("select estado from credencial where id = $1", [credId])).rows[0].estado).toBe("configurada");
  });

  it("un fallo repetido con la credencial aun invalida no crea otra", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, responsable, "responsable");
    await en.et.credencial(X, c.id, "sol");
    expect(await invalidar(c)).toBe(true);
    expect(await invalidar(c)).toBe(false);
    expect(await invalidar(c)).toBe(false);
    expect(await en.notifs(X, { clienteId: c.id })).toHaveLength(1);
  });

  it("al reemplazar la credencial y volver a invalidarla se crea una nueva (clave distinta)", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, responsable, "responsable");
    await en.et.credencial(X, c.id, "sol");
    expect(await invalidar(c)).toBe(true);
    await backend.withTenant({ tenantId: X, userId: dueno }, (tx) =>
      f("guardarSobre")(tx, { clienteId: c.id, tipo: "sol", sobre: sobreFalso() }),
    );
    expect(await invalidar(c)).toBe(true);
    const ns = await en.notifs(X, { clienteId: c.id });
    expect(ns).toHaveLength(2);
    expect(new Set(ns.map((n) => n.clave_dedupe)).size).toBe(2);
    expect(ns.every((n) => n.usuario_id === responsable)).toBe(true);
  });

  it("una credencial por tipo: la del otro tipo avisa aparte", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, responsable, "responsable");
    await en.et.credencial(X, c.id, "sol");
    await en.et.credencial(X, c.id, "sire_api");
    expect(await invalidar(c, "sol")).toBe(true);
    expect(await invalidar(c, "sire_api")).toBe(true);
    const tipos = (await en.notifs(X, { clienteId: c.id })).map((n) => n.params.credencial).sort();
    expect(tipos).toEqual(["sire_api", "sol"]);
  });

  it("dentro de un trabajo (contexto del worker con trabajoId) la notificacion lleva ese trabajo", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, responsable, "responsable");
    await en.et.credencial(X, c.id, "sol");
    const job = await en.et.job(X, c, { estado: "ejecutando", creadoPor: responsable, tipo: "sire.propuesta.descargar" });
    expect(await invalidar(c, "sol", { trabajoId: job })).toBe(true);
    const ns = await en.notifs(X, { clienteId: c.id, tipo: "credencial_invalida" });
    expect(ns).toHaveLength(1);
    expect(ns[0].trabajo_id).toBe(job);
  });

  it("verificar la credencial no crea ninguna notificacion", async () => {
    const c = await en.et.cliente(X);
    await en.et.asignar(X, c.id, responsable, "responsable");
    await en.et.credencial(X, c.id, "sol");
    const v = await worker.withTenant({ tenantId: X }, (tx) => f("versionCredencial")(tx, c.id, "sol"));
    expect(await worker.withTenant({ tenantId: X }, (tx) => f("marcarCredencialVerificada")(tx, c.id, "sol", v))).toBe(true);
    expect(await en.notifs(X, { clienteId: c.id })).toHaveLength(0);
  });

  it("el aviso no lleva secretos: params solo con el tipo de credencial", async () => {
    const c = await en.et.cliente(X);
    await en.et.credencial(X, c.id, "sol");
    expect(await invalidar(c)).toBe(true);
    const ns = await en.notifs(X, { clienteId: c.id });
    expect(ns.length).toBeGreaterThan(0);
    for (const n of ns) {
      const texto = JSON.stringify(n);
      expect(texto).not.toMatch(/ciphertext|nonce|dek|clave_sol|client_secret|password/i);
      expect(Object.keys(n.params)).toEqual(["credencial"]);
    }
  });
});

// =================================================================================================
describe("CA-9 · trabajo terminado -> notificacion (P-3)", () => {
  const transicionar = (db: ContappDb, id: string, desde: string, hacia: string, campos: object = {}): Promise<boolean> =>
    db.withTenant({ tenantId: X }, (tx) => f("transicionar")(tx, id, desde, hacia, campos));
  const deTrabajo = async (id: string) => (await en.notifs(X, { tipo: "trabajo_terminado" })).filter((n) => n.trabajo_id === id);
  const ensayo = async (o: { prioridad?: string; creadoPor?: string | null; estado?: string; tipo?: string } = {}) => {
    const c = await en.et.cliente(X);
    const id = await en.et.job(X, c, {
      estado: o.estado ?? "ejecutando",
      prioridad: o.prioridad ?? "interactivo",
      creadoPor: o.creadoPor === undefined ? contador : o.creadoPor,
      tipo: o.tipo ?? "prueba.eco",
    });
    return { c, id };
  };

  it("ejecutando -> completado de un trabajo interactivo con creador: una notificacion para el creador", async () => {
    const { c, id } = await ensayo();
    expect(await transicionar(worker, id, "ejecutando", "completado", { resultado: { n: 1 } })).toBe(true);
    const ns = await deTrabajo(id);
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({
      usuario_id: contador,
      tipo: "trabajo_terminado",
      trabajo_id: id,
      leida_en: null,
      params: { tipoTrabajo: "prueba.eco", estado: "completado" },
    });
    expect(ns[0].clave_dedupe).toBe(`trabajo_terminado:${id}`);
    expect(Object.keys(ns[0].params).every((k) => ["tipoTrabajo", "estado", "motivo"].includes(k))).toBe(true);
    expect([null, c.id]).toContain(ns[0].cliente_id);
  });

  it("ejecutando -> error con motivo: una notificacion con estado error y el motivo (solo codigos)", async () => {
    const { id } = await ensayo({ tipo: "sire.propuesta.descargar" });
    expect(await transicionar(worker, id, "ejecutando", "error", { motivo: "sunat_no_responde" })).toBe(true);
    const ns = await deTrabajo(id);
    expect(ns).toHaveLength(1);
    expect(ns[0].usuario_id).toBe(contador);
    expect(ns[0].params).toMatchObject({ tipoTrabajo: "sire.propuesta.descargar", estado: "error", motivo: "sunat_no_responde" });
  });

  it("el reintento (ejecutando -> en_cola) no avisa; solo avisa la transicion terminal, una vez por trabajo", async () => {
    const { id } = await ensayo();
    expect(await transicionar(worker, id, "ejecutando", "en_cola", { intentos: 1, motivo: "sunat_no_responde" })).toBe(true);
    expect(await deTrabajo(id)).toHaveLength(0);
    expect(await transicionar(worker, id, "en_cola", "ejecutando")).toBe(true);
    expect(await transicionar(worker, id, "ejecutando", "en_cola", { intentos: 2 })).toBe(true);
    expect(await transicionar(worker, id, "en_cola", "ejecutando")).toBe(true);
    expect(await deTrabajo(id)).toHaveLength(0);
    expect(await transicionar(worker, id, "ejecutando", "completado")).toBe(true);
    expect(await deTrabajo(id)).toHaveLength(1);
  });

  it("dos transiciones terminales son imposibles: la segunda pierde y queda una sola fila", async () => {
    const { id } = await ensayo();
    const [a, b] = await Promise.all([
      transicionar(worker, id, "ejecutando", "completado"),
      transicionar(worker, id, "ejecutando", "error", { motivo: "error_interno" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await deTrabajo(id)).toHaveLength(1);
    expect(await transicionar(worker, id, "ejecutando", "error", { motivo: "error_interno" })).toBe(false);
    expect(await deTrabajo(id)).toHaveLength(1);
  });

  it("cancelado no avisa: ni en_cola -> cancelado (backend) ni ejecutando -> cancelado (worker)", async () => {
    const enCola = await ensayo({ estado: "en_cola" });
    expect(await transicionar(backend, enCola.id, "en_cola", "cancelado", { motivo: "cancelado_usuario" })).toBe(true);
    expect(await deTrabajo(enCola.id)).toHaveLength(0);
    const corriendo = await ensayo();
    expect(await transicionar(worker, corriendo.id, "ejecutando", "cancelado", { motivo: "cancelado_usuario" })).toBe(true);
    expect(await deTrabajo(corriendo.id)).toHaveLength(0);
  });

  it("un trabajo programado (no interactivo) no avisa aunque tenga creador", async () => {
    const { id } = await ensayo({ prioridad: "programado" });
    expect(await transicionar(worker, id, "ejecutando", "completado")).toBe(true);
    expect(await deTrabajo(id)).toHaveLength(0);
  });

  it("un trabajo sin creador (de sistema) no avisa", async () => {
    const { id } = await ensayo({ creadoPor: null });
    expect(await transicionar(worker, id, "ejecutando", "error", { motivo: "error_interno" })).toBe(true);
    expect(await deTrabajo(id)).toHaveLength(0);
  });

  it("un creador desactivado no recibe el aviso", async () => {
    const { id } = await ensayo({ creadoPor: desactivado });
    expect(await transicionar(worker, id, "ejecutando", "completado")).toBe(true);
    expect(await deTrabajo(id)).toHaveLength(0);
  });

  it("si la transaccion se revierte no queda ninguna notificacion", async () => {
    const { id } = await ensayo();
    const ganada = await enRollback(worker, { tenantId: X }, (tx) => f("transicionar")(tx, id, "ejecutando", "completado", {}));
    expect(ganada).toBe(true);
    expect(await deTrabajo(id)).toHaveLength(0);
    expect((await en.et.fila(id)).estado).toBe("ejecutando");
  });

  it("el aviso es del creador de ESE trabajo: dos trabajos de usuarios distintos, cada uno al suyo", async () => {
    const a = await ensayo({ creadoPor: contador });
    const b = await ensayo({ creadoPor: responsable });
    expect(await transicionar(worker, a.id, "ejecutando", "completado")).toBe(true);
    expect(await transicionar(worker, b.id, "ejecutando", "completado")).toBe(true);
    expect((await deTrabajo(a.id)).map((n) => n.usuario_id)).toEqual([contador]);
    expect((await deTrabajo(b.id)).map((n) => n.usuario_id)).toEqual([responsable]);
  });
});

// =================================================================================================
describe("destinatariosNuevos y notificaciones_de_esta_transaccion (D-9, aviso en vivo tras el commit)", () => {
  const transicionar = (tx: any, id: string, hacia: string) => f("transicionar")(tx, id, "ejecutando", hacia, {});
  const trabajo = async (creadoPor: string) => {
    const c = await en.et.cliente(X);
    return en.et.job(X, c, { estado: "ejecutando", prioridad: "interactivo", creadoPor });
  };
  const funcion = async (tx: any): Promise<string[]> =>
    (await tx.query("select notificaciones_de_esta_transaccion() as u")).rows.map((r: { u: string }) => r.u);

  it("devuelve los destinatarios de las filas que creo ESTA transaccion", async () => {
    const id = await trabajo(contador);
    const vistos = await worker.withTenant({ tenantId: X }, async (tx) => {
      expect(await funcion(tx)).toEqual([]); // antes del hecho: nada
      await transicionar(tx, id, "completado");
      return { sql: await funcion(tx), repo: await f("destinatariosNuevos")(tx) };
    });
    expect(new Set(vistos.sql)).toEqual(new Set([contador]));
    expect(vistos.repo).toEqual([contador]);
  });

  it("no devuelve lo que otra transaccion ya confirmo, aunque sea del mismo estudio y usuario", async () => {
    const id = await trabajo(contador);
    await worker.withTenant({ tenantId: X }, (tx) => transicionar(tx, id, "completado"));
    expect((await deTrabajoFilas(id)).length).toBe(1);
    const despues = await backend.withTenant({ tenantId: X, userId: contador }, async (tx) => ({
      sql: await funcion(tx),
      repo: await f("destinatariosNuevos")(tx),
    }));
    expect(despues.sql).toEqual([]);
    expect(despues.repo).toEqual([]);
  });

  it("varios hechos de una transaccion: cada destinatario una vez en destinatariosNuevos", async () => {
    const a = await trabajo(contador);
    const b = await trabajo(contador);
    const c = await trabajo(responsable);
    const repo = await worker.withTenant({ tenantId: X }, async (tx) => {
      await transicionar(tx, a, "completado");
      await transicionar(tx, b, "error");
      await transicionar(tx, c, "completado");
      return (await f("destinatariosNuevos")(tx)) as string[];
    });
    expect([...repo].sort()).toEqual(ordenados(contador, responsable));
  });

  it("una transaccion sin hechos con aviso devuelve una lista vacia (un reintento no avisa)", async () => {
    const id = await trabajo(contador);
    const repo = await worker.withTenant({ tenantId: X }, async (tx) => {
      await f("transicionar")(tx, id, "ejecutando", "en_cola", { intentos: 1 });
      return (await f("destinatariosNuevos")(tx)) as string[];
    });
    expect(repo).toEqual([]);
  });

  it("la funcion SQL la ejecutan el backend y el worker; app y platform reciben 42501", async () => {
    for (const db of [backend, worker]) {
      const r = await db.withTenant({ tenantId: X, userId: contador }, (tx) => funcion(tx));
      expect(r).toEqual([]);
    }
    for (const rol of ["contapp_app", "contapp_platform"]) {
      const puede = (
        await admin.query("select has_function_privilege($1, 'public.notificaciones_de_esta_transaccion()', 'EXECUTE') as ok", [rol])
      ).rows[0].ok;
      expect(puede, rol).toBe(false);
    }
  });
});

const deTrabajoFilas = async (id: string) => (await en.notifs(X, { tipo: "trabajo_terminado" })).filter((n) => n.trabajo_id === id);
