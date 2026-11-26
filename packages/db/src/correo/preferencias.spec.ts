// Spec 028 (T4, rojo): preferencias de correo del usuario de la sesión (R-10, R-15, D-7; CA-1, CA-12) contra la BD real con el rol
// backend (con usuario) y una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si
// faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/correo/preferencias.ts`):
//   leerPreferencias(tx) -> PreferenciasLeidas del usuario de la sesión (`app.user_id`) en el estudio activo. Sin filas son las
//     iniciales por rol (U-1, U-8): buzonCritico y credencialInvalida true para todos, planLimite true solo para `dueno`, resumen
//     false, todosClientes false. `todosDisponible` = rol dueno o admin y ninguna asignación; `todosIgnorado` = marcada (guardada
//     true) y hoy no disponible; `invitacionResumen` = no existe la fila del resumen; `ultimoEnvioFallido` = `creado_en` del último
//     envío del usuario en el estudio si está `fallido`, o null. Leer no crea filas.
//   fijarPreferencias(tx, {buzonCritico, credencialInvalida, planLimite, resumen, todosClientes}) -> lo mismo que
//     `leerPreferencias` justo después, en la misma transacción. Crea las 4 filas si faltan. Audita (`correo.preferencia_cambiada`,
//     actor usuario) SOLO cada cambio real respecto del valor efectivo, con `datos` exactos {tipo, de, a, origen: "app"}; «todos los
//     clientes» audita con tipo "resumen_todos". Apagar un tipo deja `omitido` (`preferencia_apagada`) los envíos `pendiente` sin
//     tomar de ese tipo (D-7). Errores (CorreoRepoError.codigo): 42501 sin usuario, con la membresía desactivada o «todos» con un rol
//     que no es dueno ni admin; CA430 «todos» con asignaciones; 22023 con claves de más o de menos o valores no booleanos. Un error no
//     deja nada escrito (ni filas ni auditoría).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fijarPreferencias, leerPreferencias, tomarEnvio } from "./index";
import {
  abrirArnes,
  asignarCliente,
  cerrarComoWorker,
  capturarCriticos,
  desactivarMiembro,
  envioPendiente,
  falla,
  fijar,
  invalidarCredencial,
  pruebasTraduccion,
  type Arnes,
  type Rol,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const CAMBIADA = "correo.preferencia_cambiada";

const auditoria = async (tenantId: string, usuarioId: string) => {
  const { rows } = await h.admin.query(
    `select actor_tipo, usuario_id, accion, datos from auditoria
      where tenant_id = $1 and accion = $2 and usuario_id = $3 order by ocurrida_en, id`,
    [tenantId, CAMBIADA, usuarioId],
  );
  return rows as Array<{
    actor_tipo: string;
    usuario_id: string;
    accion: string;
    datos: unknown;
  }>;
};

const filas = async (tenantId: string, usuarioId: string) => {
  const { rows } = await h.admin.query(
    `select tipo, activo, todos_clientes from correo_preferencia where tenant_id = $1 and usuario_id = $2 order by tipo`,
    [tenantId, usuarioId],
  );
  return rows as Array<{
    tipo: string;
    activo: boolean;
    todos_clientes: boolean;
  }>;
};

describe("preferencias efectivas sin filas (R-15, U-1, U-8, CA-1)", () => {
  it.each<Rol>(["dueno", "admin", "contador", "asistente", "lectura"])(
    "%s: críticos y clave inválida activados, resumen apagado, límite del plan solo para el Dueño, con invitación",
    async (rol) => {
      const e = await h.nuevoEstudio();
      const u = rol === "dueno" ? e.dueno : await e.nuevoUsuario(rol);
      const p = await h.comoUsuario(e, u, (tx) => leerPreferencias(tx));
      expect(p).toEqual({
        buzonCritico: true,
        credencialInvalida: true,
        planLimite: rol === "dueno",
        resumen: false,
        todosClientes: false,
        todosDisponible: rol === "dueno" || rol === "admin",
        todosIgnorado: false,
        invitacionResumen: true,
        ultimoEnvioFallido: null,
      });
      // Leer no crea filas.
      expect(await filas(e.tenantId, u.id)).toEqual([]);
    },
  );

  it("las filas del estudio no cambian lo efectivo de quien no tiene (dos usuarios del mismo rol)", async () => {
    const e = await h.nuevoEstudio();
    const a = await e.nuevoUsuario("contador");
    const b = await e.nuevoUsuario("contador");
    await fijar(h, e, a, { buzonCritico: false, resumen: true });
    const delB = await h.comoUsuario(e, b, (tx) => leerPreferencias(tx));
    expect(delB.buzonCritico).toBe(true);
    expect(delB.resumen).toBe(false);
    expect(delB.invitacionResumen).toBe(true);
    const delA = await h.comoUsuario(e, a, (tx) => leerPreferencias(tx));
    expect(delA.buzonCritico).toBe(false);
    expect(delA.resumen).toBe(true);
    expect(delA.invitacionResumen).toBe(false);
  });

  it("un usuario en dos estudios tiene preferencias separadas por estudio (R-4)", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    const u = await e1.nuevoUsuario("contador");
    await e2.unir(u, "contador");
    await fijar(h, e1, u, { credencialInvalida: false, resumen: true });
    const en2 = await h.comoUsuario(e2, u, (tx) => leerPreferencias(tx));
    expect(en2.credencialInvalida).toBe(true);
    expect(en2.resumen).toBe(false);
    expect(en2.invitacionResumen).toBe(true);
    expect(await filas(e2.tenantId, u.id)).toEqual([]);
    const en1 = await h.comoUsuario(e1, u, (tx) => leerPreferencias(tx));
    expect(en1.credencialInvalida).toBe(false);
    expect(en1.resumen).toBe(true);
  });
});

describe("fijarPreferencias: filas y auditoría (R-10, CA-1)", () => {
  it("guardar los mismos valores efectivos crea las 4 filas, quita la invitación y no audita", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const devuelto = await h.comoUsuario(e, u, async (tx) => {
      const r = await fijarPreferencias(tx, {
        buzonCritico: true,
        credencialInvalida: true,
        planLimite: false,
        resumen: false,
        todosClientes: false,
      });
      expect(r).toEqual(await leerPreferencias(tx));
      return r;
    });
    expect(devuelto.invitacionResumen).toBe(false);
    expect(await filas(e.tenantId, u.id)).toEqual([
      { tipo: "buzon_critico", activo: true, todos_clientes: false },
      { tipo: "credencial_invalida", activo: true, todos_clientes: false },
      { tipo: "plan_limite", activo: false, todos_clientes: false },
      { tipo: "resumen", activo: false, todos_clientes: false },
    ]);
    expect(await auditoria(e.tenantId, u.id)).toEqual([]);
  });

  it("un cambio deja una fila de auditoría con los datos exactos y actor usuario; repetir no audita", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    await fijar(h, e, u, { buzonCritico: false });
    const a = await auditoria(e.tenantId, u.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({
      actor_tipo: "usuario",
      usuario_id: u.id,
      accion: CAMBIADA,
      datos: { tipo: "buzon_critico", de: true, a: false, origen: "app" },
    });
    await fijar(h, e, u, { buzonCritico: false });
    expect(await auditoria(e.tenantId, u.id)).toHaveLength(1);
    // Volver a activar también es un cambio.
    await fijar(h, e, u, { buzonCritico: true });
    const b = await auditoria(e.tenantId, u.id);
    expect(b.map((f) => f.datos)).toEqual([
      { tipo: "buzon_critico", de: true, a: false, origen: "app" },
      { tipo: "buzon_critico", de: false, a: true, origen: "app" },
    ]);
  });

  it("el Dueño parte con el límite del plan activado: apagarlo audita de true a false", async () => {
    const e = await h.nuevoEstudio();
    await fijar(h, e, e.dueno, { planLimite: false });
    expect(
      (await auditoria(e.tenantId, e.dueno.id)).map((f) => f.datos),
    ).toEqual([{ tipo: "plan_limite", de: true, a: false, origen: "app" }]);
  });

  it("varios cambios a la vez dejan una fila por cada uno y solo por los que cambiaron", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("admin");
    await fijar(h, e, u, {
      buzonCritico: false,
      credencialInvalida: false,
      resumen: true,
    });
    const datos = (await auditoria(e.tenantId, u.id)).map((f) => f.datos);
    expect(datos).toHaveLength(3);
    expect(datos).toEqual(
      expect.arrayContaining([
        { tipo: "buzon_critico", de: true, a: false, origen: "app" },
        { tipo: "credencial_invalida", de: true, a: false, origen: "app" },
        { tipo: "resumen", de: false, a: true, origen: "app" },
      ]),
    );
  });

  it("los datos de la auditoría solo llevan la lista blanca: ningún id, correo ni nombre", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    await fijar(h, e, u, { resumen: true });
    const [f] = await auditoria(e.tenantId, u.id);
    expect(Object.keys(f!.datos as object).sort()).toEqual([
      "a",
      "de",
      "origen",
      "tipo",
    ]);
  });
});

describe("«todos los clientes» (R-13, U-3; CA-12)", () => {
  it("un Dueño sin asignaciones lo marca: queda disponible, no ignorado, y audita resumen_todos", async () => {
    const e = await h.nuevoEstudio();
    await fijar(h, e, e.dueno, { resumen: true, todosClientes: true });
    const p = await h.comoUsuario(e, e.dueno, (tx) => leerPreferencias(tx));
    expect(p).toMatchObject({
      resumen: true,
      todosClientes: true,
      todosDisponible: true,
      todosIgnorado: false,
    });
    expect(
      (await auditoria(e.tenantId, e.dueno.id)).map((f) => f.datos),
    ).toEqual(
      expect.arrayContaining([
        { tipo: "resumen", de: false, a: true, origen: "app" },
        { tipo: "resumen_todos", de: false, a: true, origen: "app" },
      ]),
    );
    // Desmarcar también audita.
    await fijar(h, e, e.dueno, { resumen: true, todosClientes: false });
    const ultima = (await auditoria(e.tenantId, e.dueno.id)).at(-1)!;
    expect(ultima.datos).toEqual({
      tipo: "resumen_todos",
      de: true,
      a: false,
      origen: "app",
    });
  });

  it("un Administrador sin asignaciones también puede", async () => {
    const e = await h.nuevoEstudio();
    const adm = await e.nuevoUsuario("admin");
    await fijar(h, e, adm, { todosClientes: true });
    expect(
      (await h.comoUsuario(e, adm, (tx) => leerPreferencias(tx))).todosClientes,
    ).toBe(true);
  });

  it.each<Rol>(["contador", "asistente", "lectura"])(
    "un %s lo marca: 42501 y no queda nada escrito",
    async (rol) => {
      const e = await h.nuevoEstudio();
      const u = await e.nuevoUsuario(rol);
      const err = await falla(
        h.comoUsuario(e, u, (tx) =>
          fijarPreferencias(tx, {
            buzonCritico: false,
            credencialInvalida: true,
            planLimite: false,
            resumen: true,
            todosClientes: true,
          }),
        ),
      );
      expect(err.codigo).toBe("42501");
      expect(await filas(e.tenantId, u.id)).toEqual([]);
      expect(await auditoria(e.tenantId, u.id)).toEqual([]);
    },
  );

  it("un Dueño con asignaciones lo marca: CA430, sin escrituras parciales; la opción no está disponible", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, e.dueno, "colaborador");
    const err = await falla(
      h.comoUsuario(e, e.dueno, (tx) =>
        fijarPreferencias(tx, {
          buzonCritico: false,
          credencialInvalida: true,
          planLimite: true,
          resumen: true,
          todosClientes: true,
        }),
      ),
    );
    expect(err.codigo).toBe("CA430");
    expect(await filas(e.tenantId, e.dueno.id)).toEqual([]);
    expect(await auditoria(e.tenantId, e.dueno.id)).toEqual([]);
    const p = await h.comoUsuario(e, e.dueno, (tx) => leerPreferencias(tx));
    expect(p.todosDisponible).toBe(false);
    expect(p.buzonCritico).toBe(true);
  });

  it("si al Dueño que la marcó le asignan un cliente, la marca queda ignorada (se conserva guardada) y la vista lo dice", async () => {
    const e = await h.nuevoEstudio();
    await fijar(h, e, e.dueno, { resumen: true, todosClientes: true });
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, e.dueno, "responsable");
    const p = await h.comoUsuario(e, e.dueno, (tx) => leerPreferencias(tx));
    expect(p).toMatchObject({
      todosClientes: true,
      todosDisponible: false,
      todosIgnorado: true,
    });
  });

  it("fijar con todos=false cuando está ignorada no falla (solo marcar exige disponibilidad)", async () => {
    const e = await h.nuevoEstudio();
    await fijar(h, e, e.dueno, { resumen: true, todosClientes: true });
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, e.dueno, "responsable");
    await fijar(h, e, e.dueno, { resumen: true, todosClientes: false });
    const p = await h.comoUsuario(e, e.dueno, (tx) => leerPreferencias(tx));
    expect(p).toMatchObject({ todosClientes: false, todosIgnorado: false });
  });
});

describe("apagar un tipo (D-7)", () => {
  it("deja `omitido` (preferencia_apagada) los envíos pendientes sin tomar de ese tipo y no toca los otros", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 2);
    await invalidarCredencial(h, e, c);
    const critico = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const credencial = await envioPendiente(
      h,
      e,
      e.dueno,
      "credencial_invalida",
    );
    await fijar(h, e, e.dueno, { buzonCritico: false });
    const { rows } = await h.admin.query(
      "select id, estado, motivo from correo_envio where id = any($1::uuid[]) order by id",
      [[critico, credencial]],
    );
    const por = new Map(rows.map((f) => [f.id as string, f]));
    expect(por.get(critico)).toMatchObject({
      estado: "omitido",
      motivo: "preferencia_apagada",
    });
    expect(por.get(credencial)).toMatchObject({
      estado: "pendiente",
      motivo: null,
    });
  });

  it("no toca un envío que el worker ya tomó (lo revalida al enviar, R-3) ni los de otro usuario", async () => {
    const e = await h.nuevoEstudio();
    const adm = await e.nuevoUsuario("admin");
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const delDueno = await envioPendiente(h, e, e.dueno, "buzon_critico");
    const delAdmin = await envioPendiente(h, e, adm, "buzon_critico");
    await h.comoWorker(e, (tx) => tomarEnvio(tx, delDueno));
    await fijar(h, e, e.dueno, { buzonCritico: false });
    const { rows } = await h.admin.query(
      "select id, estado from correo_envio where id = any($1::uuid[])",
      [[delDueno, delAdmin]],
    );
    const por = new Map(rows.map((f) => [f.id as string, f.estado as string]));
    expect(por.get(delDueno)).toBe("pendiente");
    expect(por.get(delAdmin)).toBe("pendiente");
  });
});

describe("aislamiento por usuario y por estudio (CA-1)", () => {
  it("cada uno lee y cambia solo lo suyo; lo ajeno no se ve ni se toca", async () => {
    const e = await h.nuevoEstudio();
    const otro = await e.nuevoUsuario("contador");
    await fijar(h, e, otro, { buzonCritico: false, resumen: true });
    const delDueno = await h.comoUsuario(e, e.dueno, (tx) =>
      leerPreferencias(tx),
    );
    expect(delDueno.buzonCritico).toBe(true);
    expect(delDueno.resumen).toBe(false);
    await fijar(h, e, e.dueno, { credencialInvalida: false });
    const delOtro = await h.comoUsuario(e, otro, (tx) => leerPreferencias(tx));
    expect(delOtro).toMatchObject({
      buzonCritico: false,
      credencialInvalida: true,
      resumen: true,
    });
    expect(await filas(e.tenantId, otro.id)).toHaveLength(4);
  });
});

describe("último envío fallido (R-9, CA-10)", () => {
  it("con el último envío `fallido` trae su fecha; un envío posterior `enviado` la quita; otros usuarios no la ven", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await capturarCriticos(h, e, c, 1);
    const id = await envioPendiente(h, e, e.dueno, "buzon_critico");
    await h.comoWorker(e, (tx) => tomarEnvio(tx, id));
    await cerrarComoWorker(h, e, id, {
      estado: "fallido",
      motivo: "transporte",
    });
    const { rows } = await h.admin.query(
      "select creado_en from correo_envio where id = $1",
      [id],
    );
    const p = await h.comoUsuario(e, e.dueno, (tx) => leerPreferencias(tx));
    expect(p.ultimoEnvioFallido).toBeInstanceOf(Date);
    expect(p.ultimoEnvioFallido!.getTime()).toBe(
      (rows[0].creado_en as Date).getTime(),
    );
    const adm = await e.nuevoUsuario("admin");
    expect(
      (await h.comoUsuario(e, adm, (tx) => leerPreferencias(tx)))
        .ultimoEnvioFallido,
    ).toBeNull();
    // Otro envío posterior (otra captura: el anterior ya no está pendiente) que sale bien.
    await capturarCriticos(h, e, c, 1);
    const siguiente = await envioPendiente(h, e, e.dueno, "buzon_critico");
    expect(siguiente).not.toBe(id);
    await h.comoWorker(e, (tx) => tomarEnvio(tx, siguiente));
    await cerrarComoWorker(h, e, siguiente, {
      estado: "enviado",
      corteHasta: null,
    });
    expect(
      (await h.comoUsuario(e, e.dueno, (tx) => leerPreferencias(tx)))
        .ultimoEnvioFallido,
    ).toBeNull();
  });

  it("un fallido de otro estudio del mismo usuario no cuenta", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    const u = await e1.nuevoUsuario("admin");
    await e2.unir(u, "admin");
    const c = await e1.nuevoCliente();
    await capturarCriticos(h, e1, c, 1);
    const id = await envioPendiente(h, e1, u, "buzon_critico");
    await h.comoWorker(e1, (tx) => tomarEnvio(tx, id));
    await cerrarComoWorker(h, e1, id, {
      estado: "fallido",
      motivo: "transporte",
    });
    expect(
      (await h.comoUsuario(e1, u, (tx) => leerPreferencias(tx)))
        .ultimoEnvioFallido,
    ).toBeInstanceOf(Date);
    expect(
      (await h.comoUsuario(e2, u, (tx) => leerPreferencias(tx)))
        .ultimoEnvioFallido,
    ).toBeNull();
  });
});

describe("entradas inválidas y contexto (22023, 42501)", () => {
  const valido = {
    buzonCritico: true,
    credencialInvalida: true,
    planLimite: false,
    resumen: false,
    todosClientes: false,
  };

  it.each([
    ["falta una clave", { ...valido, resumen: undefined }],
    ["clave de más (usuarioId)", { ...valido, usuarioId: "x" }],
    ["clave de más (tenantId)", { ...valido, tenantId: "x" }],
    ["valor no booleano (texto)", { ...valido, buzonCritico: "true" }],
    ["valor no booleano (número)", { ...valido, planLimite: 1 }],
    ["valor nulo", { ...valido, todosClientes: null }],
  ])("%s: 22023 y nada escrito", async (_nombre, entrada) => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const err = await falla(
      h.comoUsuario(e, u, (tx) => fijarPreferencias(tx, entrada as never)),
    );
    expect(err.codigo).toBe("22023");
    expect(await filas(e.tenantId, u.id)).toEqual([]);
  });

  it("sin usuario en el contexto: 42501 al leer y al escribir", async () => {
    const e = await h.nuevoEstudio();
    expect(
      (await falla(h.sinUsuario(e, (tx) => leerPreferencias(tx)))).codigo,
    ).toBe("42501");
    expect(
      (await falla(h.sinUsuario(e, (tx) => fijarPreferencias(tx, valido))))
        .codigo,
    ).toBe("42501");
  });

  it("con la membresía desactivada: 42501 al escribir y nada escrito", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    await desactivarMiembro(h, e, u);
    const err = await falla(
      h.comoUsuario(e, u, (tx) => fijarPreferencias(tx, valido)),
    );
    expect(err.codigo).toBe("42501");
    expect(await filas(e.tenantId, u.id)).toEqual([]);
  });

  it("un usuario que no es miembro del estudio: 42501 al escribir", async () => {
    const e = await h.nuevoEstudio();
    const ajeno = await h.B.nuevoUsuario("contador");
    const err = await falla(
      h.comoUsuario(e, ajeno, (tx) => fijarPreferencias(tx, valido)),
    );
    expect(err.codigo).toBe("42501");
    expect(await filas(e.tenantId, ajeno.id)).toEqual([]);
  });
});

pruebasTraduccion([
  ["leerPreferencias", (tx) => leerPreferencias(tx)],
  [
    "fijarPreferencias",
    (tx) =>
      fijarPreferencias(tx, {
        buzonCritico: true,
        credencialInvalida: true,
        planLimite: false,
        resumen: false,
        todosClientes: false,
      }),
  ],
]);
