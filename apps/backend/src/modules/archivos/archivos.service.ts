import { Inject, Injectable } from "@nestjs/common";
import { leerVersion, listarVersiones, type Alcance, type ContappDb, type LibroArchivo, type VersionArchivo } from "@contapp/db";
import { validarNombreArchivo } from "@contapp/domain";
import { generarArchivoSchema, type PrevioArchivoDto, type VersionArchivoDto } from "@contapp/shared";
import {
  ArchivoAlteradoError,
  ArchivoNoEncontradoError,
  leerVerificado,
  RutaStorageError,
  rutaArchivo,
  type StorageProvider,
} from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { exigirCliente, idDe } from "../compras/apoyo.js";
import { exigir } from "../compras/escritura.js";
import { STORAGE } from "../storage/storage.module.js";
import { Encolador } from "../trabajos/encolador.js";
import { ArchivosError } from "./errores.js";
import { periodoArchivoDe } from "./periodo.js";
import { calcularPrevio, type EntradaPrevio } from "./previo.js";

const PERMISO_GENERAR = "sire.aprobar_generar";

/** El ZIP de una versión, verificado contra su hash, listo para servir. */
export interface ZipDescargable {
  /** `nombre_zip` de la fila (validado con la gramática de los formatos). */
  nombre: string;
  bytes: Uint8Array;
}

function aVersionDto(v: VersionArchivo): VersionArchivoDto {
  return {
    id: v.id,
    version: v.version,
    generadoEn: v.generadoEn.toISOString(),
    generadoPor: v.generadoPor,
    formato: { id: v.formatoId, version: v.formatoVersion },
    provisional: v.provisional,
    nombreZip: v.nombreZip,
    sha256Txt: v.sha256Txt,
    sha256Zip: v.sha256Zip,
    bytesZip: v.bytesZip,
    lineas: v.lineas,
    resumen: {
      modificadas: v.modificadas,
      excluidas: v.excluidas,
      agregadas: v.agregadas,
      impactoIgv: { DG: v.impactoIgvDg, DGNG: v.impactoIgvDgng, DNG: v.impactoIgvDng, total: v.impactoIgvTotal },
      // No se guarda por versión: la lista de filas sin convertir solo existe en el previo.
      filasSinConvertir: [],
    },
    avisos: { ...v.avisos },
  };
}

/**
 * Archivos SIRE generados (spec 012b): previo, generar, versiones y descarga de compras y de ventas. Toda consulta va dentro de
 * `withTenant`. El backend nunca llama a SUNAT: generar solo encola `archivo.generar` y el worker hace el resto (D4). Los errores
 * salen como códigos, sin rutas de storage, hashes ni bytes (D8, D10).
 */
@Injectable()
export class ArchivosService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(Encolador) private readonly encolador: Encolador,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  /** `NODE_ENV` se lee en CADA petición (no al arrancar) y nunca de la petición (D2). */
  private entrada(alcance: Alcance, clienteId: string, periodo: string, libro: LibroArchivo): EntradaPrevio {
    return { alcance, clienteId, periodo, libro, nodeEnv: process.env.NODE_ENV };
  }

  /** D1: prevalidación, avisos, resumen, estado y huella en una foto de solo lectura. No escribe nada. */
  previo(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    libro: LibroArchivo,
  ): Promise<PrevioArchivoDto> {
    const periodo = periodoArchivoDe(periodoCrudo);
    return this.db.withTenant({ ...contextoDe(sesion), foto: true }, async (tx) => {
      const { dto } = await calcularPrevio(tx, this.entrada(alcance, clienteId, periodo, libro));
      return dto;
    });
  }

  /**
   * D1, D2, D5, P-2: 202 `{ trabajoId }` o el rechazo, en el orden del plan: guards (antes, en Nest) → 403 sin
   * `sire.aprobar_generar` → 400 (cuerpo estricto y periodo) → 409 `cliente_archivado` → 409 `estado_invalido` → 422 `formato_no_oficial` → 409 `resumen_cambiado` → 422
   * `prevalidacion_fallida`. Un rechazo no encola ni cambia el estado. El estado `generado` lo fija el worker, nunca esta ruta.
   */
  async generar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    libro: LibroArchivo,
    cuerpo: unknown,
  ): Promise<{ trabajoId: string }> {
    if (!permisos.has(PERMISO_GENERAR)) throw new AccesoError("permiso_denegado");
    const periodo = periodoArchivoDe(periodoCrudo);
    const parseado = generarArchivoSchema.safeParse(cuerpo);
    if (!parseado.success) throw new AccesoError("solicitud_invalida");
    const { estadoVisto, huella } = parseado.data;
    const ctx = contextoDe(sesion);

    await this.db.withTenant({ ...ctx, foto: true }, async (tx) => {
      const previo = await calcularPrevio(tx, this.entrada(alcance, clienteId, periodo, libro), (c) => {
        if (c.archivado) throw new AccesoError("cliente_archivado");
        // También con el periodo `generado`: `estadoVisto` solo admite `abierto` o `revisado`.
        if (c.estado.estado !== estadoVisto) throw new ArchivosError("estado_invalido");
      });
      if (previo.formatoNoOficial) throw new ArchivosError("formato_no_oficial");
      if (previo.dto.huella !== huella) throw new ArchivosError("resumen_cambiado");
      if (!previo.dto.apto) {
        throw new ArchivosError("prevalidacion_fallida", {
          errores: previo.dto.errores,
          erroresOmitidos: previo.dto.erroresOmitidos,
        });
      }
    });

    const r = await this.encolador.encolar(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      {
        tipo: "archivo.generar",
        clienteId,
        parametros: { periodo, libro, estadoVisto, huella },
        prioridad: "interactivo",
        creadoPor: ctx.userId,
      },
    );
    return { trabajoId: r.trabajo.id };
  }

  /** Las versiones del libro, la mayor primero. Nunca la ruta del storage. */
  versiones(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    libro: LibroArchivo,
  ): Promise<VersionArchivoDto[]> {
    const periodo = periodoArchivoDe(periodoCrudo);
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return (await listarVersiones(tx, clienteId, periodo, libro)).map(aVersionDto);
    });
  }

  /**
   * D8: la ruta sale de la fila, nunca de la petición. Antes de servir se recalcula el SHA-256: si no coincide con `sha256_zip` (o el
   * ZIP falta, o la fila no cumple su convención) es 500 `archivo_alterado` sin bytes, ruta ni hashes. Un id de otro estudio, cliente,
   * periodo o libro, inexistente o mal formado es el mismo 404.
   */
  async descargar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    libro: LibroArchivo,
    archivoCrudo: string,
  ): Promise<ZipDescargable> {
    const periodo = periodoArchivoDe(periodoCrudo);
    const archivoId = idDe(archivoCrudo).toLowerCase();
    const ctx = contextoDe(sesion);
    const version = await this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return exigir(await leerVersion(tx, archivoId, { clienteId, periodo, libro }));
    });
    let bytes: Uint8Array;
    try {
      if (!validarNombreArchivo(version.nombreZip)) throw new ArchivoAlteradoError();
      // La ruta canónica se arma con el estudio de la sesión, el cliente de la URL y el id de la fila; si la fila dice otra cosa, no
      // se lee nada de storage.
      if (version.ruta !== rutaArchivo(ctx.tenantId.toLowerCase(), clienteId.toLowerCase(), version.id)) throw new ArchivoAlteradoError();
      bytes = await leerVerificado(this.storage, version.ruta, version.sha256Zip);
    } catch (e) {
      // Alterado, truncado, ausente o con la ruta fuera de convención: para quien descarga es lo mismo y no se entrega nada.
      if (e instanceof ArchivoAlteradoError || e instanceof ArchivoNoEncontradoError || e instanceof RutaStorageError) {
        throw new ArchivosError("archivo_alterado");
      }
      throw e;
    }
    return { nombre: version.nombreZip, bytes };
  }
}
