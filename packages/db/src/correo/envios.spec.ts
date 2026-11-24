// Spec 028 (T4, rojo): envíos, avisos de un envío y destinatario (R-3, R-6, R-9, R-11, R-12; CA-3, CA-9) contra la BD real con el rol
// worker, más una `tx` falsa para las validaciones de forma y la traducción de errores. Necesita DATABASE_URL y
// MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/correo/envios.ts`; los tipos están en los stubs):
//   tomarEnvio(tx, envioId) -> EnvioTomado {id, usuarioId, tipo, origen, intentos, diaLima, corteDesde}: marca `tomado_en`, suma un
//     intento (1 en la primera toma). Solo el worker (el backend: 42501). Envío ajeno, de otro estudio, inexistente o con el id mal
//     formado: P0002 (este último sin ir a la BD). En `resumen`, `corteDesde` = `corte_hasta` del último resumen anterior del usuario
//     en el estudio que quedó `enviado` u `omitido` por `sin_novedades` (R-13); un `fallido` u `omitido` por otro motivo no cuenta.
//   cerrarEnvio(tx, envioId, {estado, motivo?, corteHasta?}): fija el estado (`enviado` fija `enviado_en`), el motivo y `corte_hasta`.
//     22023 con un estado fuera de enviado|omitido|fallido o un motivo fuera de la lista de R-3 más `transporte`; P0002 ajeno.
//   leerAvisosEnvio(tx, envioId) -> AvisoEnvio[]: los avisos del envío (no los diferidos) en orden cronológico (`creada_en`, id), solo
//     los que siguen visibles para el usuario del envío: sin cliente siempre; con cliente, no archivado y dentro de su alcance
//     (global para dueno y admin; asignado para el resto). `fecha` = fecha del mensaje de buzón en `buzon_critico`; `creada_en` de
//     la notificación en los demás. Nunca asunto, remitente, RUC ni nada de los centinelas (R-6). Un envío ajeno no devuelve filas
//     (o P0002).
//   leerDestinatario(tx, usuarioId) -> {usuarioId, email, rol, estudioNombre} con la membresía activa y el correo vigente; null si la
//     membresía está desactivada, el usuario no es miembro del estudio del contexto o no existe; id mal formado: P0002 sin ir a la BD.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cerrarEnvio,
  leerAvisosEnvio,
  leerDestinatario,
  tomarEnvio,
} from "./index";
import {
  ASUNTO_CANARIO,
  UUID,
  abrirArnes,
  archivar,
  asignarCliente,
  capturarCriticos,
  cerrarComoWorker,
  crearResumenDelDia,
  desactivarMiembro,
  diaLima,
  envioPendiente,
  falla,
  fijar,
  invalidarCredencial,
  llevarAlNoventaDelPlan,
  notificacionDeMensaje,
  pruebasTraduccion,
  retirarAsignacion,
  type Arnes,
} from "./soporte-prueba";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const NO_EXISTE = "00000000-0000-4000-8000-00000000dead";

describe("leerAvisosEnvio (R-3, R-6, R-11)", () => {
  it("lista los avisos del envío con razón social, categoría y la fecha del mensaje, en orden cronológico, sin datos del mensaje", async () => {
    const e = await h.nuevoEstudio();
    const x1 = await e.nuevoCliente({ razonSocial: "Alfa Sociedad T4" });
    const x2 = await e.nuevoCliente({ razonSocial: "Beta Sociedad T4" });
    await asignarCliente(h, e, x1, e.contador, "responsable");
    await asignarCliente(h, e, x2, e.contador, "responsable");
    const orden: string[] = [];
    const fechas = new Map<string, Date>();
    for (const [cliente, dias] of [
      [x1, 5],
      [x2, 4],
      [x1, 3],
    ] as const) {
      const fecha = new Date(
        Math.floor(Date.now() / 1000) * 1000 - dias * 86_400_000,
      );
      const { ids } = await capturarCriticos(h, e, cliente, 1, { fecha });
      orden.push(await notificacionDeMensaje(h, e, e.contador, ids[0]!));
      fechas.set(orden.at(-1)!, fecha);
    }
    const envio = await envioPendiente(h, e, e.contador, "buzon_critico");
    const avisos = await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, envio));
    expect(avisos.map((a) => a.notificacionId)).toEqual(orden);
    expect(avisos.map((a) => a.razonSocial)).toEqual([
      "Alfa Sociedad T4",
      "Beta Sociedad T4",
      "Alfa Sociedad T4",
    ]);
    for (const a of avisos) {
      expect(a).toEqual({
        notificacionId: a.notificacionId,
        tipo: "buzon_critico",
        clienteId: expect.stringMatching(UUID),
        razonSocial: expect.any(String),
        categoria: "coactiva",
        recurso: null,
        porcentaje: null,
        fecha: fechas.get(a.notificacionId),
      });
    }
    const crudo = JSON.stringify(avisos);
    expect(crudo).not.toContain(ASUNTO_CANARIO);
    expect(crudo).not.toContain(x1.ruc);
    expect(crudo).not.toContain("SUNAT");
  });

  it("quita lo que dejó de ser visible: asignación retirada y cliente archivado (R-3, CA-3)", async () => {
    const e = await h.nuevoEstudio();
    const [x1, x2, x3] = [
      await e.nuevoCliente(),
      await e.nuevoCliente(),
      await e.nuevoCliente(),
    ] as const;
    for (const c of [x1, x2, x3])
      await asignarCliente(h, e, c, e.contador, "responsable");
    for (const c of [x1, x1, x2, x3]) await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.contador, "buzon_critico");
    const clientesDe = async () =>
      (await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, envio))).map(
        (a) => a.clienteId,
      );
    expect(await clientesDe()).toEqual([x1.id, x1.id, x2.id, x3.id]);
    await retirarAsignacion(h, e, x1, e.contador);
    expect(await clientesDe()).toEqual([x2.id, x3.id]);
    await archivar(h, e, x2);
    expect(await clientesDe()).toEqual([x3.id]);
    await archivar(h, e, x3);
    expect(await clientesDe()).toEqual([]);
  });

  it("el Dueño (alcance global) ve los clientes sin asignar, pero no los archivados", async () => {
    const e = await h.nuevoEstudio();
    const x = await e.nuevoCliente();
    const y = await e.nuevoCliente();
    await capturarCriticos(h, e, x, 1);
    await capturarCriticos(h, e, y, 2);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const clientes = async () =>
      (await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, envio))).map(
        (a) => a.clienteId,
      );
    expect((await clientes()).sort()).toEqual([x.id, y.id, y.id].sort());
    await archivar(h, e, y);
    expect(await clientes()).toEqual([x.id]);
  });

  it("un aviso de otro usuario del mismo estudio no entra al envío (cada usuario, su envío)", async () => {
    const e = await h.nuevoEstudio();
    const x = await e.nuevoCliente();
    const y = await e.nuevoCliente();
    await asignarCliente(h, e, x, e.contador, "responsable");
    await capturarCriticos(h, e, x, 1); // para el contador (responsable)
    await capturarCriticos(h, e, y, 1); // sin responsable: para los Dueños
    const delContador = await envioPendiente(h, e, e.contador, "buzon_critico");
    const delDueno = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const a = await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, delContador));
    const b = await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, delDueno));
    expect(a.map((f) => f.clienteId)).toEqual([x.id]);
    expect(b.map((f) => f.clienteId)).toEqual([y.id]);
  });

  it("credencial_invalida: cliente, razón social y fecha de la notificación; sin categoría", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente({ razonSocial: "Gamma Sociedad T4" });
    await invalidarCredencial(h, e, c);
    const envio = await envioPendiente(h, e, e.dueno, "credencial_invalida");
    const { rows } = await h.admin.query(
      "select id, creada_en from notificacion where tenant_id = $1 and usuario_id = $2 and tipo = 'credencial_invalida'",
      [e.tenantId, e.dueno.id],
    );
    const avisos = await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, envio));
    expect(avisos).toEqual([
      {
        notificacionId: rows[0].id,
        tipo: "credencial_invalida",
        clienteId: c.id,
        razonSocial: "Gamma Sociedad T4",
        categoria: null,
        recurso: null,
        porcentaje: null,
        fecha: rows[0].creada_en,
      },
    ]);
  });

  it("plan_limite: sin cliente (siempre visible), con recurso y porcentaje del umbral", async () => {
    const e = await h.nuevoEstudio({ maxRucs: 10 });
    await llevarAlNoventaDelPlan(h, e);
    const envio = await envioPendiente(h, e, e.dueno, "plan_limite");
    const { rows } = await h.admin.query(
      "select id, creada_en from notificacion where tenant_id = $1 and usuario_id = $2 and tipo = 'plan_limite'",
      [e.tenantId, e.dueno.id],
    );
    expect(rows).toHaveLength(1);
    const avisos = await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, envio));
    expect(avisos).toEqual([
      {
        notificacionId: rows[0].id,
        tipo: "plan_limite",
        clienteId: null,
        razonSocial: null,
        categoria: null,
        recurso: "rucs",
        porcentaje: 90,
        fecha: rows[0].creada_en,
      },
    ]);
  });

  it("50 avisos de un cliente en una captura llegan los 50 (el recorte a 20 es del dominio)", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 50);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const avisos = await h.comoWorker(e, (tx) => leerAvisosEnvio(tx, envio));
    expect(avisos).toHaveLength(50);
    expect(new Set(avisos.map((a) => a.notificacionId)).size).toBe(50);
  });

  it("un envío de otro estudio no devuelve nada (o P0002); con el id mal formado, P0002 sin ir a la BD", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const desdeB = await h
      .comoWorker(h.B, (tx) => leerAvisosEnvio(tx, envio))
      .then(
        (r) => r,
        (x: unknown) => x,
      );
    if (Array.isArray(desdeB)) expect(desdeB).toEqual([]);
    else expect((desdeB as { codigo?: string }).codigo).toBe("P0002");
    const { tx, llamadas } = txFalso({ rows: [] });
    expect((await falla(leerAvisosEnvio(tx, "no-es-uuid"))).codigo).toBe(
      "P0002",
    );
    expect(llamadas).toHaveLength(0);
  });
});

describe("leerDestinatario (R-3)", () => {
  it("devuelve correo, rol y nombre del estudio de la membresía activa", async () => {
    const e = await h.nuevoEstudio();
    const d = await h.comoWorker(e, (tx) => leerDestinatario(tx, e.dueno.id));
    expect(d).toEqual({
      usuarioId: e.dueno.id,
      email: e.dueno.email,
      rol: "dueno",
      estudioNombre: e.nombre,
    });
    const c = await h.comoWorker(e, (tx) =>
      leerDestinatario(tx, e.contador.id),
    );
    expect(c).toEqual({
      usuarioId: e.contador.id,
      email: e.contador.email,
      rol: "contador",
      estudioNombre: e.nombre,
    });
  });

  it("con la membresía desactivada devuelve null (membresia_inactiva)", async () => {
    const e = await h.nuevoEstudio();
    await desactivarMiembro(h, e, e.contador);
    expect(
      await h.comoWorker(e, (tx) => leerDestinatario(tx, e.contador.id)),
    ).toBeNull();
  });

  it("si cambió su correo devuelve el vigente (sale al nuevo)", async () => {
    const e = await h.nuevoEstudio();
    const nuevo = `nuevo-${e.dueno.id}@ejemplo.test`;
    await h.admin.query("update usuario set email = $2 where id = $1", [
      e.dueno.id,
      nuevo,
    ]);
    const d = await h.comoWorker(e, (tx) => leerDestinatario(tx, e.dueno.id));
    expect(d?.email).toBe(nuevo);
  });

  it("un usuario de otro estudio o inexistente devuelve null; con el estudio correcto sí lo ve", async () => {
    const e = await h.nuevoEstudio();
    expect(
      await h.comoWorker(e, (tx) => leerDestinatario(tx, h.B.dueno.id)),
    ).toBeNull();
    expect(
      await h.comoWorker(e, (tx) => leerDestinatario(tx, NO_EXISTE)),
    ).toBeNull();
  });

  it("un usuario en dos estudios: el nombre y el rol son los del estudio del contexto (R-4)", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    const u = await e1.nuevoUsuario("contador");
    await e2.unir(u, "admin");
    const en1 = await h.comoWorker(e1, (tx) => leerDestinatario(tx, u.id));
    const en2 = await h.comoWorker(e2, (tx) => leerDestinatario(tx, u.id));
    expect(en1).toMatchObject({ rol: "contador", estudioNombre: e1.nombre });
    expect(en2).toMatchObject({ rol: "admin", estudioNombre: e2.nombre });
  });

  it("id mal formado: P0002 sin ir a la BD", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect((await falla(leerDestinatario(tx, "x"))).codigo).toBe("P0002");
    expect(llamadas).toHaveLength(0);
  });
});

describe("tomarEnvio (R-9)", () => {
  it("devuelve el envío, marca tomado_en y suma un intento por toma", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 2);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const primera = await h.comoWorker(e, (tx) => tomarEnvio(tx, envio));
    expect(primera).toEqual({
      id: envio,
      usuarioId: e.dueno.id,
      tipo: "buzon_critico",
      origen: "aviso",
      intentos: 1,
      diaLima: null,
      corteDesde: null,
    });
    const { rows } = await h.admin.query(
      "select tomado_en, intentos, estado from correo_envio where id = $1",
      [envio],
    );
    expect(rows[0].tomado_en).toBeInstanceOf(Date);
    expect(rows[0].intentos).toBe(1);
    expect(rows[0].estado).toBe("pendiente");
    const segunda = await h.comoWorker(e, (tx) => tomarEnvio(tx, envio));
    expect(segunda.intentos).toBe(2);
  });

  it("uno ya tomado deja de ser «pendiente sin tomar»: la siguiente captura abre otro envío (D-2)", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const primero = await envioPendiente(h, e, e.dueno, "buzon_critico");
    await h.comoWorker(e, (tx) => tomarEnvio(tx, primero));
    await capturarCriticos(h, e, c, 1);
    const segundo = await envioPendiente(h, e, e.dueno, "buzon_critico");
    expect(segundo).not.toBe(primero);
  });

  it("un envío ajeno, de otro estudio o inexistente es P0002; el id mal formado, también y sin ir a la BD", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    expect(
      (await falla(h.comoWorker(h.B, (tx) => tomarEnvio(tx, envio)))).codigo,
    ).toBe("P0002");
    expect(
      (await falla(h.comoWorker(e, (tx) => tomarEnvio(tx, NO_EXISTE)))).codigo,
    ).toBe("P0002");
    const { tx, llamadas } = txFalso({ rows: [] });
    expect((await falla(tomarEnvio(tx, "no-es-uuid"))).codigo).toBe("P0002");
    expect(llamadas).toHaveLength(0);
    // Y no sumó intentos al ajeno.
    const { rows } = await h.admin.query(
      "select intentos from correo_envio where id = $1",
      [envio],
    );
    expect(rows[0].intentos).toBe(0);
  });

  it("solo el worker: el backend no ejecuta la función (42501)", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const err = await falla(
      h.comoUsuario(e, e.dueno, (tx) => tomarEnvio(tx, envio)),
    );
    expect(err.codigo).toBe("42501");
  });

  it("resumen: trae el día de Lima y el corte del último resumen cerrado (enviado u omitido por sin_novedades), no el de un fallido", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    await fijar(h, e, u, { resumen: true });
    const d3 = await diaLima(h, 3);
    const d2 = await diaLima(h, 2);
    const d1 = await diaLima(h, 1);
    const d0 = await diaLima(h, 0);
    const r3 = await crearResumenDelDia(h, e, d3, u);
    const primero = await h.comoWorker(e, (tx) => tomarEnvio(tx, r3));
    expect(primero).toEqual({
      id: r3,
      usuarioId: u.id,
      tipo: "resumen",
      origen: "resumen",
      intentos: 1,
      diaLima: d3,
      corteDesde: null,
    });
    const corte3 = new Date("2026-11-21T12:00:00.123Z");
    await cerrarComoWorker(h, e, r3, { estado: "enviado", corteHasta: corte3 });

    const r2 = await crearResumenDelDia(h, e, d2, u);
    expect(
      (await h.comoWorker(e, (tx) => tomarEnvio(tx, r2))).corteDesde,
    ).toEqual(corte3);
    const corte2 = new Date("2026-11-22T12:00:00.456Z");
    await cerrarComoWorker(h, e, r2, {
      estado: "omitido",
      motivo: "sin_novedades",
      corteHasta: corte2,
    });

    const r1 = await crearResumenDelDia(h, e, d1, u);
    expect(
      (await h.comoWorker(e, (tx) => tomarEnvio(tx, r1))).corteDesde,
    ).toEqual(corte2);
    await cerrarComoWorker(h, e, r1, {
      estado: "fallido",
      motivo: "transporte",
    });

    const r0 = await crearResumenDelDia(h, e, d0, u);
    const ultimo = await h.comoWorker(e, (tx) => tomarEnvio(tx, r0));
    expect(ultimo.corteDesde).toEqual(corte2);
    expect(ultimo.diaLima).toBe(d0);
  });

  it("un omitido por otro motivo (preferencia_apagada) no mueve el corte", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    await fijar(h, e, u, { resumen: true });
    const r2 = await crearResumenDelDia(h, e, await diaLima(h, 2), u);
    await h.comoWorker(e, (tx) => tomarEnvio(tx, r2));
    await cerrarComoWorker(h, e, r2, {
      estado: "omitido",
      motivo: "sin_plan",
      corteHasta: null,
    });
    const r1 = await crearResumenDelDia(h, e, await diaLima(h, 1), u);
    expect(
      (await h.comoWorker(e, (tx) => tomarEnvio(tx, r1))).corteDesde,
    ).toBeNull();
  });

  it("el corte de un resumen no cruza a otro usuario ni a otro estudio", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    const u = await e1.nuevoUsuario("contador");
    await e2.unir(u, "contador");
    const otro = await e1.nuevoUsuario("contador");
    for (const [e, x] of [
      [e1, u],
      [e1, otro],
      [e2, u],
    ] as const)
      await fijar(h, e, x, { resumen: true });
    const ayer = await diaLima(h, 1);
    const hoy = await diaLima(h, 0);
    const r = await crearResumenDelDia(h, e1, ayer, u);
    await h.comoWorker(e1, (tx) => tomarEnvio(tx, r));
    await cerrarComoWorker(h, e1, r, {
      estado: "enviado",
      corteHasta: new Date("2026-11-22T12:00:00.000Z"),
    });
    const deOtro = await crearResumenDelDia(h, e1, hoy, otro);
    const enE2 = await crearResumenDelDia(h, e2, hoy, u);
    expect(
      (await h.comoWorker(e1, (tx) => tomarEnvio(tx, deOtro))).corteDesde,
    ).toBeNull();
    expect(
      (await h.comoWorker(e2, (tx) => tomarEnvio(tx, enE2))).corteDesde,
    ).toBeNull();
  });
});

describe("cerrarEnvio (R-3, R-9)", () => {
  const nuevoEnvio = async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    await h.comoWorker(e, (tx) => tomarEnvio(tx, envio));
    return { e, envio };
  };
  const leer = async (id: string) =>
    (
      await h.admin.query(
        "select estado, motivo, corte_hasta, enviado_en from correo_envio where id = $1",
        [id],
      )
    ).rows[0] as {
      estado: string;
      motivo: string | null;
      corte_hasta: Date | null;
      enviado_en: Date | null;
    };

  it("enviado: fija enviado_en y el corte", async () => {
    const { e, envio } = await nuevoEnvio();
    const corte = new Date("2026-11-23T10:15:30.789Z");
    await h.comoWorker(e, (tx) =>
      cerrarEnvio(tx, envio, { estado: "enviado", corteHasta: corte }),
    );
    const f = await leer(envio);
    expect(f.estado).toBe("enviado");
    expect(f.motivo).toBeNull();
    expect(f.corte_hasta).toEqual(corte);
    expect(f.enviado_en).toBeInstanceOf(Date);
  });

  it.each([
    "membresia_inactiva",
    "sin_correo",
    "preferencia_apagada",
    "sin_plan",
    "sin_contenido",
    "sin_novedades",
  ] as const)(
    "omitido por %s: guarda el motivo y no fija enviado_en",
    async (motivo) => {
      const { e, envio } = await nuevoEnvio();
      await h.comoWorker(e, (tx) =>
        cerrarEnvio(tx, envio, { estado: "omitido", motivo }),
      );
      const f = await leer(envio);
      expect(f).toMatchObject({
        estado: "omitido",
        motivo,
        corte_hasta: null,
        enviado_en: null,
      });
    },
  );

  it("fallido por transporte: sin texto de error, solo el código", async () => {
    const { e, envio } = await nuevoEnvio();
    await h.comoWorker(e, (tx) =>
      cerrarEnvio(tx, envio, { estado: "fallido", motivo: "transporte" }),
    );
    expect(await leer(envio)).toMatchObject({
      estado: "fallido",
      motivo: "transporte",
      enviado_en: null,
    });
  });

  it.each([
    ["estado pendiente", { estado: "pendiente" }],
    ["estado desconocido", { estado: "cancelado" }],
    ["motivo fuera de la lista", { estado: "omitido", motivo: "porque_si" }],
    [
      "motivo con texto de usuario",
      { estado: "fallido", motivo: "correo ana@ejemplo.test" },
    ],
  ])("%s: 22023 y el envío queda como estaba", async (_n, cierre) => {
    const { e, envio } = await nuevoEnvio();
    const err = await falla(
      h.comoWorker(e, (tx) => cerrarEnvio(tx, envio, cierre as never)),
    );
    expect(err.codigo).toBe("22023");
    expect((await leer(envio)).estado).toBe("pendiente");
  });

  it("un envío ajeno o inexistente es P0002 y no cambia; solo el worker (el backend: 42501)", async () => {
    const { e, envio } = await nuevoEnvio();
    expect(
      (
        await falla(
          h.comoWorker(h.B, (tx) =>
            cerrarEnvio(tx, envio, { estado: "enviado" }),
          ),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          h.comoWorker(e, (tx) =>
            cerrarEnvio(tx, NO_EXISTE, { estado: "enviado" }),
          ),
        )
      ).codigo,
    ).toBe("P0002");
    expect((await leer(envio)).estado).toBe("pendiente");
    expect(
      (
        await falla(
          h.comoUsuario(e, e.dueno, (tx) =>
            cerrarEnvio(tx, envio, { estado: "enviado" }),
          ),
        )
      ).codigo,
    ).toBe("42501");
  });

  it("id mal formado: P0002 sin ir a la BD", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(
      (await falla(cerrarEnvio(tx, "x", { estado: "enviado" }))).codigo,
    ).toBe("P0002");
    expect(llamadas).toHaveLength(0);
  });
});

describe("llamadas a las funciones de 0074 (sin BD)", () => {
  const E = "0190a000-0000-7000-8000-0000000000e1";

  it("tomarEnvio llama a correo_envio_tomar con el id del envío como único parámetro", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await tomarEnvio(tx, E).catch((e: unknown) => {
      // Con la respuesta vacía de la tx falsa la implementación real puede lanzar; el stub rojo debe seguir viéndose como tal.
      if (e instanceof Error && e.message.startsWith("no implementado"))
        throw e;
    });
    expect(llamadas[0]!.texto).toMatch(/correo_envio_tomar\(/);
    expect(llamadas[0]!.valores).toEqual([E]);
  });

  it("cerrarEnvio llama a correo_envio_cerrar(envío, estado, motivo, corte) con null por omisión", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await cerrarEnvio(tx, E, { estado: "enviado" });
    expect(llamadas[0]!.texto).toMatch(/correo_envio_cerrar\(/);
    expect(llamadas[0]!.valores).toEqual([E, "enviado", null, null]);
    const corte = new Date("2026-11-21T12:00:00.000Z");
    const otra = txFalso({ rows: [] });
    await cerrarEnvio(otra.tx, E, {
      estado: "omitido",
      motivo: "sin_novedades",
      corteHasta: corte,
    });
    expect(otra.llamadas[0]!.valores).toEqual([
      E,
      "omitido",
      "sin_novedades",
      corte,
    ]);
  });

  it("un SQLSTATE desconocido sale como CorreoRepoError «desconocido»", async () => {
    const e = await falla(tomarEnvio(txFalso(errorPg(undefined)).tx, E));
    expect(e.codigo).toBe("desconocido");
  });
});

pruebasTraduccion([
  [
    "tomarEnvio",
    (tx) => tomarEnvio(tx, "0190a000-0000-7000-8000-0000000000e1"),
  ],
  [
    "cerrarEnvio",
    (tx) =>
      cerrarEnvio(tx, "0190a000-0000-7000-8000-0000000000e1", {
        estado: "fallido",
        motivo: "transporte",
      }),
  ],
  [
    "leerAvisosEnvio",
    (tx) => leerAvisosEnvio(tx, "0190a000-0000-7000-8000-0000000000e1"),
  ],
  [
    "leerDestinatario",
    (tx) => leerDestinatario(tx, "0190a000-0000-7000-8000-0000000000a1"),
  ],
]);
