// Spec 017 (T2, rojo): CA-1 (una fila por accion, en la misma transaccion, con actor, cliente, entidad y `datos` exactos de la lista
// blanca del plan) y CA-2 (falla cerrado). Cada accion la hace el repositorio o la funcion YA existente con el rol de la app
// (`withTenant`) o la funcion `auth.*`; la siembra con el superusuario deja filas `sistema` que `capturar` descarta.
// Fallan por tabla `auditoria` ausente (0041/0042 aun no existen).
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "./acceso-soporte";
import {
  ACCIONES_D3,
  EscenarioAuditoria,
  abrirAdmin,
  enRevertida,
  exportado,
  sha256Hex,
  unaFila,
  type EsperadaAud,
  type FilaAud,
} from "./auditoria-soporte";
import { abrirApp, llamar, nuevoToken } from "./auth-soporte";
import { PERIODO, sinHallazgos, transformarFalso } from "./compras-soporte";
import { entradaXml } from "./compras-xml-soporte";
import { datosArchivo, entradaVersion } from "./archivos-soporte";
import type { Tx } from "./soporte";
import type { ClientePrueba } from "./trabajos-soporte";

// --- funciones de @contapp/db, por nombre (si falta alguna, la prueba lo dice) -------------------------------------------------
const f = <T extends (...a: any[]) => any>(n: string) => exportado<T>(n);
const crearCliente = (tx: Tx, t: string, d: unknown) => f<(tx: Tx, t: string, d: unknown) => Promise<string>>("crearCliente")(tx, t, d);
const editarCliente = (tx: Tx, id: string, d: unknown) => f<(tx: Tx, id: string, d: unknown) => Promise<boolean>>("editarCliente")(tx, id, d);
const archivarCliente = (tx: Tx, id: string) => f<(tx: Tx, id: string) => Promise<void>>("archivarCliente")(tx, id);
const reactivarCliente = (tx: Tx, id: string) => f<(tx: Tx, id: string) => Promise<void>>("reactivarCliente")(tx, id);
const marcarOrigenImportacion = (tx: Tx) => f<(tx: Tx) => Promise<void>>("marcarOrigenImportacion")(tx);
const crearInvitacion = (tx: Tx, n: unknown) => f<(tx: Tx, n: unknown) => Promise<{ id: string }>>("crearInvitacion")(tx, n);
const revocar = (tx: Tx, id: string) => f<(tx: Tx, id: string) => Promise<unknown>>("revocar")(tx, id);
const cambiarRol = (tx: Tx, u: string, rol: string) => f<(tx: Tx, u: string, r: string) => Promise<unknown>>("cambiarRol")(tx, u, rol);
const desactivar = (tx: Tx, u: string) => f<(tx: Tx, u: string) => Promise<unknown>>("desactivar")(tx, u);
const reactivar = (tx: Tx, u: string) => f<(tx: Tx, u: string) => Promise<unknown>>("reactivar")(tx, u);
const asignar = (tx: Tx, a: unknown) => f<(tx: Tx, a: unknown) => Promise<unknown>>("asignar")(tx, a);
const retirar = (tx: Tx, a: unknown) => f<(tx: Tx, a: unknown) => Promise<unknown>>("retirar")(tx, a);
const guardarSobre = (tx: Tx, a: unknown) => f<(tx: Tx, a: unknown) => Promise<{ id: string }>>("guardarSobre")(tx, a);
const versionCredencial = (tx: Tx, c: string, t: string) => f<(tx: Tx, c: string, t: string) => Promise<string | null>>("versionCredencial")(tx, c, t);
const marcarCredencialVerificada = (tx: Tx, c: string, t: string, v: string | null) =>
  f<(tx: Tx, c: string, t: string, v: string | null) => Promise<boolean>>("marcarCredencialVerificada")(tx, c, t, v);
const marcarCredencialInvalida = (tx: Tx, c: string, t: string) =>
  f<(tx: Tx, c: string, t: string) => Promise<boolean>>("marcarCredencialInvalida")(tx, c, t);
const crearPropuesta = (tx: Tx, n: unknown) => f<(tx: Tx, n: unknown) => Promise<{ id: string }>>("crearPropuesta")(tx, n);
const crearVentaManual = (tx: Tx, n: unknown) => f<(tx: Tx, n: unknown) => Promise<{ id: string }>>("crearVentaManual")(tx, n);
const excluirVenta = (tx: Tx, d: unknown) => f<(tx: Tx, d: unknown) => Promise<{ id: string } | null>>("excluirVenta")(tx, d);
const restaurarVenta = (tx: Tx, v: string, u: string) => f<(tx: Tx, v: string, u: string) => Promise<boolean>>("restaurarVenta")(tx, v, u);
const justificar = (tx: Tx, d: unknown) => f<(tx: Tx, d: unknown) => Promise<{ id: string }>>("justificar")(tx, d);
const guardarDocumentoXml = (tx: Tx, e: unknown) => f<(tx: Tx, e: unknown) => Promise<{ id: string; n: number } | string>>("guardarDocumentoXml")(tx, e);
const fijarEstadoPeriodo = (tx: Tx, c: string, p: string, d: string, h: string, u: string) =>
  f<(...a: any[]) => Promise<unknown>>("fijarEstadoPeriodo")(tx, c, p, d, h, u);
const fijarEstadoPeriodoVentas = (tx: Tx, c: string, p: string, d: string, h: string, u: string) =>
  f<(...a: any[]) => Promise<unknown>>("fijarEstadoPeriodoVentas")(tx, c, p, d, h, u);
const insertarVersion = (tx: Tx, v: unknown) => f<(tx: Tx, v: unknown) => Promise<unknown>>("insertarVersion")(tx, v);
const aplicarMasiva = (tx: Tx, e: unknown, fs: unknown) =>
  f<(tx: Tx, e: unknown, fs: unknown) => Promise<{ operacionId: string | null; aplicadas: number }>>("aplicarMasiva")(tx, e, fs);

let admin: Pool;
let app: Pool;
let ec: EscenarioAuditoria;
let X: string;
let Y: string;
let cx: ClientePrueba;
let ux: string; // actor de las acciones del backend
let ms: string; // un miembro "objetivo" de X
const cubiertas = new Set<string>();

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirApp(4);
  ec = new EscenarioAuditoria(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  ux = await ec.usuarioDe(X);
  ms = (await ec.miembro(X, "contador")).id;
});
afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await admin?.end();
  await app?.end();
});

/** Verifica la fila y la anota como cubierta. */
function ok(filas: FilaAud[], accion: string, e: EsperadaAud): FilaAud {
  const fila = unaFila(filas, accion, e);
  cubiertas.add(accion);
  return fila;
}

let n = 0;
const ruc = () => `2${String(80000 + ++n).padStart(10, "0")}`;
const usuario = (id = ux): Pick<EsperadaAud, "actorTipo" | "usuarioId" | "trabajoId"> => ({ actorTipo: "usuario", usuarioId: id, trabajoId: null });
const idDe = async (sql: string, v: unknown[]): Promise<string> => (await admin.query(sql, v)).rows[0].id as string;
const membresiaId = (u: string) => idDe("select id from membresia where tenant_id = $1 and usuario_id = $2", [X, u]);

// =================================================================================================
describe("CA-1 · sesion (login y cambio de estudio, 004)", () => {
  const LOGIN =
    "select sesion_id, expira_absoluta from auth.login_exito($1::bytea, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::text, $7::bytea)";
  const ROTAR = "select sesion_id, expira_absoluta from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)";

  it("sesion.ingreso: login_exito con estudio deja una fila (actor = el usuario de la sesion, datos {})", async () => {
    const u = await ec.ea.miembro(X, "contador");
    const clave = ec.ea.esc.clave(u.correo);
    const { filas, resultado } = await ec.capturar(X, "sesion.ingreso", async () => {
      const r = await llamar(app, LOGIN, [clave, u.id, u.hash, nuevoToken(), X, null, null]);
      if (!r.ok) throw new Error(`login_exito fallo (${r.code})`);
      return r.rows[0].sesion_id as string;
    });
    ok(filas, "sesion.ingreso", { ...usuario(u.id), entidad: "sesion", entidadId: resultado, datos: {} });
  });

  it("sesion.ingreso: sesion_rotar al otro estudio deja una fila en ESE estudio (cambio de estudio)", async () => {
    const u = await ec.ea.miembro(X, "contador");
    await ec.ea.membresia(Y, u.id, "contador");
    const base = await ec.ea.esc.sesion(u.id, X);
    const { filas, resultado } = await ec.capturar(Y, "sesion.ingreso", async () => {
      const r = await llamar(app, ROTAR, [base, nuevoToken(), Y]);
      if (!r.ok) throw new Error(`sesion_rotar fallo (${r.code})`);
      return r.rows[0].sesion_id as string;
    });
    expect(filas.map((x) => [x.actor_tipo, x.usuario_id, x.entidad_id, x.tenant_id])).toEqual([["usuario", u.id, resultado, Y]]);
  });

  it("sin estudio activo, o al cambiar otra columna, o al quedar NULL (estudio revocado) NO deja fila", async () => {
    const u = await ec.ea.miembro(X, "contador");
    const antes = await ec.cuantas(X);
    const sinEstudio = await ec.ea.esc.sesion(u.id, null);
    expect(await ec.cuantas(X)).toBe(antes);
    const conEstudio = await ec.ea.esc.sesion(u.id, X);
    const tras = await ec.cuantas(X);
    expect(tras).toBe(antes + 1); // solo la sesion con estudio
    await admin.query("update auth.sesion set ultimo_uso = now() where token_hash = any($1::bytea[])", [[sinEstudio, conEstudio]]);
    expect(await ec.cuantas(X), "ultimo_uso no audita").toBe(tras);
    await admin.query("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [X, u.id]);
    const desact = await ec.cuantas(X);
    const v = await llamar(app, "select tenant_activo from auth.sesion_validar($1::bytea)", [conEstudio]);
    expect(v.ok).toBe(true);
    expect(await ec.cuantas(X), "sesion_validar deja tenant_activo NULL: no audita").toBe(desact);
  });
});

// =================================================================================================
describe("CA-1 · acceso (005): invitaciones, miembros y asignaciones", () => {
  it("invitacion.creada {rol} y invitacion.revocada {}", async () => {
    const correo = ec.ea.esc.correoNuevo();
    const creada = await ec.capturar(X, "invitacion.creada", () =>
      ec.comoBackend(X, ux, (tx) => crearInvitacion(tx, { correo, rol: "contador", invitadoPor: ux, tokenHash: sha256(randomBytes(32)) })),
    );
    ok(creada.filas, "invitacion.creada", { ...usuario(), entidad: "invitacion", entidadId: creada.resultado.id, datos: { rol: "contador" } });
    ec.ea.recordarCorreo(correo);
    const revocada = await ec.capturar(X, "invitacion.revocada", () => ec.comoBackend(X, ux, (tx) => revocar(tx, creada.resultado.id)));
    ok(revocada.filas, "invitacion.revocada", { ...usuario(), entidad: "invitacion", entidadId: creada.resultado.id, datos: {} });
  });

  it("miembro.alta {rol, via}: via 'otro' para un alta directa y via 'invitacion' al aceptar una invitacion", async () => {
    const cuenta = await ec.ea.cuenta();
    const directa = await ec.capturar(X, "miembro.alta", () =>
      ec.comoBackend(X, ux, (tx) => tx.query("insert into membresia (usuario_id, rol) values ($1, 'lectura')", [cuenta.id])),
    );
    ok(directa.filas, "miembro.alta", {
      ...usuario(),
      entidad: "membresia",
      entidadId: await membresiaId(cuenta.id),
      datos: { rol: "lectura", via: "otro" },
    });
    // Aceptar una invitacion con una cuenta existente (auth.invitacion_aceptar_existente): el actor es quien acepta.
    // El invitador debe ser Dueño o Administrador vigente (si no, la funcion no acepta): un admin propio, no `ux` (contador).
    const invitador = await ec.ea.miembro(X, "admin");
    const inv = await ec.ea.invitacion(X, { invitadoPor: invitador.id, rol: "admin" });
    const u = await admin.query("insert into usuario (email, nombre) values ($1, 'Cuenta T2') returning id", [inv.correo]);
    const uid = u.rows[0].id as string;
    const sesion = nuevoToken();
    await admin.query(
      "insert into auth.sesion (token_hash, usuario_id, tenant_activo, expira_absoluta) values ($1, $2, null, now() + interval '1 hour')",
      [sha256(sesion), uid],
    );
    const { filas } = await ec.capturar(X, "miembro.alta", async () => {
      const r = await llamar(app, "select * from auth.invitacion_aceptar_existente($1, $2)", [inv.tokenHash, sha256(sesion)]);
      if (!r.ok) throw new Error(`aceptar fallo (${r.code})`);
    });
    expect(filas.map((x) => [x.actor_tipo, x.usuario_id, x.datos])).toEqual([["usuario", uid, { rol: "admin", via: "invitacion" }]]);
  });

  it("miembro.rol_cambiado {de, a}, miembro.desactivado {} y miembro.reactivado {}", async () => {
    const mid = await membresiaId(ms);
    const rol = await ec.capturar(X, "miembro.rol_cambiado", () => ec.comoBackend(X, ux, (tx) => cambiarRol(tx, ms, "admin")));
    ok(rol.filas, "miembro.rol_cambiado", { ...usuario(), entidad: "membresia", entidadId: mid, datos: { de: "contador", a: "admin" } });
    const des = await ec.capturar(X, "miembro.desactivado", () => ec.comoBackend(X, ux, (tx) => desactivar(tx, ms)));
    ok(des.filas, "miembro.desactivado", { ...usuario(), entidad: "membresia", entidadId: mid, datos: {} });
    const rea = await ec.capturar(X, "miembro.reactivado", () => ec.comoBackend(X, ux, (tx) => reactivar(tx, ms)));
    ok(rea.filas, "miembro.reactivado", { ...usuario(), entidad: "membresia", entidadId: mid, datos: {} });
  });

  it("asignacion.agregada {tipo, usuarioId} y asignacion.quitada {tipo, usuarioId}", async () => {
    const c = await ec.cliente(X);
    const add = await ec.capturar(X, "asignacion.agregada", () =>
      ec.comoBackend(X, ux, (tx) => asignar(tx, { clienteId: c.id, usuarioId: ms, tipo: "colaborador" })),
    );
    const aid = await idDe("select id from asignacion where tenant_id = $1 and cliente_id = $2 and usuario_id = $3", [X, c.id, ms]);
    ok(add.filas, "asignacion.agregada", {
      ...usuario(),
      clienteId: c.id,
      entidad: "asignacion",
      entidadId: aid,
      datos: { tipo: "colaborador", usuarioId: ms },
    });
    const quitar = await ec.capturar(X, "asignacion.quitada", () => ec.comoBackend(X, ux, (tx) => retirar(tx, { clienteId: c.id, usuarioId: ms })));
    ok(quitar.filas, "asignacion.quitada", {
      ...usuario(),
      clienteId: c.id,
      entidad: "asignacion",
      entidadId: aid,
      datos: { tipo: "colaborador", usuarioId: ms },
    });
  });
});

// =================================================================================================
describe("CA-1 · clientes (007a)", () => {
  it("cliente.creado {origen: 'manual'} y, tras marcarOrigenImportacion, {origen: 'importacion'}; otro valor = manual", async () => {
    const manual = await ec.capturar(X, "cliente.creado", () =>
      ec.comoBackend(X, ux, (tx) => crearCliente(tx, X, { ruc: ruc(), razonSocial: "Manual SAC" })),
    );
    ok(manual.filas, "cliente.creado", { ...usuario(), clienteId: manual.resultado, entidad: "cliente", entidadId: manual.resultado, datos: { origen: "manual" } });
    const imp = await ec.capturar(X, "cliente.creado", () =>
      ec.comoBackend(X, ux, async (tx) => {
        await marcarOrigenImportacion(tx);
        return crearCliente(tx, X, { ruc: ruc(), razonSocial: "Importado SAC" });
      }),
    );
    unaFila(imp.filas, "cliente.creado", {
      ...usuario(),
      clienteId: imp.resultado,
      entidad: "cliente",
      entidadId: imp.resultado,
      datos: { origen: "importacion" },
    });
    const otro = await ec.capturar(X, "cliente.creado", () =>
      ec.comoBackend(X, ux, async (tx) => {
        await tx.query("select set_config('app.origen_cliente', 'cualquier-cosa', true)");
        return crearCliente(tx, X, { ruc: ruc(), razonSocial: "Otro SAC" });
      }),
    );
    expect(otro.filas.map((x) => x.datos)).toEqual([{ origen: "manual" }]);
  });

  it("marcarOrigenImportacion solo vale dentro de su transaccion: la siguiente alta vuelve a ser manual", async () => {
    await ec.comoBackend(X, ux, (tx) => marcarOrigenImportacion(tx));
    const { filas } = await ec.capturar(X, "cliente.creado", () => ec.comoBackend(X, ux, (tx) => crearCliente(tx, X, { ruc: ruc() })));
    expect(filas.map((x) => x.datos)).toEqual([{ origen: "manual" }]);
  });

  it("cliente.editado {cambios: {campo: [antes, despues]}} con solo las columnas que cambiaron; una edicion sin cambios no deja fila", async () => {
    const id = await ec.comoBackend(X, ux, (tx) => crearCliente(tx, X, { ruc: ruc(), razonSocial: "Antes SAC" }));
    const perfil = { regimen: null, zona: "general", ventasExoneradas: false, ventasMixtas: true, monedaHabitual: "PEN" };
    const { filas } = await ec.capturar(X, "cliente.editado", () =>
      ec.comoBackend(X, ux, (tx) => editarCliente(tx, id, { razonSocial: "Despues SAC", perfil })),
    );
    ok(filas, "cliente.editado", {
      ...usuario(),
      clienteId: id,
      entidad: "cliente",
      entidadId: id,
      datos: { cambios: { razon_social: ["Antes SAC", "Despues SAC"], ventas_mixtas: [false, true] } },
    });
    const igual = await ec.capturar(X, "cliente.editado", () =>
      ec.comoBackend(X, ux, (tx) => editarCliente(tx, id, { razonSocial: "Despues SAC", perfil })),
    );
    expect(igual.filas, "sin cambios de datos no hay fila (updated_at no cuenta)").toEqual([]);
  });

  it("cliente.archivado {} y cliente.reactivado {}; repetir la accion (idempotente) no deja otra fila", async () => {
    const id = await ec.comoBackend(X, ux, (tx) => crearCliente(tx, X, { ruc: ruc() }));
    const arch = await ec.capturar(X, "cliente.archivado", () => ec.comoBackend(X, ux, (tx) => archivarCliente(tx, id)));
    ok(arch.filas, "cliente.archivado", { ...usuario(), clienteId: id, entidad: "cliente", entidadId: id, datos: {} });
    const otra = await ec.capturar(X, "cliente.archivado", () => ec.comoBackend(X, ux, (tx) => archivarCliente(tx, id)));
    expect(otra.filas).toEqual([]);
    const rea = await ec.capturar(X, "cliente.reactivado", () => ec.comoBackend(X, ux, (tx) => reactivarCliente(tx, id)));
    ok(rea.filas, "cliente.reactivado", { ...usuario(), clienteId: id, entidad: "cliente", entidadId: id, datos: {} });
    const otra2 = await ec.capturar(X, "cliente.reactivado", () => ec.comoBackend(X, ux, (tx) => reactivarCliente(tx, id)));
    expect(otra2.filas).toEqual([]);
  });
});

// =================================================================================================
describe("CA-1 · credenciales (007b/008): solo tipo y estado, nunca el sobre (D-5)", () => {
  const sobre = () => ({
    ciphertext: randomBytes(64),
    nonce: randomBytes(12),
    tag: randomBytes(16),
    dekEnvuelta: randomBytes(512),
    kekId: "k1",
    version: 1,
  });

  it("credencial.guardada {tipo}: al crear y al reemplazar el ciphertext (una fila cada vez)", async () => {
    const c = await ec.cliente(X);
    const nueva = await ec.capturar(X, "credencial.guardada", () =>
      ec.comoBackend(X, ux, (tx) => guardarSobre(tx, { clienteId: c.id, tipo: "sol", sobre: sobre() })),
    );
    ok(nueva.filas, "credencial.guardada", {
      ...usuario(),
      clienteId: c.id,
      entidad: "credencial",
      entidadId: nueva.resultado.id,
      datos: { tipo: "sol" },
    });
    const reemplazo = await ec.capturar(X, "credencial.guardada", () =>
      ec.comoBackend(X, ux, (tx) => guardarSobre(tx, { clienteId: c.id, tipo: "sol", sobre: sobre() })),
    );
    expect(reemplazo.filas.map((x) => [x.entidad_id, x.datos])).toEqual([[nueva.resultado.id, { tipo: "sol" }]]);
  });

  it("credencial.verificada {tipo} y credencial.invalidada {tipo, motivo} (worker con trabajo): actor `trabajo`", async () => {
    const c = await ec.cliente(X);
    const credId = await ec.credencial(X, c.id, "sire_api");
    const trabajo = await ec.trabajo(X, c, ux);
    const ver = await ec.capturar(X, "credencial.verificada", () =>
      ec.comoWorker(X, { trabajoId: trabajo }, async (tx) => {
        const v = await versionCredencial(tx, c.id, "sire_api");
        return marcarCredencialVerificada(tx, c.id, "sire_api", v);
      }),
    );
    expect(ver.resultado).toBe(true);
    ok(ver.filas, "credencial.verificada", {
      actorTipo: "trabajo",
      usuarioId: ux,
      trabajoId: trabajo,
      clienteId: c.id,
      entidad: "credencial",
      entidadId: credId,
      datos: { tipo: "sire_api" },
    });
    const inv = await ec.capturar(X, "credencial.invalidada", () =>
      ec.comoWorker(X, { trabajoId: trabajo }, (tx) => marcarCredencialInvalida(tx, c.id, "sire_api")),
    );
    expect(inv.resultado).toBe(true);
    ok(inv.filas, "credencial.invalidada", {
      actorTipo: "trabajo",
      usuarioId: ux,
      trabajoId: trabajo,
      clienteId: c.id,
      entidad: "credencial",
      entidadId: credId,
      datos: { tipo: "sire_api", motivo: "credencial_invalida" },
    });
    const otra = await ec.capturar(X, "credencial.invalidada", () =>
      ec.comoWorker(X, { trabajoId: trabajo }, (tx) => marcarCredencialInvalida(tx, c.id, "sire_api")),
    );
    expect(otra.resultado, "ya estaba invalida").toBe(false);
    expect(otra.filas, "una credencial que sigue invalida no deja otra fila").toEqual([]);
  });
});

// =================================================================================================
describe("CA-1 · libros (013/014/016/012b)", () => {
  it("propuesta.cargada {libro, periodo, fuente, filasRecibidas}", async () => {
    const { filas, resultado } = await ec.capturar(X, "propuesta.cargada", () =>
      ec.comoBackend(X, ux, (tx) =>
        crearPropuesta(tx, {
          clienteId: cx.id,
          periodo: PERIODO,
          libro: "ventas",
          fuente: "importacion",
          hash: "b".repeat(64),
          filasRecibidas: 7,
          filasNuevas: 7,
          filasIguales: 0,
          filasDistintas: 0,
          usuarioId: ux,
          trabajoId: null,
        }),
      ),
    );
    ok(filas, "propuesta.cargada", {
      ...usuario(),
      clienteId: cx.id,
      entidad: "propuesta",
      entidadId: resultado.id,
      datos: { libro: "ventas", periodo: PERIODO, fuente: "importacion", filasRecibidas: 7 },
    });
  });

  it("compra.operacion {tipo, periodo, filas, referenciaId}: una masiva de 3 compras deja UNA fila con filas = 3", async () => {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", nuevas: 3 });
    const compras = [];
    for (let i = 1; i <= 3; i++) compras.push(await ec.compra(X, c, { serie: "FC01", numero: String(i), propuestaId: prop }));
    const { filas, resultado } = await ec.capturar(X, "compra.operacion", () =>
      ec.comoBackend(X, ux, (tx) =>
        aplicarMasiva(
          tx,
          {
            clienteId: c.id,
            periodo: PERIODO,
            usuarioId: ux,
            accion: "clasificar",
            parametros: { tipo: "dng" },
            items: compras.map((x) => ({ compraId: x.id, versionBase: 1 })),
          },
          { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
        ),
      ),
    );
    expect(resultado.aplicadas).toBe(3);
    ok(filas, "compra.operacion", {
      ...usuario(),
      clienteId: c.id,
      entidad: "compra_operacion",
      entidadId: resultado.operacionId,
      datos: { tipo: "clasificar", periodo: PERIODO, filas: 3, referenciaId: null },
    });
  });

  it("venta.agregada {periodo} solo para ventas manuales: una venta del SIRE no deja fila", async () => {
    const sire = await ec.capturar(X, "venta.agregada", async () => ec.venta(X, cx, { serie: "B777", numero: "1" }));
    expect(sire.filas).toEqual([]);
    const manual = await ec.capturar(X, "venta.agregada", () =>
      ec.comoBackend(X, ux, (tx) =>
        crearVentaManual(tx, {
          clienteId: cx.id,
          periodo: PERIODO,
          creadaPor: ux,
          clave: "03|B002|900",
          tipo: "03",
          serie: "B002",
          numero: "900",
          fecha: "2026-10-05",
          tipoDocContraparte: "0",
          docContraparte: "-",
          moneda: "PEN",
          tipoCambio: null,
          baseGravada: "100.00",
          igv: "18.00",
          exonerada: "0.00",
          inafecta: "0.00",
          isc: "0.00",
          icbper: "0.00",
          otros: "0.00",
          total: "118.00",
        }),
      ),
    );
    ok(manual.filas, "venta.agregada", {
      ...usuario(),
      clienteId: cx.id,
      entidad: "venta",
      entidadId: manual.resultado.id,
      datos: { periodo: PERIODO },
    });
  });

  it("venta.excluida {periodo} y venta.restaurada {periodo} (zapatilla): la entidad es la exclusion", async () => {
    const c = await ec.cliente(X);
    const ventaId = await ec.venta(X, c, { serie: "B010", numero: "5", tipo: "03" });
    const ex = await ec.capturar(X, "venta.excluida", () =>
      ec.comoBackend(X, ux, (tx) => excluirVenta(tx, { clienteId: c.id, periodo: PERIODO, ventaId, motivo: "zapatillas", usuarioId: ux })),
    );
    expect(ex.resultado).not.toBeNull();
    ok(ex.filas, "venta.excluida", {
      ...usuario(),
      clienteId: c.id,
      entidad: "venta_exclusion",
      entidadId: ex.resultado!.id,
      datos: { periodo: PERIODO },
    });
    const re = await ec.capturar(X, "venta.restaurada", () => ec.comoBackend(X, ux, (tx) => restaurarVenta(tx, ventaId, ux)));
    expect(re.resultado).toBe(true);
    ok(re.filas, "venta.restaurada", {
      ...usuario(),
      clienteId: c.id,
      entidad: "venta_exclusion",
      entidadId: ex.resultado!.id,
      datos: { periodo: PERIODO },
    });
  });

  it("venta.salto_justificado {periodo} (boleta 291)", async () => {
    const c = await ec.cliente(X);
    const { filas, resultado } = await ec.capturar(X, "venta.salto_justificado", () =>
      ec.comoBackend(X, ux, (tx) =>
        justificar(tx, {
          clienteId: c.id,
          periodo: PERIODO,
          tipo: "03",
          serie: "B001",
          desde: 291,
          hasta: 291,
          comentario: "Boleta anulada en caja",
          usuarioId: ux,
        }),
      ),
    );
    ok(filas, "venta.salto_justificado", {
      ...usuario(),
      clienteId: c.id,
      entidad: "venta_salto_justificado",
      entidadId: resultado.id,
      datos: { periodo: PERIODO },
    });
  });

  it("xml.subido {n} solo para origen 'subido': el XML real del worker no deja fila; subir sobre uno simulado deja n = 2", async () => {
    const c = await ec.cliente(X);
    const id = { rucEmisor: "20100070970", tipo: "01", serie: "F001", numero: "55" };
    const real = await ec.capturar(X, "xml.subido", async () => ec.xml(X, c, { ...id, numero: "56" }, { origen: "real" }));
    expect(real.filas).toEqual([]);
    await ec.xml(X, c, id, { origen: "simulado" });
    const { filas, resultado } = await ec.capturar(X, "xml.subido", () =>
      ec.comoBackend(X, ux, (tx) => guardarDocumentoXml(tx, entradaXml(X, c.id, id, { origen: "subido", subidoPor: ux }))),
    );
    expect(typeof resultado).toBe("object");
    ok(filas, "xml.subido", {
      ...usuario(),
      clienteId: c.id,
      entidad: "documento_xml",
      entidadId: (resultado as { id: string }).id,
      datos: { n: 2 },
    });
  });

  it("periodo.estado_cambiado {libro, periodo, de, a} en compras y en ventas", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("compras", X, c, "202609", "abierto");
    await ec.periodoDe("ventas", X, c, "202609", "abierto");
    const com = await ec.capturar(X, "periodo.estado_cambiado", () =>
      ec.comoBackend(X, ux, (tx) => fijarEstadoPeriodo(tx, c.id, "202609", "abierto", "revisado", ux)),
    );
    ok(com.filas, "periodo.estado_cambiado", {
      ...usuario(),
      clienteId: c.id,
      entidad: "compra_periodo",
      datos: { libro: "compras", periodo: "202609", de: "abierto", a: "revisado" },
    });
    const ven = await ec.capturar(X, "periodo.estado_cambiado", () =>
      ec.comoBackend(X, ux, (tx) => fijarEstadoPeriodoVentas(tx, c.id, "202609", "abierto", "revisado", ux)),
    );
    unaFila(ven.filas, "periodo.estado_cambiado", {
      ...usuario(),
      clienteId: c.id,
      entidad: "venta_periodo",
      datos: { libro: "ventas", periodo: "202609", de: "abierto", a: "revisado" },
    });
    const reabrir = await ec.capturar(X, "periodo.estado_cambiado", () =>
      ec.comoBackend(X, ux, (tx) => fijarEstadoPeriodo(tx, c.id, "202609", "revisado", "abierto", ux)),
    );
    expect(reabrir.filas.map((x) => x.datos)).toEqual([{ libro: "compras", periodo: "202609", de: "revisado", a: "abierto" }]);
  });

  it("archivo.generado {libro, periodo, version, sha256Zip}: el worker, con su trabajo, deja actor `trabajo`", async () => {
    const c = await ec.cliente(X);
    const trabajo = await ec.trabajo(X, c, ux);
    await ec.periodoDe("compras", X, c, "202611", "generado", ux);
    const d = datosArchivo(X, c, ux, trabajo, { periodo: "202611", libro: "compras" });
    const { filas } = await ec.capturar(X, "archivo.generado", () =>
      ec.comoWorker(X, { trabajoId: trabajo }, (tx) => insertarVersion(tx, entradaVersion(d))),
    );
    ok(filas, "archivo.generado", {
      actorTipo: "trabajo",
      usuarioId: ux,
      trabajoId: trabajo,
      clienteId: c.id,
      entidad: "archivo_generado",
      entidadId: d.id,
      datos: { libro: "compras", periodo: "202611", version: 1, sha256Zip: d.sha256Zip.toString("hex") },
    });
    expect(createHash("sha256").update("x").digest("hex")).toBe(sha256Hex("x")); // el helper de hex es el mismo
  });
});

// =================================================================================================
describe("CA-1 · cobertura del catalogo", () => {
  it("hay una prueba por cada una de las 25 acciones de D-3 (ninguna sin verificar)", () => {
    expect([...cubiertas].sort()).toEqual([...ACCIONES_D3].sort());
  });
});

// =================================================================================================
describe("CA-2 · falla cerrado: si el INSERT de auditoria falla, la accion se revierte", () => {
  async function conTriggerQueFalla(
    accion: (c: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }) => Promise<void>,
  ) {
    return enRevertida(admin, async (c) => {
      await c.query(`create function pg_temp.auditoria_falla_prueba() returns trigger language plpgsql as
        $$ begin raise exception 'auditoria_falla_prueba' using errcode = 'P0001'; end $$`);
      await c.query(
        `create trigger auditoria_falla_prueba before insert on public.auditoria
         for each row execute function pg_temp.auditoria_falla_prueba()`,
      );
      await accion(c);
    });
  }

  it("crear un cliente falla con el error del INSERT de auditoria y no queda el cliente", async () => {
    const r = ruc();
    const res = await conTriggerQueFalla(async (c) => {
      await c.query("SET LOCAL ROLE contapp_backend");
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [X, ux]);
      await c.query("insert into cliente (ruc, razon_social) values ($1, 'Falla cerrado')", [r]);
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("auditoria_falla_prueba");
    expect((await admin.query("select 1 from cliente where tenant_id = $1 and ruc = $2", [X, r])).rowCount).toBe(0);
  });

  it("una edicion de cliente que no puede auditarse deja el dato como estaba y sin fila nueva", async () => {
    const id = await ec.comoBackend(X, ux, (tx) => crearCliente(tx, X, { ruc: ruc(), razonSocial: "Estable SAC" }));
    const antes = await ec.cuantas(X);
    const res = await conTriggerQueFalla(async (c) => {
      await c.query("SET LOCAL ROLE contapp_backend");
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [X, ux]);
      await c.query("update cliente set razon_social = 'Cambiada' where id = $1", [id]);
    });
    expect(res.ok).toBe(false);
    expect((await admin.query("select razon_social from cliente where id = $1", [id])).rows[0].razon_social).toBe("Estable SAC");
    expect(await ec.cuantas(X)).toBe(antes);
  });

  it("el worker con un trabajo que no existe no deja la accion: ni el cambio ni la fila (ver tambien auditoria-actor)", async () => {
    const antes = await ec.cuantas(X);
    const res = await enRevertida(admin, async (c) => {
      await c.query("SET LOCAL ROLE contapp_worker");
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.trabajo_id', $2, true)", [
        X,
        "00000000-0000-4000-8000-000000000017",
      ]);
      await c.query("update cliente set ventas_mixtas = not ventas_mixtas where id = $1", [cx.id]);
    });
    expect(res.ok).toBe(false);
    expect(await ec.cuantas(X)).toBe(antes);
  });

  it("al deshacer el trigger de prueba (ROLLBACK) la accion vuelve a funcionar: el control no es vacuo", async () => {
    const { filas } = await ec.capturar(X, "cliente.creado", () => ec.comoBackend(X, ux, (tx) => crearCliente(tx, X, { ruc: ruc() })));
    expect(filas).toHaveLength(1);
  });

  it("si la transaccion de la accion se revierte, tampoco queda la fila de auditoria (misma transaccion)", async () => {
    const antes = await ec.cuantas(X);
    await expect(
      ec.comoBackend(X, ux, async (tx) => {
        await crearCliente(tx, X, { ruc: ruc() });
        throw new Error("revertir");
      }),
    ).rejects.toThrow("revertir");
    expect(await ec.cuantas(X)).toBe(antes);
  });
});
