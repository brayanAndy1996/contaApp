import { randomBytes } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  APP_ORIGIN,
  CorreoMemoria,
  CorreoNoEnviadoError,
  CorreoQueFalla,
  CorreoQueMuere,
  EscenarioCorreo,
  ProgramacionCorreo,
  contar,
  ctxEnvio,
  fechaLima,
  sha256Texto,
  tokenDe,
  type Correo,
} from "../../../test/correo.js";
import { canario, fugas, loggerEspia, volcado } from "../../../test/soporte.js";
import { crearDbAdmin, crearDbRol } from "../../../test/trabajos.js";
import type { LoggerTrabajos } from "../registro.js";
import { enviarCorreo } from "./enviar-correo.js";

// Spec 028, T5 (rojo; integración con PostgreSQL real): el procesador de `notificacion.enviar` (R-1, R-3, R-6, R-8, R-9, R-12 a R-14;
// CA-3 a CA-6, CA-9 a CA-11). Los hechos nacen por su camino real (críticos insertados como el worker, `marcarCredencialInvalida`,
// 90 % del plan, preferencias por `correo_preferencias_fijar`); el envío lo toma, revalida, lee, arma y entrega con `CorreoMemoria`.
// CONTRATO que fija (T11): el de test/correo.ts (cabecera): `enviarCorreo({db, correo, appOrigin, logger?, reloj?, intentosMax?})`
// devuelve el `Procesador` de `notificacion.enviar`; resultado `{estado, avisos|clientes}` | `{estado:"omitido", motivo}` |
// `{estado:"fallido", motivo:"transporte"}`; un fallo del transporte lanza `CorreoNoEnviadoError` salvo en el último intento.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let e: EscenarioCorreo;
let prog: ProgramacionCorreo;
let correo: CorreoMemoria;

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 8);
  prog = new ProgramacionCorreo(admin);
  await prog.guardar();
});

beforeEach(() => {
  e = new EscenarioCorreo(admin, backend, worker);
  correo = new CorreoMemoria();
});

afterEach(async () => {
  await e.limpiar();
  await prog.restaurar();
});

afterAll(async () => {
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

function procesador(
  o: { correo?: Correo; logger?: LoggerTrabajos; intentosMax?: number } = {},
) {
  return enviarCorreo({
    db: worker,
    correo: o.correo ?? correo,
    appOrigin: APP_ORIGIN,
    ...(o.logger === undefined ? {} : { logger: o.logger }),
    ...(o.intentosMax === undefined ? {} : { intentosMax: o.intentosMax }),
  });
}

/** Ejecuta el envío una vez, como lo hace el ejecutor de 008 (el contexto lleva el intento). */
const ejecutar = (
  T: string,
  envioId: string,
  o: Parameters<typeof procesador>[0] & { intento?: number } = {},
): Promise<unknown> => procesador(o)(ctxEnvio(T, envioId, o.intento ?? 1));

/** Estudio con Dueño, un Contador responsable de un cliente y el crítico ya capturado (envío `buzon_critico` pendiente del Contador). */
async function avisoListo(
  o: { estado?: "activa" | "prueba"; razon?: string; features?: Record<string, unknown> } = {},
) {
  const T = await e.estudioPlan({
    ...(o.estado === undefined ? {} : { estado: o.estado }),
    ...(o.features === undefined ? {} : { features: o.features }),
  });
  const dueno = await e.usuario(T, "dueno");
  const contador = await e.usuario(T, "contador");
  const c = await e.clienteCon(T, o.razon ?? "Cliente Alfa SAC");
  await e.responsable(T, c, contador);
  await e.fijar(T, contador); // crea las cuatro filas con los valores iniciales
  const { fecha } = await e.capturar(T, c);
  const envio = await e.envioDe(T, { usuarioId: contador, tipo: "buzon_critico" });
  return { T, dueno, contador, c, envio, fecha };
}

const unico = (): CorreoMemoria["enviados"][number] => {
  expect(correo.enviados).toHaveLength(1);
  return correo.enviados[0]!;
};

// ---------------------------------------------------------------------------------------------------------------
// El correo de aviso (R-2, R-6, R-7, R-9)
// ---------------------------------------------------------------------------------------------------------------

describe("aviso de buzón crítico: contenido, enlaces y baja", () => {
  it("sale al correo del usuario con asunto fijo, razón social, categoría, fecha de Lima, enlaces y token de baja; queda `enviado`", async () => {
    const { T, contador, c, envio, fecha } = await avisoListo();
    const r = await ejecutar(T, envio.id);

    expect(r).toEqual({ estado: "enviado", avisos: 1 });
    const m = unico();
    expect(m.para).toBe(await e.emailDe(contador));
    expect(m.asunto).toBe("Coactiva y avisos críticos del buzón · Cliente Alfa SAC");
    expect(m.idMensaje, "Message-ID fijo por envío (R-9)").toBe(envio.id);
    expect(m.html).toBeTruthy();
    for (const cuerpo of [m.texto, m.html!]) {
      expect(cuerpo).toContain("Cliente Alfa SAC");
      expect(cuerpo).toContain("Coactiva");
      expect(cuerpo).toContain(fechaLima(fecha));
      expect(cuerpo).toContain(`${await e.nombreEstudio(T)} · ContApp`);
      expect(cuerpo, "el RUC nunca va").not.toContain(c.ruc);
    }
    expect(m.texto).toContain(`${APP_ORIGIN}/ir?estudio=${T}`);
    const token = tokenDe(m.baja!.url);
    expect(m.baja!.url.startsWith(`${APP_ORIGIN}/`)).toBe(true);
    expect(m.texto).toContain(`${APP_ORIGIN}/baja?t=${token}`);

    const fila = await e.envio(envio.id);
    expect(fila).toMatchObject({ estado: "enviado", motivo: null, intentos: 1 });
    expect(fila.enviado_en).not.toBeNull();
    const tokens = await e.tokensDe(envio.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ usuario_id: contador, tipo: "buzon_critico" });
    expect(Buffer.compare(tokens[0]!.hash, sha256Texto(token)), "la BD guarda solo el hash").toBe(0);
    const dias = (tokens[0]!.vence_en.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(89);
    expect(dias).toBeLessThan(91);
  });

  it("clave SOL inválida y límite del plan: asunto fijo de cada tipo", async () => {
    const T = await e.estudioPlan({ maxRucs: 10 });
    const dueno = await e.usuario(T, "dueno");
    const contador = await e.usuario(T, "contador");
    const c = await e.clienteCon(T, "Cliente Beta EIRL");
    await e.responsable(T, c, contador);
    await e.invalidarCredencial(T, c);
    const credencial = await e.envioDe(T, { usuarioId: contador, tipo: "credencial_invalida" });
    await e.llevarAl90(T);
    const limite = await e.envioDe(T, { usuarioId: dueno, tipo: "plan_limite" });

    expect(await ejecutar(T, credencial.id)).toEqual({ estado: "enviado", avisos: 1 });
    expect(correo.enviados[0]!.asunto).toBe("Clave SOL inválida · Cliente Beta EIRL");
    expect(await ejecutar(T, limite.id)).toEqual({ estado: "enviado", avisos: 1 });
    expect(correo.enviados[1]!.asunto).toMatch(/^Tu estudio llegó al 90 % de \S+/);
    expect(correo.enviados[1]!.texto).toContain("90 %");
    expect(correo.enviados[1]!.para).toBe(await e.emailDe(dueno));
    expect((await e.tokensDe(limite.id))[0]).toMatchObject({ tipo: "plan_limite" });
  });

  it("un estudio en prueba vigente recibe el aviso (R-12, U-15)", async () => {
    const { T, envio } = await avisoListo({ estado: "prueba" });
    expect(await ejecutar(T, envio.id)).toEqual({ estado: "enviado", avisos: 1 });
    expect(correo.enviados).toHaveLength(1);
  });

  it("si el usuario cambió su correo, sale al nuevo (R-3)", async () => {
    const { T, contador, envio } = await avisoListo();
    const nuevo = `nuevo-${randomBytes(4).toString("hex")}@prueba.contapp.test`;
    await admin.pool.query("update usuario set email = $2 where id = $1", [contador, nuevo]);
    await ejecutar(T, envio.id);
    expect(unico().para).toBe(nuevo);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-3: revalidar al enviar
// ---------------------------------------------------------------------------------------------------------------

type Listo = Awaited<ReturnType<typeof avisoListo>>;
const OMISIONES: { nombre: string; motivo: string; opciones?: Parameters<typeof avisoListo>[0]; preparar: (x: Listo) => Promise<void> }[] = [
  {
    nombre: "el usuario se desactivó",
    motivo: "membresia_inactiva",
    preparar: (x) => e.desactivarMembresia(x.T, x.dueno, x.contador),
  },
  {
    nombre: "el usuario ya no tiene correo",
    motivo: "sin_correo",
    preparar: async (x) => {
      await admin.pool.query("update usuario set email = '' where id = $1", [x.contador]);
    },
  },
  {
    nombre: "apagó la preferencia (por fuera de la función, con el envío ya pendiente)",
    motivo: "preferencia_apagada",
    preparar: async (x) => {
      await admin.pool.query(
        "update correo_preferencia set activo = false where tenant_id = $1 and usuario_id = $2 and tipo = 'buzon_critico'",
        [x.T, x.contador],
      );
    },
  },
  {
    nombre: "el estudio perdió la suscripción",
    motivo: "sin_plan",
    preparar: async (x) => {
      await admin.pool.query("delete from suscripcion where tenant_id = $1", [x.T]);
    },
  },
  {
    nombre: "la prueba del estudio venció",
    motivo: "sin_plan",
    opciones: { estado: "prueba" },
    preparar: async (x) => {
      await admin.pool.query(
        "update suscripcion set prueba_vence_en = now() - interval '1 day' where tenant_id = $1",
        [x.T],
      );
    },
  },
  {
    nombre: "el plan apagó `correo_avisos`",
    motivo: "sin_plan",
    preparar: async (x) => {
      await admin.pool.query(
        `update plan set features = '{"correo_avisos": false}'::jsonb where id = (select plan_id from suscripcion where tenant_id = $1)`,
        [x.T],
      );
    },
  },
  {
    nombre: "el cliente se archivó",
    motivo: "sin_contenido",
    preparar: (x) => e.archivar(x.T, x.dueno, x.c),
  },
  {
    nombre: "el usuario perdió la asignación del cliente",
    motivo: "sin_contenido",
    preparar: (x) => e.desasignar(x.T, x.dueno, x.c, x.contador),
  },
];

describe("CA-3: revalidar al enviar (R-3, R-12, D-7)", () => {
  it.each(OMISIONES)("$nombre → `omitido` $motivo y no se manda nada", async ({ motivo, opciones, preparar }) => {
    const x = await avisoListo(opciones);
    await preparar(x);

    expect(await ejecutar(x.T, x.envio.id)).toEqual({ estado: "omitido", motivo });
    expect(correo.enviados, "CorreoMemoria no recibe nada").toHaveLength(0);
    expect(await e.envio(x.envio.id)).toMatchObject({ estado: "omitido", motivo });
    expect(await e.tokensDe(x.envio.id), "sin correo no hay token").toHaveLength(0);
  });

  it("envío agrupado con dos clientes y uno desasignado: sale solo el otro y se cuenta uno", async () => {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    const contador = await e.usuario(T, "contador");
    const a = await e.clienteCon(T, "Cliente Perdido SAC");
    const b = await e.clienteCon(T, "Cliente Visible SAC");
    for (const c of [a, b]) await e.responsable(T, c, contador);
    await e.capturar(T, a);
    await e.capturar(T, b);
    const envio = await e.envioDe(T, { usuarioId: contador, tipo: "buzon_critico" });
    expect(envio.total_avisos, "la ventana junta las dos capturas (D-2)").toBe(2);
    expect(await e.avisosDe(T, { envioId: envio.id })).toHaveLength(2);

    await e.desasignar(T, dueno, a, contador);
    expect(await ejecutar(T, envio.id)).toEqual({ estado: "enviado", avisos: 1 });
    const m = unico();
    expect(m.texto).toContain("Cliente Visible SAC");
    expect(m.texto).not.toContain("Cliente Perdido SAC");
    expect(m.html).not.toContain("Cliente Perdido SAC");
    expect(m.asunto).toBe("Coactiva y avisos críticos del buzón · Cliente Visible SAC");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-9, R-14: inundación, ventanas y tope
// ---------------------------------------------------------------------------------------------------------------

describe("CA-9: agrupación, 20 avisos por correo y diferidos", () => {
  it("50 críticos de un cliente en una captura: un solo correo con 20 avisos y «y 30 avisos más»", async () => {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente Inundado SAC");
    const { fecha } = await e.capturar(T, c, 50);
    const envio = await e.envioDe(T, { usuarioId: dueno, tipo: "buzon_critico" });
    expect(envio.total_avisos).toBe(50);

    expect(await ejecutar(T, envio.id)).toEqual({ estado: "enviado", avisos: 50 });
    const m = unico();
    expect(contar(m.texto, fechaLima(fecha))).toBe(20);
    expect(contar(m.html!, fechaLima(fecha))).toBe(20);
    expect(contar(m.texto, "y 30 avisos más")).toBe(1);
    expect(contar(m.html!, "y 30 avisos más")).toBe(1);
  });

  it("cinco críticos en dos capturas dentro de la ventana: dos correos (el primero y uno agrupado al cerrar la ventana)", async () => {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    const c = await e.clienteCon(T, "Cliente Ventana SAC");
    await e.capturar(T, c, 2);
    const primero = await e.envioDe(T, { usuarioId: dueno, tipo: "buzon_critico" });
    expect(await ejecutar(T, primero.id)).toEqual({ estado: "enviado", avisos: 2 });

    await e.capturar(T, c, 2);
    await e.capturar(T, c, 1);
    const pendientes = await e.envios(T, { usuarioId: dueno, tipo: "buzon_critico", estado: "pendiente" });
    expect(pendientes, "las dos capturas siguientes comparten el envío de la ventana").toHaveLength(1);
    expect(pendientes[0]!.total_avisos).toBe(3);
    expect(await ejecutar(T, pendientes[0]!.id)).toEqual({ estado: "enviado", avisos: 3 });
    expect(correo.enviados).toHaveLength(2);
    expect(new Set(correo.enviados.map((m) => m.idMensaje)).size).toBe(2);
  });

  async function conTopeAgotado(resumen: boolean) {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    const contador = await e.usuario(T, "contador");
    const c = await e.clienteCon(T, "Cliente Diferido SAC");
    await e.responsable(T, c, contador);
    await e.fijar(T, contador, { resumen });
    await e.sembrarEnviados(T, contador, 30); // el día de Lima ya tiene el tope
    for (let i = 0; i < 3; i++) await e.capturar(T, c);
    const avisos = await e.avisosDe(T, { usuarioId: contador });
    expect(avisos, "pasado el tope quedan diferidos").toHaveLength(3);
    expect(avisos.every((a) => a.envio_id === null && a.diferido_en !== null)).toBe(true);
    return { T, dueno, contador, c };
  }

  it("con el resumen activo, los diferidos salen en el resumen («Avisos que no te enviamos al momento»); ninguno se pierde", async () => {
    const { T, contador } = await conTopeAgotado(true);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const resumen = await e.envioDe(T, { usuarioId: contador, origen: "resumen" });
    const unidos = (await e.avisosDe(T, { envioId: resumen.id })).length;
    expect(unidos, "los diferidos quedan unidos al resumen").toBe(3);

    const r = await ejecutar(T, resumen.id);
    expect(r).toMatchObject({ estado: "enviado" });
    const m = unico();
    expect(m.texto).toContain("Avisos que no te enviamos al momento");
    expect(m.texto).toMatch(/Coactivas y avisos críticos del buzón: 3\b/);
    expect(m.html).toContain("Avisos que no te enviamos al momento");
  });

  it("con el resumen apagado, salen en un correo «Avisos pendientes» por tipo con la baja de ese tipo", async () => {
    const { T, contador } = await conTopeAgotado(false);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const pendientes = await e.envioDe(T, { usuarioId: contador, origen: "pendientes" });
    expect(pendientes.tipo).toBe("buzon_critico");

    expect(await ejecutar(T, pendientes.id)).toMatchObject({ estado: "enviado" });
    const m = unico();
    expect(m.asunto).toBe("Avisos pendientes · Coactivas y avisos críticos del buzón");
    expect(m.texto).toMatch(/Coactivas y avisos críticos del buzón: 3\b/);
    expect(m.baja).toBeTruthy();
    expect((await e.tokensDe(pendientes.id))[0]).toMatchObject({ tipo: "buzon_critico", usuario_id: contador });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-4, CA-5, CA-12: el resumen
// ---------------------------------------------------------------------------------------------------------------

describe("CA-4: contenido del resumen (R-13)", () => {
  async function estudioDelResumen() {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    const contador = await e.usuario(T, "contador");
    await e.fijar(T, contador, { resumen: true });
    return { T, dueno, contador };
  }
  const hace = (ms: number): Date => new Date(Date.now() - ms);
  const HORA = 3_600_000;

  it("Contador con cuatro clientes: solo A (3 nuevos, 1 crítico, 5 pendientes) y B (compras abierto, ventas sin descargar), en un único correo", async () => {
    const { T, dueno, contador } = await estudioDelResumen();
    const periodo = await e.periodoAnterior();
    const A = await e.clienteCon(T, "Alfa Importaciones SAC");
    const B = await e.clienteCon(T, "Beta Servicios EIRL");
    const C = await e.clienteCon(T, "Gamma Sin Asignar SAC");
    const D = await e.clienteCon(T, "Delta Archivado SAC");
    await e.responsable(T, A, contador);
    await e.asignar(T, B.id, contador);
    await e.asignar(T, D.id, contador);
    // A: 3 nuevos (1 crítico) y 2 pendientes de antes; sus periodos ya generados (solo se ve lo de los mensajes).
    await e.sembrarMensajes(T, contador, [
      { clienteId: A.id, critico: true, historico: false, atendido: false, capturadoEn: hace(2 * HORA) },
      { clienteId: A.id, critico: false, historico: false, atendido: false, capturadoEn: hace(3 * HORA) },
      { clienteId: A.id, critico: false, historico: false, atendido: false, capturadoEn: hace(4 * HORA) },
      { clienteId: A.id, critico: false, historico: false, atendido: false, capturadoEn: hace(72 * HORA) },
      { clienteId: A.id, critico: false, historico: false, atendido: false, capturadoEn: hace(96 * HORA) },
      { clienteId: A.id, critico: false, historico: true, atendido: false, capturadoEn: hace(HORA) }, // histórico: no cuenta
    ]);
    for (const libro of ["compras", "ventas"] as const) await e.periodo(T, A, libro, periodo, "generado");
    // B: compras descargadas y abiertas; ventas sin descargar.
    await e.descarga(T, B, "compras", periodo, dueno);
    // C no asignado y D archivado, con mensajes nuevos.
    await e.sembrarMensajes(T, contador, [
      { clienteId: C.id, critico: true, historico: false, atendido: false, capturadoEn: hace(HORA) },
      { clienteId: D.id, critico: true, historico: false, atendido: false, capturadoEn: hace(HORA) },
    ]);
    await e.archivar(T, dueno, D);
    const hoy = (await e.hoyLima()).dia;
    expect(await e.crearResumenes(T, hoy)).toBe(1);
    const envio = await e.envioDe(T, { usuarioId: contador, origen: "resumen" });

    expect(await ejecutar(T, envio.id)).toEqual({ estado: "enviado", clientes: 2 });
    const m = unico();
    expect(m.para).toBe(await e.emailDe(contador));
    expect(m.asunto).toMatch(/^Resumen diario/);
    expect(m.asunto).toContain(await e.nombreEstudio(T));
    for (const cuerpo of [m.texto, m.html!]) {
      expect(cuerpo).toContain("Alfa Importaciones SAC");
      expect(cuerpo).toContain("Beta Servicios EIRL");
      expect(cuerpo).not.toContain("Gamma Sin Asignar SAC");
      expect(cuerpo).not.toContain("Delta Archivado SAC");
      expect(cuerpo).toContain(`${periodo.slice(0, 4)}-${periodo.slice(4)}`);
    }
    expect(m.texto).toContain("3 nuevos, 1 crítico, 5 pendientes de atender");
    expect(m.texto).toContain("Compras: abierto · Ventas: sin descargar");
    expect(m.baja).toBeTruthy();
    expect(m.idMensaje).toBe(envio.id);
    const fila = await e.envio(envio.id);
    expect(fila.estado).toBe("enviado");
    expect(Math.abs(fila.corte_hasta!.getTime() - Date.now()), "el corte es el instante en que se armó").toBeLessThan(60_000);
    expect((await e.tokensDe(envio.id))[0]).toMatchObject({ tipo: "resumen" });
  });

  it("sin mensajes nuevos ni periodos pendientes no se envía (`sin_novedades`) aunque haya pendientes de atender; el corte avanza", async () => {
    const { T, contador } = await estudioDelResumen();
    const periodo = await e.periodoAnterior();
    const A = await e.clienteCon(T, "Alfa Importaciones SAC");
    await e.responsable(T, A, contador);
    for (const libro of ["compras", "ventas"] as const) await e.periodo(T, A, libro, periodo, "generado");
    await e.sembrarMensajes(T, contador, [
      { clienteId: A.id, critico: false, historico: false, atendido: false, capturadoEn: hace(72 * HORA) },
    ]);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const envio = await e.envioDe(T, { usuarioId: contador, origen: "resumen" });

    expect(await ejecutar(T, envio.id)).toEqual({ estado: "omitido", motivo: "sin_novedades" });
    expect(correo.enviados).toHaveLength(0);
    const fila = await e.envio(envio.id);
    expect(fila).toMatchObject({ estado: "omitido", motivo: "sin_novedades" });
    expect(fila.corte_hasta, "el siguiente resumen cuenta desde aquí").not.toBeNull();
  });

  it("el corte es el del resumen anterior y no las 24 h: el lunes cuenta desde el viernes", async () => {
    const { T, contador } = await estudioDelResumen();
    const periodo = await e.periodoAnterior();
    const A = await e.clienteCon(T, "Alfa Importaciones SAC");
    await e.responsable(T, A, contador);
    for (const libro of ["compras", "ventas"] as const) await e.periodo(T, A, libro, periodo, "generado");
    // Resumen anterior (de «el viernes»): ciclo real, cerrado hace 3 días.
    await e.resumenAnterior(T, contador, await e.diaLima(3), hace(72 * HORA));
    await e.sembrarMensajes(T, contador, [
      { clienteId: A.id, critico: false, historico: false, atendido: false, capturadoEn: hace(96 * HORA) }, // antes del corte
      { clienteId: A.id, critico: false, historico: false, atendido: false, capturadoEn: hace(48 * HORA) }, // después del corte, hace más de 24 h
    ]);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const envio = await e.envioDe(T, { usuarioId: contador, origen: "resumen", estado: "pendiente" });

    expect(await ejecutar(T, envio.id)).toEqual({ estado: "enviado", clientes: 1 });
    expect(unico().texto).toMatch(/\b1 nuevo,/);
    expect(unico().texto).toContain("2 pendientes de atender");
  });

  it("un usuario en dos estudios recibe un resumen por estudio y ninguno menciona al otro (CA-5, R-4)", async () => {
    const T1 = await e.estudioPlan();
    const T2 = await e.estudioPlan();
    const u = await e.usuario(T1, "contador");
    await admin.pool.query("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')", [T2, u]);
    const c1 = await e.clienteCon(T1, "Cliente Primero SAC");
    const c2 = await e.clienteCon(T2, "Cliente Segundo SAC");
    await e.responsable(T1, c1, u);
    await e.responsable(T2, c2, u);
    for (const T of [T1, T2]) await e.fijar(T, u, { resumen: true });
    const hoy = (await e.hoyLima()).dia;
    await e.crearResumenes(T1, hoy);
    await e.crearResumenes(T2, hoy);
    const r1 = await e.envioDe(T1, { usuarioId: u, origen: "resumen" });
    const r2 = await e.envioDe(T2, { usuarioId: u, origen: "resumen" });

    await ejecutar(T1, r1.id);
    await ejecutar(T2, r2.id);
    expect(correo.enviados).toHaveLength(2);
    const [m1, m2] = correo.enviados as [CorreoMemoria["enviados"][number], CorreoMemoria["enviados"][number]];
    expect(m1.texto).toContain("Cliente Primero SAC");
    expect(m1.texto + m1.html + m1.asunto).not.toContain("Cliente Segundo SAC");
    expect(m1.texto + m1.html + m1.asunto).not.toContain(await e.nombreEstudio(T2));
    expect(m2.texto).toContain("Cliente Segundo SAC");
    expect(m2.texto + m2.html + m2.asunto).not.toContain("Cliente Primero SAC");
    expect(m2.texto + m2.html + m2.asunto).not.toContain(await e.nombreEstudio(T1));
  });

  it("el tope diario de un estudio no consume el del otro (CA-5, R-4)", async () => {
    const T1 = await e.estudioPlan();
    const T2 = await e.estudioPlan();
    const u = await e.usuario(T1, "contador");
    await admin.pool.query("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')", [T2, u]);
    const c1 = await e.clienteCon(T1, "Cliente Primero SAC");
    const c2 = await e.clienteCon(T2, "Cliente Segundo SAC");
    await e.responsable(T1, c1, u);
    await e.responsable(T2, c2, u);
    await e.sembrarEnviados(T1, u, 30);
    await e.capturar(T1, c1);
    await e.capturar(T2, c2);
    expect(await e.envios(T1, { usuarioId: u, estado: "pendiente" }), "en T1 quedó diferido").toHaveLength(0);
    const e2 = await e.envioDe(T2, { usuarioId: u, estado: "pendiente" });
    expect(await ejecutar(T2, e2.id)).toEqual({ estado: "enviado", avisos: 1 });
  });

  it("un Dueño sin asignaciones con «todos los clientes» recibe todos; si le asignan uno, el siguiente resumen solo trae el suyo (CA-12)", async () => {
    const T = await e.estudioPlan();
    const dueno = await e.usuario(T, "dueno");
    await e.fijar(T, dueno, { resumen: true, todosClientes: true });
    const X = await e.clienteCon(T, "Cliente Equis SAC");
    const Y = await e.clienteCon(T, "Cliente Ye SAC");
    await e.sembrarMensajes(T, dueno, [
      { clienteId: X.id, critico: false, historico: false, atendido: false, capturadoEn: hace(HORA) },
      { clienteId: Y.id, critico: false, historico: false, atendido: false, capturadoEn: hace(HORA) },
    ]);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const primero = await e.envioDe(T, { usuarioId: dueno, origen: "resumen" });
    expect(await ejecutar(T, primero.id)).toEqual({ estado: "enviado", clientes: 2 });
    expect(correo.enviados[0]!.texto).toContain("Cliente Equis SAC");
    expect(correo.enviados[0]!.texto).toContain("Cliente Ye SAC");

    await e.responsable(T, Y, dueno);
    // T20 (H-028-2-7): un resumen sale solo en su día de Lima (el de otro día queda `fuera_de_dia`), así que el segundo es el de hoy y el
    // primero pasa a ser el de ayer (su clave y su día), como si se hubiera enviado entonces.
    const ayer = await e.diaLima(1);
    await admin.pool.query("update correo_envio set dia_lima = $2::date, clave = 'resumen:' || usuario_id || ':' || $2 where id = $1", [
      primero.id,
      ayer,
    ]);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const segundo = (await e.envios(T, { usuarioId: dueno, origen: "resumen" })).find((f) => f.id !== primero.id)!;
    expect(await ejecutar(T, segundo.id)).toEqual({ estado: "enviado", clientes: 1 });
    expect(correo.enviados[1]!.texto).toContain("Cliente Ye SAC");
    expect(correo.enviados[1]!.texto).not.toContain("Cliente Equis SAC");
  });

  it("un resumen cuya preferencia se apagó por fuera de la función, con el envío ya pendiente, queda omitido (R-3, D-7)", async () => {
    const { T, contador } = await estudioDelResumen();
    const A = await e.clienteCon(T, "Alfa Importaciones SAC");
    await e.responsable(T, A, contador);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const envio = await e.envioDe(T, { usuarioId: contador, origen: "resumen" });
    await admin.pool.query(
      "update correo_preferencia set activo = false where tenant_id = $1 and usuario_id = $2 and tipo = 'resumen'",
      [T, contador],
    );
    expect(await ejecutar(T, envio.id)).toEqual({ estado: "omitido", motivo: "preferencia_apagada" });
    expect(correo.enviados).toHaveLength(0);
  });

  it("un resumen cuyo plan apagó `correo_resumen` queda omitido y el plan apagado ya no crea más (R-3, R-12, CA-11)", async () => {
    const { T, contador } = await estudioDelResumen();
    const A = await e.clienteCon(T, "Alfa Importaciones SAC");
    await e.responsable(T, A, contador);
    await e.crearResumenes(T, (await e.hoyLima()).dia);
    const envio = await e.envioDe(T, { usuarioId: contador, origen: "resumen" });
    await admin.pool.query(
      `update plan set features = '{"correo_resumen": false}'::jsonb where id = (select plan_id from suscripcion where tenant_id = $1)`,
      [T],
    );
    expect(await ejecutar(T, envio.id)).toEqual({ estado: "omitido", motivo: "sin_plan" });
    expect(correo.enviados).toHaveLength(0);

    await e.crearResumenes(T, await e.diaLima(1));
    const otro = (await e.envios(T, { usuarioId: contador, origen: "resumen" })).find((f) => f.id !== envio.id);
    // Con el plan apagado `crear_correo_resumenes` ya no crea resumen: no hay segundo envío que probar.
    expect(otro).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-10: fallos y garantía
// ---------------------------------------------------------------------------------------------------------------

describe("CA-10: fallos del transporte y muerte del proceso (R-9, U-16)", () => {
  it("con el transporte fallando, 3 intentos y `fallido` `transporte` sin el texto del error; antes del último lanza para que 008 reintente", async () => {
    const { T, envio } = await avisoListo();
    const secreto = canario("smtp_url");
    const roto = new CorreoQueFalla(99, () => new Error(`getaddrinfo smtp://usuario:${secreto}@correo.interno`));
    const espia = loggerEspia();
    const opciones = { correo: roto, logger: espia.logger as unknown as LoggerTrabajos };
    const errores: unknown[] = [];

    for (const intento of [1, 2]) {
      const err = await ejecutar(T, envio.id, { ...opciones, intento }).then(
        () => undefined,
        (x: unknown) => x,
      );
      errores.push(err);
      expect(err, `intento ${intento}: lanza para reintentar`).toBeInstanceOf(CorreoNoEnviadoError);
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(await e.envio(envio.id)).toMatchObject({ estado: "pendiente", intentos: intento });
    }
    const r = await ejecutar(T, envio.id, { ...opciones, intento: 3 });
    expect(r).toEqual({ estado: "fallido", motivo: "transporte" });
    expect(await e.envio(envio.id)).toMatchObject({ estado: "fallido", motivo: "transporte", intentos: 3 });
    expect(roto.enviados).toHaveLength(0);

    expect(fugas([...errores, r, espia.llamadas], [secreto])).toEqual([]);
    expect(volcado(errores)).not.toContain(secreto);
    expect(JSON.stringify(espia.llamadas)).not.toContain(secreto);
    expect(await e.volcar()).not.toContain(secreto);
  });

  it("un transporte que se recupera al tercer intento entrega y queda `enviado` con 3 intentos", async () => {
    const { T, envio } = await avisoListo();
    const flojo = new CorreoQueFalla(2);
    for (const intento of [1, 2])
      await expect(ejecutar(T, envio.id, { correo: flojo, intento })).rejects.toBeInstanceOf(CorreoNoEnviadoError);
    expect(await ejecutar(T, envio.id, { correo: flojo, intento: 3 })).toEqual({ estado: "enviado", avisos: 1 });
    expect(flojo.enviados).toHaveLength(1);
    expect(await e.envio(envio.id)).toMatchObject({ estado: "enviado", intentos: 3 });
  });

  it("muerte antes de entregar: no hay correo y el reintento lo manda con el `Message-ID` del envío", async () => {
    const { T, envio } = await avisoListo();
    const muere = new CorreoQueMuere("antes");
    void ejecutar(T, envio.id, { correo: muere }).catch(() => undefined); // el proceso murió: nadie espera esta promesa
    await muere.enEnvio;
    expect(muere.enviados).toHaveLength(0);
    expect(await e.envio(envio.id)).toMatchObject({ estado: "pendiente", intentos: 1 });
    expect((await e.envio(envio.id)).tomado_en).not.toBeNull();

    expect(await ejecutar(T, envio.id, { intento: 2 })).toEqual({ estado: "enviado", avisos: 1 });
    expect(unico().idMensaje).toBe(envio.id);
    expect(await e.envio(envio.id)).toMatchObject({ estado: "enviado", intentos: 2 });
  });

  it("muerte después de entregar y antes de marcar `enviado`: el reintento llega dos veces con el mismo `Message-ID` (al menos una vez)", async () => {
    const { T, envio } = await avisoListo();
    const muere = new CorreoQueMuere("despues");
    void ejecutar(T, envio.id, { correo: muere }).catch(() => undefined);
    await muere.enEnvio;
    expect(muere.enviados).toHaveLength(1);
    expect(await e.envio(envio.id)).toMatchObject({ estado: "pendiente" });

    expect(await ejecutar(T, envio.id, { intento: 2 })).toEqual({ estado: "enviado", avisos: 1 });
    expect(correo.enviados).toHaveLength(1);
    expect(correo.enviados[0]!.idMensaje).toBe(muere.enviados[0]!.idMensaje);
    expect(muere.enviados[0]!.idMensaje).toBe(envio.id);
    expect(await e.envio(envio.id)).toMatchObject({ estado: "enviado", intentos: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-6: canarios
// ---------------------------------------------------------------------------------------------------------------

describe("CA-6: ningún secreto ni dato fuera de la lista blanca sale en logs, errores, resultado, envíos ni mensaje (R-6, R-8)", () => {
  it("canarios en asunto y remitente del buzón, clave SOL, SMTP_URL y el token de baja", async () => {
    const T = await e.estudioPlan();
    const contador = await e.usuario(T, "contador");
    const razon = canario("razon");
    const asunto = canario("asunto");
    const remitente = canario("remitente");
    const claveSol = canario("clave_sol");
    const smtp = canario("smtp_url");
    const c = await e.clienteCon(T, razon);
    await e.responsable(T, c, contador);
    await e.credencial(T, c.id, "sol");
    await admin.pool.query("update credencial set ciphertext = $2 where cliente_id = $1 and tipo = 'sol'", [
      c.id,
      Buffer.concat([Buffer.from(claveSol, "utf8"), randomBytes(16)]),
    ]);
    await e.capturar(T, c, 1, { asunto, remitente });
    const envio = await e.envioDe(T, { usuarioId: contador, tipo: "buzon_critico" });
    const espia = loggerEspia();
    const roto = new CorreoQueFalla(1, () => new Error(`ECONNREFUSED smtp://u:${smtp}@host`));
    const opciones = { correo: roto, logger: espia.logger as unknown as LoggerTrabajos };

    const error = await ejecutar(T, envio.id, opciones).then(() => undefined, (x: unknown) => x);
    const resultado = await ejecutar(T, envio.id, { ...opciones, intento: 2 });

    const m = roto.enviados[0]!;
    const token = tokenDe(m.baja!.url);
    expect(m.texto).toContain(razon);
    const mensaje = JSON.stringify(m);
    const salidas = { error: volcado(error), resultado: JSON.stringify(resultado), logs: JSON.stringify(espia.llamadas), bd: await e.volcar() };
    const prohibidosEnTodo = [asunto, remitente, c.ruc, smtp, ...[claveSol].flatMap((s) => [s, Buffer.from(s).toString("hex"), Buffer.from(s).toString("base64")])];
    for (const [donde, texto] of Object.entries({ mensaje, ...salidas }))
      for (const p of prohibidosEnTodo) expect(texto, `${donde} no lleva ${p.slice(0, 18)}…`).not.toContain(p);
    // La razón social solo puede ir en el mensaje; el token, solo en las URL del mensaje (la BD guarda su hash).
    for (const [donde, texto] of Object.entries(salidas)) {
      expect(texto, donde).not.toContain(razon);
      expect(texto, donde).not.toContain(token);
    }
    expect(m.asunto).not.toContain(token);
    expect(m.texto.replace(`${APP_ORIGIN}/baja?t=${token}`, "")).not.toContain(token);
    expect(Object.keys(m).sort()).toEqual(["asunto", "baja", "html", "idMensaje", "para", "texto"]);
  });
});
