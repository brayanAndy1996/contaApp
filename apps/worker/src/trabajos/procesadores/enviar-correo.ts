// Procesador de `notificacion.enviar` (spec 028; R-1, R-3, R-6, R-7, R-9, R-12 a R-14; CA-3 a CA-6, CA-9 a CA-11). Cola `notificaciones`.
// Parámetros `{envioId}` revalidados ANTES de abrir ninguna transacción (la cola no lleva correo, tenant ni contenido):
//  (1) Tx 1, `withTenant` del estudio: `tomarEnvioParaEnviar` (marca la toma, suma el intento y trae preferencia y plan), revalida
//      R-3 y R-12 (membresía, correo vigente, preferencia, plan) y R-5 (un resumen fuera de su día de Lima: `fuera_de_dia`, sin
//      corte), lee el contenido (`leerAvisosEnvio` o `leerResumen`, ya filtrados por cliente visible y no archivado), crea el token
//      de baja (32 bytes, la BD guarda su SHA-256) y arma el correo con `domain`.
//      Si no queda nada, `cerrarEnvio(omitido, código)` y termina sin enviar.
//  (2) Fuera de transacción: `Correo.enviar` con `idMensaje = envioId` (al menos una vez: un reintento repite el `Message-ID`).
//  (3) Tx 2: `enviado` con `corte_hasta` = el instante en que se armó (el siguiente resumen cuenta desde ahí).
// Un fallo del transporte no deja rastro del error (ni log, ni BD, ni resultado): antes del último intento lanza `CorreoNoEnviadoError`
// para que 008 reintente; en el último cierra `fallido` `transporte` y DEVUELVE el resultado. Los logs llevan solo ids y códigos.
import { randomBytes, createHash } from "node:crypto";
import {
  CorreoNoEnviadoError,
  type Correo,
  type MensajeCorreo,
} from "@contapp/correo";
import {
  cerrarEnvio,
  crearTokenBaja,
  leerAvisosEnvio,
  leerDestinatario,
  leerResumen,
  tomarEnvioParaEnviar,
  type AvisoEnvio,
  type ContappDb,
  type EnvioTomado,
  type MotivoEnvio,
  type Tx,
} from "@contapp/db";
import {
  armarCorreoAviso,
  armarCorreoPendientes,
  armarCorreoResumen,
  diaLima,
  periodoAnteriorLima,
  resumenVacio,
  type AvisoCorreo,
  type CorreoArmado,
  type EnlacesCorreo,
  type EntradaCorreoResumen,
} from "@contapp/domain";
import { NOTIFICACION_ENVIAR, type Reloj } from "@contapp/queue";
import { ErrorDatos } from "@contapp/sunat";
import type { Procesador } from "../ejecutor.js";
import { loggerConsola, registrar, type LoggerTrabajos } from "../registro.js";

export interface DepsEnviarCorreo {
  db: Pick<ContappDb, "withTenant">;
  correo: Correo;
  /** `APP_ORIGIN`: origen de los enlaces (`/ir`, `/baja`) y de la URL de `List-Unsubscribe`. */
  appOrigin: string;
  logger?: LoggerTrabajos;
  reloj?: Reloj;
  /** Intentos de transporte antes de dejar el envío `fallido` (3). */
  intentosMax?: number;
}

export type ResultadoEnvioCorreo =
  | { estado: "enviado"; avisos: number }
  | { estado: "enviado"; clientes: number }
  | { estado: "omitido"; motivo: string }
  | { estado: "fallido"; motivo: "transporte" };

const INTENTOS_MAX = 3;
const DIA_MS = 86_400_000;

/** Categoría del buzón en español (la misma de la campana y la bandeja); una desconocida sale «Otro», nunca el código crudo. */
const ETIQUETA_CATEGORIA: Readonly<Record<string, string>> = {
  coactiva: "Coactiva",
  resolucion_determinacion: "Resolución de determinación",
  resolucion_multa: "Resolución de multa",
  requerimiento_fiscalizacion: "Requerimiento de fiscalización",
  otro: "Otro",
};
const ETIQUETA_RECURSO: Readonly<Record<string, string>> = {
  rucs: "RUC",
  usuarios: "usuarios",
};

type TipoAviso = "buzon_critico" | "credencial_invalida" | "plan_limite";

/** Lo que la transacción 1 decide: no enviar (ya cerrado) o enviar este mensaje. */
type Preparado =
  | { hacia: "omitido"; motivo: MotivoEnvio }
  | {
      hacia: "enviar";
      mensaje: MensajeCorreo;
      envio: EnvioTomado;
      corte: Date;
      resultado: ResultadoEnvioCorreo;
    };

const esAviso = (t: string): t is TipoAviso =>
  t === "buzon_critico" || t === "credencial_invalida" || t === "plan_limite";

/** Cuenta los avisos por tipo en el orden en que aparecen. */
function diferidosPorTipo(
  avisos: readonly AvisoEnvio[],
): { tipo: TipoAviso; cantidad: number }[] {
  const m = new Map<TipoAviso, number>();
  for (const a of avisos) m.set(a.tipo, (m.get(a.tipo) ?? 0) + 1);
  return [...m].map(([tipo, cantidad]) => ({ tipo, cantidad }));
}

function aAvisoCorreo(a: AvisoEnvio): AvisoCorreo {
  return {
    razonSocial: a.razonSocial,
    categoria:
      a.categoria === null
        ? null
        : (ETIQUETA_CATEGORIA[a.categoria] ?? ETIQUETA_CATEGORIA.otro!),
    ...(a.recurso === null
      ? {}
      : { recurso: ETIQUETA_RECURSO[a.recurso] ?? "recursos" }),
    ...(a.porcentaje === null ? {} : { porcentaje: a.porcentaje }),
    fecha: a.fecha,
  };
}

/** Pantalla de `/ir` (lista cerrada D-3) del correo y, si hace falta, el cliente: solo ids, nunca datos de usuario. */
function destinoIr(
  tipo: TipoAviso | "resumen",
  avisos: readonly AvisoEnvio[],
): { pantalla: string; cliente?: string } {
  if (tipo === "plan_limite") return { pantalla: "uso_plan" };
  if (tipo === "resumen") return { pantalla: "buzon_estudio" };
  const clientes = [
    ...new Set(avisos.flatMap((a) => (a.clienteId === null ? [] : [a.clienteId]))),
  ];
  if (tipo === "credencial_invalida")
    return clientes.length > 0
      ? { pantalla: "credenciales_cliente", cliente: clientes[0]! }
      : { pantalla: "buzon_estudio" };
  return clientes.length === 1
    ? { pantalla: "buzon_cliente", cliente: clientes[0]! }
    : { pantalla: "buzon_estudio" };
}

export function enviarCorreo(d: DepsEnviarCorreo): Procesador {
  const logger = d.logger ?? loggerConsola;
  const reloj: Reloj = d.reloj ?? { ahora: () => new Date() };
  const intentosMax = d.intentosMax ?? INTENTOS_MAX;
  const origen = d.appOrigin.replace(/\/+$/, "");

  return async (ctx) => {
    // El error no repite lo recibido (puede traer un correo, un token o un tenant ajeno).
    const p = NOTIFICACION_ENVIAR.parametros.safeParse(ctx.trabajo.parametros);
    if (!p.success) throw new ErrorDatos();
    const { envioId } = p.data as { envioId: string };
    const tenantId = ctx.trabajo.tenantId;

    const preparado = await d.db
      .withTenant({ tenantId }, (tx) => preparar(tx, envioId, tenantId))
      .catch((e: unknown) => {
        // Envío ajeno, inexistente o ya cerrado: reintentar no lo arregla.
        if ((e as { codigo?: unknown } | null)?.codigo === "P0002")
          throw new ErrorDatos();
        throw e;
      });
    if (preparado.hacia === "omitido")
      return { estado: "omitido", motivo: preparado.motivo };

    try {
      await d.correo.enviar(preparado.mensaje);
    } catch {
      // El error del transporte se descarta: puede traer el SMTP_URL, el correo o el token.
      if (preparado.envio.intentos < intentosMax) {
        registrar(logger, "warn", {
          evento: "correo_envio_reintento",
          tenant_id: tenantId,
          job_id: ctx.trabajo.id,
          tipo: ctx.trabajo.tipo,
          codigo: "transporte",
          intentos: preparado.envio.intentos,
        });
        throw new CorreoNoEnviadoError();
      }
      await d.db.withTenant({ tenantId }, (tx) =>
        cerrarEnvio(tx, envioId, { estado: "fallido", motivo: "transporte" }),
      );
      registrar(logger, "warn", {
        evento: "correo_envio_fallido",
        tenant_id: tenantId,
        job_id: ctx.trabajo.id,
        tipo: ctx.trabajo.tipo,
        codigo: "transporte",
      });
      return { estado: "fallido", motivo: "transporte" };
    }

    await d.db.withTenant({ tenantId }, (tx) =>
      cerrarEnvio(tx, envioId, {
        estado: "enviado",
        corteHasta: preparado.corte,
      }),
    );
    return preparado.resultado;
  };

  /** Transacción 1: toma, revalida, lee, crea el token y arma. Cierra `omitido` cuando no queda nada que mandar. */
  async function preparar(
    tx: Tx,
    envioId: string,
    tenantId: string,
  ): Promise<Preparado> {
    const ahora = reloj.ahora();
    const t = await tomarEnvioParaEnviar(tx, envioId);
    const envio = t.envio;
    const omitir = async (
      motivo: MotivoEnvio,
      corteHasta?: Date,
    ): Promise<Preparado> => {
      await cerrarEnvio(tx, envioId, {
        estado: "omitido",
        motivo,
        ...(corteHasta === undefined ? {} : { corteHasta }),
      });
      return { hacia: "omitido", motivo };
    };

    // R-3 y R-12: lo vigente hoy, no lo de cuando se registró el aviso.
    const dest = await leerDestinatario(tx, envio.usuarioId);
    if (dest === null) return omitir("membresia_inactiva");
    const email = dest.email.trim();
    if (email === "") return omitir("sin_correo");
    if (!t.preferencia) return omitir("preferencia_apagada");
    const planOk =
      t.plan.vigente &&
      (envio.origen === "resumen" ? t.plan.resumen : t.plan.avisos);
    if (!planOk) return omitir("sin_plan");
    // R-5 (H-028-2-7): un resumen sale solo en su día de Lima. Si la cola lo toma después (tick de las 23:59:59, cola atascada,
    // reintentos que cruzan la medianoche) queda `fuera_de_dia` SIN corte: lo nuevo y sus diferidos van al resumen siguiente.
    const hoy = diaLima(ahora);
    if (envio.origen === "resumen" && (envio.diaLima ?? hoy) !== hoy) return omitir("fuera_de_dia");

    // Contenido (R-3: lo que ya no es visible se quita) y enlaces con el token de este correo.
    const avisos = await leerAvisosEnvio(tx, envioId);
    let resumenEntrada: Omit<EntradaCorreoResumen, "enlaces"> | null = null;
    if (envio.origen === "resumen") {
      const desde = envio.corteDesde ?? new Date(ahora.getTime() - DIA_MS);
      // Periodo y fecha del asunto con el día del resumen, que aquí es hoy en Lima (el de otro día ya quedó `fuera_de_dia`).
      const periodo = periodoAnteriorLima(ahora);
      const clientes = await leerResumen(tx, {
        usuarioId: envio.usuarioId,
        desde,
        periodo,
        todos: t.todosClientes,
      });
      resumenEntrada = {
        estudio: dest.estudioNombre,
        dia: hoy,
        clientes: clientes.map((c) => ({
          razonSocial: c.razonSocial,
          nuevos: c.nuevos,
          criticosNuevos: c.criticosNuevos,
          pendientesAtender: c.pendientesAtender,
          compras: c.compras,
          ventas: c.ventas,
        })),
        clientesMas: 0,
        periodo,
        diferidos: diferidosPorTipo(avisos),
      };
      const sinEnlaces = {
        ...resumenEntrada,
        enlaces: { pantalla: origen, baja: origen },
      };
      if (resumenVacio(sinEnlaces)) return omitir("sin_novedades", ahora);
    } else if (avisos.length === 0) {
      return omitir("sin_contenido");
    }

    const token = randomBytes(32).toString("base64url");
    await crearTokenBaja(
      tx,
      envioId,
      createHash("sha256").update(token, "utf8").digest(),
    );
    const destino = destinoIr(
      envio.origen === "resumen" ? "resumen" : (envio.tipo as TipoAviso),
      avisos,
    );
    const consulta = new URLSearchParams({
      estudio: tenantId,
      pantalla: destino.pantalla,
      ...(destino.cliente === undefined ? {} : { cliente: destino.cliente }),
    });
    const enlaces: EnlacesCorreo = {
      pantalla: `${origen}/ir?${consulta.toString()}`,
      baja: `${origen}/baja?t=${token}`,
    };

    let armado: CorreoArmado;
    let resultado: ResultadoEnvioCorreo;
    if (resumenEntrada !== null) {
      armado = armarCorreoResumen({ ...resumenEntrada, enlaces });
      resultado = { estado: "enviado", clientes: resumenEntrada.clientes.length };
    } else if (envio.origen === "pendientes") {
      armado = armarCorreoPendientes({
        estudio: dest.estudioNombre,
        diferidos: diferidosPorTipo(avisos),
        enlaces,
      });
      resultado = { estado: "enviado", avisos: avisos.length };
    } else {
      if (!esAviso(envio.tipo)) throw new ErrorDatos();
      armado = armarCorreoAviso({
        tipo: envio.tipo,
        estudio: dest.estudioNombre,
        avisos: avisos.map(aAvisoCorreo),
        total: avisos.length,
        enlaces,
      });
      resultado = { estado: "enviado", avisos: avisos.length };
    }

    return {
      hacia: "enviar",
      envio,
      corte: ahora,
      resultado,
      mensaje: {
        para: email,
        asunto: armado.asunto,
        texto: armado.texto,
        html: armado.html,
        // RFC 8058: la URL del `POST` de baja de un clic es la de la API (misma origen, vía el rewrite `/api`).
        baja: { url: `${origen}/api/correo/baja?t=${token}` },
        idMensaje: envioId,
      },
    };
  }
}
