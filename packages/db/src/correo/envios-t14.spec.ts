// Spec 028 (T14): pruebas propias de `tomarEnvioParaEnviar` (R-3, R-12: preferencia, «todos los clientes» y plan leídos en la misma toma que
// el envío), de la validación de `cerrarEnvio` y `fijarPreferencias`, de `leerDestinatario` como función `SECURITY DEFINER` y de los valores
// vacíos del ciclo. Con BD real (rol worker y backend) y con `tx` falsa para la forma de las respuestas. Necesita DATABASE_URL y
// MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cerrarEnvio,
  crearResumenesCorreo,
  encolarAvisosCorreo,
  fijarPreferencias,
  leerDestinatario,
  purgarCorreo,
  tomarEnvio,
  tomarEnvioParaEnviar,
} from "./index";
import {
  abrirArnes,
  capturarCriticos,
  crearResumenDelDia,
  desactivarMiembro,
  diaLima,
  envioPendiente,
  falla,
  fijar,
  type Arnes,
} from "./soporte-prueba";
import { txFalso } from "../trabajos/soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const NO_EXISTE = "00000000-0000-4000-8000-00000000dead";
const E = "0190a000-0000-7000-8000-0000000000e1";

describe("tomarEnvioParaEnviar contra la BD (R-3, R-9, R-12)", () => {
  it("devuelve el envío tomado y la revalidación: preferencia activa, no «todos los clientes» y plan vigente con avisos y resumen", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const r = await h.comoWorker(e, (tx) => tomarEnvioParaEnviar(tx, envio));
    expect(r).toEqual({
      envio: {
        id: envio,
        usuarioId: e.dueno.id,
        tipo: "buzon_critico",
        origen: "aviso",
        intentos: 1,
        diaLima: null,
        corteDesde: null,
      },
      preferencia: true,
      todosClientes: false,
      plan: { vigente: true, avisos: true, resumen: true },
    });
    const { rows } = await h.admin.query(
      "select tomado_en, intentos from correo_envio where id = $1",
      [envio],
    );
    expect(rows[0].tomado_en).toBeInstanceOf(Date);
    expect(rows[0].intentos).toBe(1);
  });

  it("cada toma suma un intento, igual que tomarEnvio", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    await h.comoWorker(e, (tx) => tomarEnvioParaEnviar(tx, envio));
    const segunda = await h.comoWorker(e, (tx) =>
      tomarEnvioParaEnviar(tx, envio),
    );
    expect(segunda.envio.intentos).toBe(2);
    expect((await h.comoWorker(e, (tx) => tomarEnvio(tx, envio))).intentos).toBe(
      3,
    );
  });

  it("un envío de un tipo que el usuario no tiene activo sale con preferencia false (R-3: plan_limite es solo del Dueño por omisión)", async () => {
    const e = await h.nuevoEstudio();
    const { rows } = await h.admin.query(
      `insert into correo_envio (tenant_id, usuario_id, tipo, origen, estado, clave)
       values ($1, $2, 'plan_limite', 'aviso', 'pendiente', 't14-' || gen_random_uuid()::text) returning id`,
      [e.tenantId, e.contador.id],
    );
    const r = await h.comoWorker(e, (tx) =>
      tomarEnvioParaEnviar(tx, String(rows[0].id)),
    );
    expect(r.preferencia).toBe(false);
    expect(r.plan.vigente).toBe(true);
    expect(r.envio.tipo).toBe("plan_limite");
  });

  it("resumen: trae el día, el corte y «todos los clientes» según la preferencia de resumen", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("admin");
    await fijar(h, e, u, { resumen: true, todosClientes: true });
    const dia = await diaLima(h, 0);
    const envio = await crearResumenDelDia(h, e, dia, u);
    const r = await h.comoWorker(e, (tx) => tomarEnvioParaEnviar(tx, envio));
    expect(r.envio).toMatchObject({
      id: envio,
      tipo: "resumen",
      origen: "resumen",
      diaLima: dia,
      corteDesde: null,
    });
    expect(r.preferencia).toBe(true);
    expect(r.todosClientes).toBe(true);
  });

  it("un plan sin `correo_avisos` ni `correo_resumen` sale vigente pero sin ellos (R-12)", async () => {
    const e = await h.nuevoEstudio({
      features: { correo_avisos: false, correo_resumen: false },
    });
    // Sin `correo_avisos` no se registran avisos (R-12): se siembra el envío a mano para leer el plan.
    const { rows } = await h.admin.query(
      `insert into correo_envio (tenant_id, usuario_id, tipo, origen, estado, clave)
       values ($1, $2, 'buzon_critico', 'aviso', 'pendiente', 't14-' || gen_random_uuid()::text) returning id`,
      [e.tenantId, e.dueno.id],
    );
    const r = await h.comoWorker(e, (tx) =>
      tomarEnvioParaEnviar(tx, String(rows[0].id)),
    );
    expect(r.plan).toEqual({ vigente: true, avisos: false, resumen: false });
  });

  it.each(["prueba_vencida", null] as const)(
    "con la suscripción %s el plan sale sin vigencia, avisos ni resumen",
    async (suscripcion) => {
      const e = await h.nuevoEstudio({ suscripcion });
      const { rows } = await h.admin.query(
        `insert into correo_envio (tenant_id, usuario_id, tipo, origen, estado, clave)
         values ($1, $2, 'buzon_critico', 'aviso', 'pendiente', 't14-' || gen_random_uuid()::text) returning id`,
        [e.tenantId, e.dueno.id],
      );
      const r = await h.comoWorker(e, (tx) =>
        tomarEnvioParaEnviar(tx, String(rows[0].id)),
      );
      expect(r.plan).toEqual({ vigente: false, avisos: false, resumen: false });
    },
  );

  it("un envío ajeno, de otro estudio o inexistente es P0002; el id mal formado, también y sin ir a la BD", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    expect(
      (
        await falla(
          h.comoWorker(h.B, (tx) => tomarEnvioParaEnviar(tx, envio)),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          h.comoWorker(e, (tx) => tomarEnvioParaEnviar(tx, NO_EXISTE)),
        )
      ).codigo,
    ).toBe("P0002");
    const { tx, llamadas } = txFalso({ rows: [] });
    expect((await falla(tomarEnvioParaEnviar(tx, "x"))).codigo).toBe("P0002");
    expect(llamadas).toHaveLength(0);
    // El envío ajeno no se tomó (sin intentos).
    const { rows } = await h.admin.query(
      "select intentos, tomado_en from correo_envio where id = $1",
      [envio],
    );
    expect(rows[0].intentos).toBe(0);
    expect(rows[0].tomado_en).toBeNull();
  });

  it("solo el worker: el backend no ejecuta la función (42501)", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const envio = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const r = await falla(
      h.comoUsuario(e, e.dueno, (tx) => tomarEnvioParaEnviar(tx, envio)),
    );
    expect(r.codigo).toBe("42501");
  });
});

describe("tomarEnvioParaEnviar (sin BD)", () => {
  const fila = (extra: Record<string, unknown> = {}) => ({
    envioId: E,
    usuarioId: "0190a000-0000-7000-8000-0000000000a1",
    tipo: "resumen",
    origen: "resumen",
    intentos: 2,
    diaLima: "2026-11-23",
    corteDesde: "2026-11-22T12:00:00.000Z",
    preferencia: true,
    todosClientes: true,
    plan: { vigente: true, avisos: false, resumen: true },
    ...extra,
  });

  it("llama a correo_envio_tomar con el id y mapea la respuesta", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ r: fila() }] });
    const r = await tomarEnvioParaEnviar(tx, E);
    expect(llamadas[0]!.texto).toMatch(/correo_envio_tomar\(/);
    expect(llamadas[0]!.valores).toEqual([E]);
    expect(r).toEqual({
      envio: {
        id: E,
        usuarioId: "0190a000-0000-7000-8000-0000000000a1",
        tipo: "resumen",
        origen: "resumen",
        intentos: 2,
        diaLima: "2026-11-23",
        corteDesde: new Date("2026-11-22T12:00:00.000Z"),
      },
      preferencia: true,
      todosClientes: true,
      plan: { vigente: true, avisos: false, resumen: true },
    });
  });

  it("sin plan, o con valores que no son booleanos, nada se da por cierto (falla cerrado)", async () => {
    const sinPlan = await tomarEnvioParaEnviar(
      txFalso({
        rows: [
          {
            r: fila({
              plan: null,
              preferencia: "true",
              todosClientes: 1,
              diaLima: null,
              corteDesde: null,
            }),
          },
        ],
      }).tx,
      E,
    );
    expect(sinPlan).toMatchObject({
      preferencia: false,
      todosClientes: false,
      plan: { vigente: false, avisos: false, resumen: false },
    });
    expect(sinPlan.envio.diaLima).toBeNull();
    expect(sinPlan.envio.corteDesde).toBeNull();
    const parcial = await tomarEnvioParaEnviar(
      txFalso({ rows: [{ r: fila({ plan: { vigente: true, avisos: "si" } }) }] })
        .tx,
      E,
    );
    expect(parcial.plan).toEqual({ vigente: true, avisos: false, resumen: false });
  });

  it("una respuesta vacía, nula o que no es un objeto es P0002", async () => {
    for (const rows of [[], [{ r: null }], [{ r: undefined }], [{ r: "x" }]]) {
      expect(
        (await falla(tomarEnvioParaEnviar(txFalso({ rows }).tx, E))).codigo,
      ).toBe("P0002");
    }
  });
});

describe("cerrarEnvio y fijarPreferencias: validación de forma (sin BD)", () => {
  it.each([
    ["una fecha de corte que no es Date", "2026-11-21T12:00:00.000Z"],
    ["una fecha de corte inválida", new Date("no es fecha")],
    ["un número como corte", 1_700_000_000_000],
  ])("cerrarEnvio con %s es 22023 sin ir a la BD", async (_nombre, corte) => {
    const { tx, llamadas } = txFalso({ rows: [] });
    const e = await falla(
      cerrarEnvio(tx, E, { estado: "enviado", corteHasta: corte as never }),
    );
    expect(e.codigo).toBe("22023");
    expect(llamadas).toHaveLength(0);
  });

  it.each([null, undefined, "x", 7, [], [true]])(
    "fijarPreferencias con %j (no es un objeto con las cinco claves) es 22023 sin ir a la BD",
    async (entrada) => {
      const { tx, llamadas } = txFalso({ rows: [] });
      const e = await falla(fijarPreferencias(tx, entrada as never));
      expect(e.codigo).toBe("22023");
      expect(llamadas).toHaveLength(0);
    },
  );
});

describe("valores vacíos del ciclo (sin BD)", () => {
  it("sin fila de respuesta, encolar, crear y purgar devuelven 0", async () => {
    expect(await encolarAvisosCorreo(txFalso({ rows: [] }).tx, 10)).toBe(0);
    expect(await crearResumenesCorreo(txFalso({ rows: [] }).tx, "2026-11-23")).toBe(
      0,
    );
    expect(await purgarCorreo(txFalso({ rows: [] }).tx, 90)).toBe(0);
  });

  it("con la fila de respuesta nula también devuelven 0", async () => {
    const nula = { rows: [{ encolar_correo_avisos: null }] };
    expect(await encolarAvisosCorreo(txFalso(nula).tx, 10)).toBe(0);
    expect(await purgarCorreo(txFalso({ rows: [{ x: null }] }).tx, 90)).toBe(0);
  });
});

describe("correo_destinatario como función de la BD (R-3, H9)", () => {
  it("el backend no la ejecuta (42501): solo el worker lee el correo de un miembro", async () => {
    const e = await h.nuevoEstudio();
    const r = await falla(
      h.comoUsuario(e, e.dueno, (tx) => leerDestinatario(tx, e.contador.id)),
    );
    expect(r.codigo).toBe("42501");
  });

  it("sin estudio en la sesión (worker de sistema) es 42501 y no devuelve correos", async () => {
    const e = await h.nuevoEstudio();
    const r = await falla(h.sistema((tx) => leerDestinatario(tx, e.dueno.id)));
    expect(r.codigo).toBe("42501");
  });

  it("un miembro desactivado y luego un usuario de otro estudio no salen, pero el activo del estudio sí", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("asistente");
    expect(
      (await h.comoWorker(e, (tx) => leerDestinatario(tx, u.id)))?.email,
    ).toBe(u.email);
    await desactivarMiembro(h, e, u);
    expect(await h.comoWorker(e, (tx) => leerDestinatario(tx, u.id))).toBeNull();
    expect(
      await h.comoWorker(h.A, (tx) => leerDestinatario(tx, u.id)),
    ).toBeNull();
  });

  it("la respuesta solo trae las cuatro claves del contrato (sin contraseña, hash ni otros datos del usuario)", async () => {
    const e = await h.nuevoEstudio();
    const d = await h.comoWorker(e, (tx) => leerDestinatario(tx, e.dueno.id));
    expect(Object.keys(d ?? {}).sort()).toEqual([
      "email",
      "estudioNombre",
      "rol",
      "usuarioId",
    ]);
  });
});
