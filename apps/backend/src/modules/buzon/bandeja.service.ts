import { Inject, Injectable } from "@nestjs/common";
import {
  leerEstadoBuzon,
  listarBandeja,
  type Alcance,
  type ContappDb,
  type FiltrosBandejaBuzon,
  type FilaBandejaBuzon,
} from "@contapp/db";
import {
  filtrosBandejaClienteSchema,
  filtrosBandejaSchema,
  type FiltrosBandeja,
  type FiltrosBandejaCliente,
  type PaginaMensajesBuzon,
  type RespuestaBandeja,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { aEstado, exigirCliente, idDe, LIMITE_POR_OMISION } from "./apoyo.js";
import { codificarCursor, decodificarCursor, huellaDe, type HuellaFiltros, type PosicionCursor } from "./cursor.js";
import { aFilaBandeja } from "./mapeo.js";

/** Una página ya armada: las filas del contrato y el cursor de la siguiente (o `null`). */
interface Pagina {
  mensajes: RespuestaBandeja["mensajes"];
  siguiente: string | null;
}

/** Valida con `shared`; todo lo que no cumple (desconocido, repetido, arreglo, fuera de rango) es 400 `solicitud_invalida`, sin eco. */
function validar<T>(esquema: { safeParse(v: unknown): { success: boolean; data?: T } }, query: unknown): T {
  const r = esquema.safeParse(query);
  if (!r.success) throw new AccesoError("solicitud_invalida");
  return r.data as T;
}

/**
 * Bandeja de buzones (spec 024, D-2 a D-4, D-10; CA-1, CA-2, CA-9). Dos rutas, una consulta: `GET /buzon/mensajes` (alcance del rol,
 * sin ids de cliente en la entrada) y `GET /clientes/:clienteId/buzon/mensajes` (cliente fijado por la ruta y su
 * `ClienteScopeGuard`). El alcance se aplica siempre en SQL (`filtroAlcance` dentro de `listarBandeja`), nunca con lo que traiga el
 * cursor. Solo lectura: ningún efecto, ninguna llamada a SUNAT.
 */
@Injectable()
export class BandejaBuzonService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  /** Bandeja global del actor. «Solo donde soy responsable» es siempre el propio usuario de la sesión. */
  async listar(sesion: SesionResuelta, alcance: Alcance, queryCruda: unknown): Promise<RespuestaBandeja> {
    const q = validar<FiltrosBandeja>(filtrosBandejaSchema, queryCruda);
    const huella = huellaDe("global", {
      ...huellaBase(q),
      archivados: q.archivados === "1",
      responsable: q.responsable === "yo",
    });
    const posicion = this.posicion(q.cursor, huella);
    const filtros: FiltrosBandejaBuzon = {
      ...filtrosComunes(q),
      ...(q.archivados === "1" ? { archivados: true } : {}),
      ...(q.responsable === "yo" ? { responsableId: sesion.usuarioId } : {}),
    };
    return this.db.withTenant(contextoDe(sesion), (tx) =>
      this.pagina(tx, alcance, filtros, posicion, q.limite, huella),
    );
  }

  /** Bandeja fijada en un cliente (aunque esté archivado), con el estado de captura de 023. */
  async listarDeCliente(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    queryCruda: unknown,
  ): Promise<PaginaMensajesBuzon> {
    const clienteId = idDe(clienteCrudo).toLowerCase();
    const q = validar<FiltrosBandejaCliente>(filtrosBandejaClienteSchema, queryCruda);
    const huella = huellaDe(`cliente:${clienteId}`, huellaBase(q));
    const posicion = this.posicion(q.cursor, huella);
    const filtros: FiltrosBandejaBuzon = { ...filtrosComunes(q), clienteId };
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const estado = await leerEstadoBuzon(tx, clienteId);
      const { mensajes, siguiente } = await this.pagina(tx, alcance, filtros, posicion, q.limite, huella);
      return { estado: aEstado(estado, Date.now()), mensajes, siguiente };
    });
  }

  private posicion(cursor: string | undefined, huella: string): PosicionCursor | null {
    return cursor === undefined ? null : decodificarCursor(cursor, huella);
  }

  private async pagina(
    tx: Parameters<typeof listarBandeja>[0],
    alcance: Alcance,
    filtros: FiltrosBandejaBuzon,
    posicion: PosicionCursor | null,
    limiteCrudo: number | undefined,
    huella: string,
  ): Promise<Pagina> {
    const limite = limiteCrudo ?? LIMITE_POR_OMISION;
    const { filas, hayMas } = await listarBandeja(tx, alcance, filtros, posicion, limite);
    const ultima: FilaBandejaBuzon | undefined = filas.at(-1);
    return {
      mensajes: filas.map(aFilaBandeja),
      siguiente: hayMas && ultima !== undefined ? codificarCursor({ fecha: ultima.fechaTexto, id: ultima.id }, huella) : null,
    };
  }
}

/** Lo que forma la huella en las dos rutas (el valor por omisión de `atencion` ya viene aplicado por el esquema). */
function huellaBase(q: FiltrosBandejaCliente): HuellaFiltros {
  return { atencion: q.atencion, categoria: q.categoria, leido: q.leido, desde: q.desde, hasta: q.hasta };
}

/** Del texto de la query a los filtros del repositorio (`leido=si|no` → booleano). */
function filtrosComunes(q: FiltrosBandejaCliente): FiltrosBandejaBuzon {
  return {
    atencion: q.atencion,
    ...(q.categoria === undefined ? {} : { categoria: q.categoria }),
    ...(q.leido === undefined ? {} : { leido: q.leido === "si" }),
    ...(q.desde === undefined ? {} : { desde: q.desde }),
    ...(q.hasta === undefined ? {} : { hasta: q.hasta }),
  };
}
