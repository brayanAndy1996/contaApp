// Spec 017 (T2, rojo): CA-4 en SQL, el actor de cada fila de auditoria sale del contexto de la transaccion y nunca de la entrada.
// Orden de auditoria_registrar (plan): (1) rol contapp_worker con app.trabajo_id -> `trabajo`, usuario_id = job_registro.creado_por
// leido por id Y tenant (inexistente o de otro estudio: lanza y la accion se revierte); (2) app.user_id -> `usuario`;
// (3) p_usuario_fila (solo auth) -> `usuario`; (4) si no, `sistema`.
// `ContextoTenant.trabajoId` fija `app.trabajo_id` (uuid validado, como userId).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAuditoria, abrirAdmin, exportado, unaFila, uuidAjeno } from "./auditoria-soporte";
import type { ClientePrueba } from "./trabajos-soporte";
import type { Tx } from "./soporte";

let admin: Pool;
let ec: EscenarioAuditoria;
let X: string;
let Y: string;
let cx: ClientePrueba;
let ux: string; // creado_por del trabajo
let otro: string; // otro miembro de X
let trabajoX: string;
let trabajoSinAutor: string;
let trabajoY: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioAuditoria(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  const cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  otro = (await ec.miembro(X, "contador")).id;
  trabajoX = await ec.trabajo(X, cx, ux);
  trabajoSinAutor = await ec.trabajo(X, cx, null);
  trabajoY = await ec.trabajo(Y, cy, await ec.usuarioDe(Y));
});
afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await admin?.end();
});

/** Un cambio que el worker puede hacer (UPDATE de cliente) y que audita `cliente.editado`. */
const editarComoWorker = (tx: Tx, clienteId: string) =>
  tx.query("update cliente set ventas_mixtas = not ventas_mixtas where id = $1", [clienteId]);

const accionDeUsuario = (tx: Tx, ruc: string) =>
  exportado<(tx: Tx, tenantId: string, d: { ruc: string; razonSocial: string }) => Promise<string>>("crearCliente")(tx, X, {
    ruc,
    razonSocial: "Actor T2",
  });

let ruc = 0;
const rucNuevo = () => `2${String(70000 + ++ruc).padStart(10, "0")}`;

describe("CA-4 · actor `usuario`", () => {
  it("con app.user_id la fila es actor `usuario` con ese usuario_id y sin trabajo_id", async () => {
    const { filas, resultado } = await ec.capturar(X, "cliente.creado", () =>
      ec.comoBackend(X, ux, (tx) => accionDeUsuario(tx, rucNuevo())),
    );
    unaFila(filas, "cliente.creado", {
      actorTipo: "usuario",
      usuarioId: ux,
      trabajoId: null,
      entidad: "cliente",
      entidadId: resultado,
      clienteId: resultado,
      datos: { origen: "manual" },
    });
  });

  it("el actor es el de la sesion: dos usuarios del mismo estudio dejan cada uno su propia fila", async () => {
    const a = await ec.capturar(X, "cliente.creado", () => ec.comoBackend(X, otro, (tx) => accionDeUsuario(tx, rucNuevo())));
    const b = await ec.capturar(X, "cliente.creado", () => ec.comoBackend(X, ux, (tx) => accionDeUsuario(tx, rucNuevo())));
    expect(a.filas.map((f) => f.usuario_id)).toEqual([otro]);
    expect(b.filas.map((f) => f.usuario_id)).toEqual([ux]);
  });

  it("un app.user_id de alguien que no es miembro tambien se registra tal cual lo fijo la sesion (sin FK) y nunca se cambia", async () => {
    const ajeno = uuidAjeno();
    const { filas } = await ec.capturar(X, "cliente.creado", () => ec.comoBackend(X, ajeno, (tx) => accionDeUsuario(tx, rucNuevo())));
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id])).toEqual([["usuario", ajeno]]);
  });
});

describe("CA-4 · actor `trabajo` (worker con app.trabajo_id)", () => {
  it("withTenant fija app.trabajo_id desde ContextoTenant.trabajoId y rechaza un valor que no es uuid (ContextoInvalidoError)", async () => {
    const visto = await ec.comoWorker(X, { trabajoId: trabajoX }, async (tx) =>
      (await tx.query("select current_setting('app.trabajo_id', true) as t")).rows[0].t,
    );
    expect(visto).toBe(trabajoX);
    await expect(ec.comoWorker(X, { trabajoId: "no-es-uuid" }, async () => 1)).rejects.toThrow();
    await expect(ec.comoWorker(X, { trabajoId: "x'; drop table auditoria; --" }, async () => 1)).rejects.toThrow();
  });

  it("con trabajoId del tenant: actor `trabajo`, trabajo_id y usuario_id = creado_por del trabajo", async () => {
    const { filas } = await ec.capturar(X, "cliente.editado", () =>
      ec.comoWorker(X, { trabajoId: trabajoX }, (tx) => editarComoWorker(tx, cx.id)),
    );
    unaFila(filas, "cliente.editado", {
      actorTipo: "trabajo",
      usuarioId: ux,
      trabajoId: trabajoX,
      entidad: "cliente",
      clienteId: cx.id,
      datos: { cambios: { ventas_mixtas: [false, true] } },
    });
  });

  it("el trabajo gana a app.user_id: aunque el contexto traiga otro userId, usuario_id sigue siendo creado_por", async () => {
    const { filas } = await ec.capturar(X, "cliente.editado", () =>
      ec.comoWorker(X, { trabajoId: trabajoX, userId: otro }, (tx) => editarComoWorker(tx, cx.id)),
    );
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["trabajo", ux, trabajoX]]);
  });

  it("un trabajo sin creado_por deja actor `trabajo` con usuario_id NULL", async () => {
    const { filas } = await ec.capturar(X, "cliente.editado", () =>
      ec.comoWorker(X, { trabajoId: trabajoSinAutor }, (tx) => editarComoWorker(tx, cx.id)),
    );
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["trabajo", null, trabajoSinAutor]]);
  });

  it("un app.trabajo_id de OTRO estudio revierte la accion: ni el cambio ni la fila quedan (falla cerrado)", async () => {
    const antes = (await admin.query("select ventas_mixtas from cliente where id = $1", [cx.id])).rows[0].ventas_mixtas;
    const n = await ec.cuantas(X);
    await expect(ec.comoWorker(X, { trabajoId: trabajoY }, (tx) => editarComoWorker(tx, cx.id))).rejects.toThrow();
    expect((await admin.query("select ventas_mixtas from cliente where id = $1", [cx.id])).rows[0].ventas_mixtas).toBe(antes);
    expect(await ec.cuantas(X)).toBe(n);
  });

  it("un app.trabajo_id inexistente revierte la accion (falla cerrado)", async () => {
    const antes = (await admin.query("select ventas_mixtas from cliente where id = $1", [cx.id])).rows[0].ventas_mixtas;
    const n = await ec.cuantas(X);
    await expect(ec.comoWorker(X, { trabajoId: uuidAjeno() }, (tx) => editarComoWorker(tx, cx.id))).rejects.toThrow();
    expect((await admin.query("select ventas_mixtas from cliente where id = $1", [cx.id])).rows[0].ventas_mixtas).toBe(antes);
    expect(await ec.cuantas(X)).toBe(n);
  });

  it("el worker sin trabajoId ni userId deja actor `sistema`; con solo userId, `usuario`", async () => {
    const a = await ec.capturar(X, "cliente.editado", () => ec.comoWorker(X, {}, (tx) => editarComoWorker(tx, cx.id)));
    expect(a.filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["sistema", null, null]]);
    const b = await ec.capturar(X, "cliente.editado", () => ec.comoWorker(X, { userId: otro }, (tx) => editarComoWorker(tx, cx.id)));
    expect(b.filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["usuario", otro, null]]);
  });
});

describe("CA-4 · app.trabajo_id con el rol backend se ignora", () => {
  it("el backend con un trabajoId valido de su estudio NO registra actor `trabajo`: queda `usuario` (o `sistema` sin userId)", async () => {
    const a = await ec.capturar(X, "cliente.editado", () =>
      ec.backend.withTenant({ tenantId: X, userId: otro, trabajoId: trabajoX }, (tx) => editarComoWorker(tx, cx.id)),
    );
    expect(a.filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["usuario", otro, null]]);
    const b = await ec.capturar(X, "cliente.editado", () =>
      ec.backend.withTenant({ tenantId: X, trabajoId: trabajoX }, (tx) => editarComoWorker(tx, cx.id)),
    );
    expect(b.filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["sistema", null, null]]);
  });

  it("fijar app.trabajo_id a mano con set_config en una transaccion del backend tampoco cambia el actor", async () => {
    const { filas } = await ec.capturar(X, "cliente.editado", () =>
      ec.comoBackend(X, ux, async (tx) => {
        await tx.query("select set_config('app.trabajo_id', $1, true)", [trabajoSinAutor]);
        await editarComoWorker(tx, cx.id);
      }),
    );
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["usuario", ux, null]]);
  });

  it("incluso un app.trabajo_id de otro estudio o inexistente en el backend no revierte ni cambia nada (se ignora)", async () => {
    const { filas } = await ec.capturar(X, "cliente.editado", () =>
      ec.comoBackend(X, ux, async (tx) => {
        await tx.query("select set_config('app.trabajo_id', $1, true)", [trabajoY]);
        await editarComoWorker(tx, cx.id);
      }),
    );
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["usuario", ux, null]]);
  });
});

describe("CA-4 · actor `sistema` y sesion", () => {
  it("sin contexto de usuario (superusuario de la siembra) la fila es `sistema`, sin usuario_id ni trabajo_id", async () => {
    const { filas } = await ec.capturar(X, "cliente.creado", async () => ec.cliente(X));
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["sistema", null, null]]);
  });

  it("el backend sin userId deja `sistema`", async () => {
    const { filas } = await ec.capturar(X, "cliente.creado", () => ec.comoBackend(X, undefined, (tx) => accionDeUsuario(tx, rucNuevo())));
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id])).toEqual([["sistema", null]]);
  });

  it("sesion.ingreso (auth): el actor es el usuario de la sesion aunque no haya app.user_id (p_usuario_fila)", async () => {
    const u = await ec.ea.cuenta();
    await ec.ea.membresia(X, u.id, "contador");
    const { filas } = await ec.capturar(X, "sesion.ingreso", async () => {
      await ec.ea.esc.sesion(u.id, X);
    });
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id, f.trabajo_id])).toEqual([["usuario", u.id, null]]);
  });

  it("el parametro p_usuario_fila no se puede falsificar: la app no ejecuta auditoria_registrar (ver auditoria-tablas) y app.user_id manda", async () => {
    // Con app.user_id fijado, una fila de sesion lleva ESE usuario, no el de la fila (regla 2 antes que 3).
    const u = await ec.ea.cuenta();
    await ec.ea.membresia(X, u.id, "contador");
    const { filas } = await ec.capturar(X, "sesion.ingreso", async () => {
      const c = await admin.connect();
      try {
        await c.query("BEGIN");
        await c.query("select set_config('app.user_id', $1, true)", [otro]);
        await c.query(
          `insert into auth.sesion (token_hash, usuario_id, tenant_activo, expira_absoluta)
           values (decode(md5(random()::text) || md5(random()::text), 'hex'), $1, $2, now() + interval '1 hour')`,
          [u.id, X],
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    });
    expect(filas.map((f) => [f.actor_tipo, f.usuario_id])).toEqual([["usuario", otro]]);
  });
});
