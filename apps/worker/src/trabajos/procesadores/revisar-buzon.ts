// Procesador `sol.buzon.revisar` (spec 023, plan «Worker»; D-1, D-3, D-7, D-9, D-10, P-1, P-4, P-5, P-8; CA-3, CA-4, CA-6, CA-7,
// CA-11). Captura los METADATOS del buzón SOL del cliente; nunca abre un mensaje (`obtenerMensaje` no se llama, CA-4).
//  (1) `withTenant` corto: credencial SOL y estado de captura (`cursor_pendiente`, `sincronizado_en`).
//  (2) Descifrado auditado, UNA vez por trabajo (003).
//  (3) Páginas del portal SIN transacción abierta (008 D6), con `limite` ≤ TOPE_MENSAJES_CAPTURA (así un corte a mitad de
//      página nunca cae en la primera), siempre desde la primera: `planificarCaptura` decide qué es nuevo, qué se actualiza y
//      dónde termina (el primer conocido termina, salvo relleno de una captura cortada, P-5).
//  (4) Cada mensaje nuevo en su propia transacción con el trabajo en el contexto: clasificación del dominio, `avisado` con
//      `debeAvisar`, INSERT ... ON CONFLICT DO NOTHING (si otra captura lo insertó, no cuenta ni avisa); tras el commit, el
//      aviso en vivo a quien recibió la notificación (017). Los conocidos de cada página se actualizan en un solo lote.
//  (5) Al final, el estado: `ultima_captura_en`, `cursor_pendiente` y, si llegó al final, `sincronizado_en` (el que ya tenía el
//      cliente se conserva). Si el portal o la BD fallan a mitad, lo confirmado queda y se guarda la página que falló como
//      `cursor_pendiente` para que la siguiente captura continúe sin huecos (P-4); el error sigue al ejecutor (008).
// `resultado` = {nuevos, criticos, avisados, actualizados, pendientes}: solo conteos (D-10).
import {
  actualizarConocidosBuzon,
  conocidosBuzon,
  destinatariosNuevos,
  guardarEstadoCapturaBuzon,
  insertarMensajeBuzon,
  leerEstadoBuzon,
  type ContappDb,
} from "@contapp/db";
import {
  TOPE_MENSAJES_CAPTURA,
  clasificarMensaje,
  debeAvisar,
  idSunatValido,
  planificarCaptura,
  sanearTextoPortal,
  type MensajeListado,
  type PaginaListado,
} from "@contapp/domain";
import { SOL_BUZON_REVISAR } from "@contapp/queue";
import { ErrorDatos, type SolPortal } from "@contapp/sunat";
import type { ServicioCredenciales } from "../../credenciales/descifrar-credencial.js";
import type { Procesador } from "../ejecutor.js";
import type { Notificador } from "../registro.js";
import { descifrarCredencialSol, ubicarCredencialSol } from "./credencial-sol.js";

export interface DepsRevisarBuzon {
  db: Pick<ContappDb, "withTenant">;
  servicio: ServicioCredenciales;
  solPortal: SolPortal;
  /** 017: aviso en vivo tras el commit de cada mensaje crítico avisado. Opcional. */
  notificador?: Notificador;
}

export interface ResultadoRevisarBuzon {
  nuevos: number;
  criticos: number;
  avisados: number;
  actualizados: number;
  pendientes: boolean;
}

/** Tamaño de página que se pide al portal (≤ TOPE_MENSAJES_CAPTURA, aviso de T8). */
export const LIMITE_PAGINA_BUZON = TOPE_MENSAJES_CAPTURA;

/** Topes de las columnas de `buzon_mensaje` (0054). */
const LARGO_ASUNTO = 500;
const LARGO_REMITENTE = 200;
const LARGO_CODIGO_TIPO = 32;

const cortar = (texto: string, largo: number): string =>
  Array.from(texto).slice(0, largo).join("");

function codigoTipoDe(c: string | null): string | null {
  if (c === null) return null;
  const v = c.trim();
  return v.length === 0 || v.length > LARGO_CODIGO_TIPO ? null : v;
}

/**
 * H-023-1-4: id, asunto, remitente y código de tipo sin NUL ni controles (PostgreSQL no admite NUL en `text`), ANTES de buscar
 * conocidos, planificar y clasificar: así un mensaje así no tumba la captura ni deja sin capturar lo más antiguo. Un mensaje cuyo
 * id queda vacío o pasa de 64 caracteres no se puede guardar (CHECK de 0054) y se descarta.
 */
function sanearPagina(p: PaginaListado): PaginaListado {
  const mensajes: MensajeListado[] = [];
  for (const m of p.mensajes) {
    const idSunat = sanearTextoPortal(m.idSunat);
    if (!idSunatValido(idSunat)) continue;
    mensajes.push({
      ...m,
      idSunat,
      asunto: sanearTextoPortal(m.asunto),
      remitente: sanearTextoPortal(m.remitente),
      codigoTipo: m.codigoTipo === null ? null : sanearTextoPortal(m.codigoTipo),
    });
  }
  return { ...p, mensajes };
}

export function revisarBuzon(d: DepsRevisarBuzon): Procesador {
  return async ({ trabajo: t }) => {
    if (!SOL_BUZON_REVISAR.parametros.safeParse(t.parametros).success)
      throw new ErrorDatos(); // sin repetir lo recibido
    const ctx = { tenantId: t.tenantId, trabajoId: t.id };

    // (1) Credencial y estado de captura.
    const { credencialId, estado } = await d.db.withTenant(ctx, async (tx) => ({
      credencialId: await ubicarCredencialSol(tx, t.clienteId),
      estado: await leerEstadoBuzon(tx, t.clienteId),
    }));
    // (2) Una sola vez por trabajo.
    const cred = await descifrarCredencialSol(d, t, credencialId);

    const cursorPendiente = estado?.cursorPendiente ?? null;
    const sincronizadoEn = estado?.sincronizadoEn ?? null;
    const r: ResultadoRevisarBuzon = {
      nuevos: 0,
      criticos: 0,
      avisados: 0,
      actualizados: 0,
      pendientes: false,
    };

    const guardarNuevo = async (m: MensajeListado): Promise<void> => {
      const c = clasificarMensaje({
        codigoTipo: m.codigoTipo,
        asunto: m.asunto,
      });
      const fecha = new Date(m.fecha);
      const avisado = debeAvisar({
        critico: c.critico,
        fecha,
        sincronizadoEn,
        ahora: new Date(),
      });
      const { insertado, destinatarios } = await d.db.withTenant(
        ctx,
        async (tx) => {
          const fila = await insertarMensajeBuzon(tx, {
            clienteId: t.clienteId,
            idSunat: m.idSunat,
            asunto: cortar(m.asunto, LARGO_ASUNTO),
            remitente: cortar(m.remitente, LARGO_REMITENTE),
            fecha,
            codigoTipo: codigoTipoDe(m.codigoTipo),
            categoria: c.categoria,
            critico: c.critico,
            motivoCritico: c.motivo,
            versionCatalogo: c.versionCatalogo,
            avisado,
            leidoEnSunat: m.leidoEnSunat,
            adjuntosDeclarados: m.adjuntos.length,
          });
          return {
            insertado: fila !== null,
            // La notificación la guarda el trigger de 0056 en esta transacción; solo se lee si hay a quién avisar en vivo.
            destinatarios:
              fila !== null && avisado && d.notificador !== undefined
                ? await destinatariosNuevos(tx)
                : [],
          };
        },
      );
      if (!insertado) return; // otra captura lo guardó (y avisó) antes
      r.nuevos += 1;
      if (c.critico) r.criticos += 1;
      if (avisado) r.avisados += 1;
      const notificador = d.notificador;
      if (notificador !== undefined && destinatarios.length > 0)
        void Promise.resolve()
          .then(() => notificador.avisar(t.tenantId, destinatarios))
          .catch(() => undefined);
    };

    let cursor: string | null = null;
    let acumulados = 0;
    let paginas = 0;
    let fin: { cursorPendiente: string | null; sincronizado: boolean };
    try {
      for (;;) {
        // (3) Sin transacción abierta.
        const pagina = sanearPagina(
          await d.solPortal.listarMensajes(cred, {
            cursor,
            limite: LIMITE_PAGINA_BUZON,
          }),
        );
        const conocidos = await d.db.withTenant(ctx, (tx) =>
          conocidosBuzon(
            tx,
            t.clienteId,
            pagina.mensajes.map((m) => m.idSunat),
          ),
        );
        const plan = planificarCaptura(
          {
            cursorPendiente,
            cursorActual: cursor,
            nuevosAcumulados: acumulados,
            paginasLeidas: paginas,
          },
          pagina,
          new Set(conocidos.keys()),
        );
        // (4) Los conocidos de la página: leído en SUNAT y última captura, en un lote.
        const vistos = new Set<string>();
        const actualizar = pagina.mensajes.filter((m) => {
          if (!conocidos.has(m.idSunat) || vistos.has(m.idSunat)) return false;
          vistos.add(m.idSunat);
          return true;
        });
        if (actualizar.length > 0)
          r.actualizados += await d.db.withTenant(ctx, (tx) =>
            actualizarConocidosBuzon(
              tx,
              t.clienteId,
              actualizar.map((m) => ({
                idSunat: m.idSunat,
                leidoEnSunat: m.leidoEnSunat,
              })),
            ),
          );
        for (const m of plan.nuevos) await guardarNuevo(m);
        acumulados += plan.nuevos.length;
        paginas += 1;
        if (plan.terminada) {
          fin = {
            cursorPendiente: plan.sincronizado ? null : plan.siguienteCursor,
            sincronizado: plan.sincronizado,
          };
          break;
        }
        cursor = plan.siguienteCursor;
      }
    } catch (e) {
      // P-4: lo confirmado queda; la captura siguiente rellena desde la página que falló (sin huecos).
      const pendiente = cursor ?? cursorPendiente;
      if (paginas > 0 && pendiente !== null)
        await d.db
          .withTenant(ctx, (tx) =>
            guardarEstadoCapturaBuzon(tx, t.clienteId, {
              cursorPendiente: pendiente,
              sincronizado: false,
            }),
          )
          .catch(() => undefined);
      throw e;
    }

    // (5) Estado de la captura.
    await d.db.withTenant(ctx, (tx) =>
      guardarEstadoCapturaBuzon(tx, t.clienteId, fin),
    );
    r.pendientes = fin.cursorPendiente !== null;
    return r;
  };
}
