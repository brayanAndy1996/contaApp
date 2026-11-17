// Procesador `sol.buzon.abrir` (spec 023, plan «Worker»; D-1, D-3, D-4, D-10, P-1, P-10; CA-4, CA-8, CA-10, CA-11). Obtiene el
// contenido y los adjuntos de UN mensaje ya capturado. Abrirlo en SUNAT puede marcarlo como leído (RF-126): por eso solo se hace
// a pedido (`buzon.marcar_leido`).
//  (1) Parámetros revalidados con el catálogo y `withTenant` corto: el mensaje debe ser del cliente del trabajo (si no, o si no
//      existe, `ErrorDatos` sin llamar al portal). Si ya tiene contenido, termina sin llamar al portal ni escribir nada.
//  (2) Descifrado auditado, UNA vez por trabajo (003), y `obtenerMensaje` con los topes del dominio SIN transacción (008 D6).
//  (3) El HTML pasa a texto plano (`htmlATextoPlano`); el texto se guarda tal cual. Adjuntos con `prepararAdjuntos` (nombre
//      saneado, MIME por firma, topes por adjunto y por mensaje).
//  (4) Storage primero, con rutas `buzon/{estudio}/{cliente}/{uuid}.{ext}` (el nombre nunca va en la ruta); luego UNA transacción
//      que inserta los adjuntos (guardados y omitidos) y DESPUÉS fija el contenido (el trigger de auditoría de 0056 cuenta lo ya
//      insertado). Si algo falla, se borra lo escrito (mejor esfuerzo) y el error sigue al ejecutor.
// `resultado` = {adjuntos, omitidos, marcoLeido}: solo conteos (D-10).
import { createHash, randomUUID } from "node:crypto";
import {
  guardarContenidoBuzon,
  leerMensajeBuzon,
  type AdjuntoGuardarBuzon,
  type ContappDb,
} from "@contapp/db";
import {
  TOPE_ADJUNTO_BYTES,
  TOPE_MENSAJE_BYTES,
  htmlATextoPlano,
  prepararAdjuntos,
} from "@contapp/domain";
import { SOL_BUZON_ABRIR } from "@contapp/queue";
import { rutaBuzon, type StorageProvider } from "@contapp/storage";
import { ErrorDatos, type SolPortal } from "@contapp/sunat";
import type { ServicioCredenciales } from "../../credenciales/descifrar-credencial.js";
import type { Procesador } from "../ejecutor.js";
import { descifrarCredencialSol, ubicarCredencialSol } from "./credencial-sol.js";

export interface DepsAbrirMensaje {
  db: Pick<ContappDb, "withTenant">;
  servicio: ServicioCredenciales;
  solPortal: SolPortal;
  storage: StorageProvider;
}

export interface ResultadoAbrirMensaje {
  adjuntos: number;
  omitidos: number;
  marcoLeido: boolean;
}

/** Extensión del contenido guardado (siempre texto plano). */
const EXT_CONTENIDO = "txt";

// `leerMensajeBuzon` no expone el id de SUNAT, que es lo que pide el portal.
const SQL_ID_SUNAT =
  "select id_sunat from buzon_mensaje where cliente_id = $1::uuid and id = $2::uuid";

const sha256 = (b: Uint8Array): Buffer =>
  createHash("sha256").update(b).digest();

export function abrirMensaje(d: DepsAbrirMensaje): Procesador {
  return async ({ trabajo: t }) => {
    const p = SOL_BUZON_ABRIR.parametros.safeParse(t.parametros);
    if (!p.success) throw new ErrorDatos(); // sin repetir lo recibido
    const { mensajeId } = p.data;
    const ctx = { tenantId: t.tenantId, trabajoId: t.id };

    // (1) El mensaje del cliente del trabajo.
    const leido = await d.db.withTenant(ctx, async (tx) => {
      const mensaje = await leerMensajeBuzon(tx, t.clienteId, mensajeId);
      if (mensaje === null) return null;
      const f = (await tx.query(SQL_ID_SUNAT, [t.clienteId, mensajeId]))
        .rows[0] as { id_sunat?: unknown } | undefined;
      if (f === undefined) return null;
      return {
        mensaje,
        idSunat: String(f.id_sunat),
        credencialId:
          mensaje.contenidoRuta === null
            ? await ubicarCredencialSol(tx, t.clienteId)
            : null,
      };
    });
    if (leido === null) throw new ErrorDatos();
    const { mensaje } = leido;
    if (mensaje.contenidoRuta !== null) {
      // Ya obtenido: nada que pedir al portal ni que escribir.
      const r: ResultadoAbrirMensaje = {
        adjuntos: mensaje.adjuntos.filter((a) => a.ruta !== null).length,
        omitidos: mensaje.adjuntos.filter((a) => a.omitido !== null).length,
        marcoLeido: false,
      };
      return r;
    }

    // (2) Descifrado y portal, sin transacción abierta.
    const cred = await descifrarCredencialSol(d, t, leido.credencialId);
    const recibido = await d.solPortal.obtenerMensaje(cred, leido.idSunat, {
      maxBytesAdjunto: TOPE_ADJUNTO_BYTES,
      maxBytesMensaje: TOPE_MENSAJE_BYTES,
    });

    // (3) Contenido y adjuntos preparados por el dominio.
    const texto =
      recibido.contenido.formato === "html"
        ? htmlATextoPlano(recibido.contenido.cuerpo)
        : recibido.contenido.cuerpo;
    const bytesTexto = Buffer.from(texto, "utf8");
    const { guardar, omitidos } = prepararAdjuntos(recibido.adjuntos);

    // (4) Storage y luego una transacción; si algo falla, se borra lo escrito.
    const escritas: string[] = [];
    const escribir = async (ext: string, bytes: Uint8Array): Promise<string> => {
      const ruta = rutaBuzon(t.tenantId, t.clienteId, randomUUID(), ext);
      escritas.push(ruta);
      await d.storage.guardar(ruta, bytes);
      return ruta;
    };
    try {
      const contenidoRuta = await escribir(EXT_CONTENIDO, bytesTexto);
      const porId = new Map<string, AdjuntoGuardarBuzon>();
      for (const a of guardar) {
        if (porId.has(a.idSunat)) continue; // id repetido: cuenta el primero
        porId.set(a.idSunat, {
          idSunat: a.idSunat,
          nombre: a.nombre,
          mime: a.mime,
          tamano: a.bytes.byteLength,
          sha256: sha256(a.bytes),
          ruta: await escribir(a.ext, a.bytes),
          omitido: null,
        });
      }
      for (const a of omitidos)
        if (!porId.has(a.idSunat))
          porId.set(a.idSunat, {
          idSunat: a.idSunat,
          nombre: a.nombre,
          mime: null,
          tamano: null,
          sha256: null,
          ruta: null,
          omitido: a.motivo,
        });
      // En el orden en que llegaron.
      const adjuntos = [
        ...new Set(recibido.adjuntos.map((a) => a.idSunat)),
      ].flatMap((id) => porId.get(id) ?? []);
      await d.db.withTenant(ctx, (tx) =>
        guardarContenidoBuzon(tx, {
          clienteId: t.clienteId,
          mensajeId,
          contenidoRuta,
          contenidoBytes: bytesTexto.byteLength,
          marcoLeido: recibido.marcaLeido,
          adjuntos,
        }),
      );
    } catch (e) {
      await Promise.all(
        escritas.map((ruta) => d.storage.eliminar(ruta).catch(() => undefined)),
      );
      throw e;
    }
    const r: ResultadoAbrirMensaje = {
      adjuntos: guardar.length,
      omitidos: omitidos.length,
      marcoLeido: recibido.marcaLeido,
    };
    return r;
  };
}
