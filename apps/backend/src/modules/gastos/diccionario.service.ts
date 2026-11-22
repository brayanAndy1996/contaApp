import { Inject, Injectable } from "@nestjs/common";
import {
  agregarPalabra,
  cambiarEstadoGlobal,
  cambiarEstadoPalabra,
  fijarUmbral,
  leerGastosEstudio,
  type ContappDb,
  type Tx,
} from "@contapp/db";
import {
  agregarPalabraSchema,
  estadoGlobalSchema,
  estadoPalabraSchema,
  umbralSchema,
  type GastosEstudioVista,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { conReintentoUnico } from "../buzon/apoyo.js";
import { autoresDe } from "../compras/autor.js";
import { contextoDe, esUuid } from "../clientes/contexto.js";
import { aErrorHttp, esSqlstate } from "./errores.js";
import { normalizarExcepciones, normalizarPalabraGnd } from "./normalizar.js";
import { aGastosEstudioVista } from "./vistas.js";

/** Un id mal formado en la ruta es un recurso inexistente (404), igual que uno que no existe. */
function idDeRuta(valor: string): string {
  if (!esUuid(valor)) throw new AccesoError("no_encontrado");
  return valor.toLowerCase();
}

/**
 * Diccionario, globales desactivadas y umbral del estudio (spec 027, RF-117; R-4, R-6, R-8, R-11; D-3, D-4). Leer exige `reglas.ver`; escribir,
 * `reglas.gestionar` y alcance global (lo exige el controlador). Todo corre en `withTenant` (RLS): el estudio sale de la sesión, nunca del
 * cuerpo. Las escrituras llaman a las funciones acotadas de 0070, que llevan el límite de 2.000, el compare-and-set por versión y la auditoría
 * (017: sin glosas); un interbloqueo se reintenta una vez. El cuerpo se valida antes de abrir la transacción (400 `solicitud_invalida`).
 */
@Injectable()
export class DiccionarioService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  leer(sesion: SesionResuelta): Promise<GastosEstudioVista> {
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      const leidos = await leerGastosEstudio(tx);
      return aGastosEstudioVista(leidos, await autoresDe(tx, leidos.propias.map((p) => p.autor.id)));
    });
  }

  /** 201 `{ id, version: 1 }`. La palabra y las excepciones se normalizan con el dominio (sin tildes ni mayúsculas). */
  async agregar(sesion: SesionResuelta, cuerpo: unknown): Promise<{ id: string; version: number }> {
    const v = agregarPalabraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const palabra = normalizarPalabraGnd(v.data.palabra);
    const excepciones = normalizarExcepciones(v.data.excepciones);
    const id = await this.escribir(sesion, (tx) => agregarPalabra(tx, { palabra, categoria: v.data.categoria, excepciones }));
    return { id, version: 1 };
  }

  /** 200 `{ version }` (la nueva; la misma si la palabra ya tenía ese estado: la acción es idempotente). */
  async estadoPalabra(sesion: SesionResuelta, idCrudo: string, cuerpo: unknown): Promise<{ version: number }> {
    const v = estadoPalabraSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const id = idDeRuta(idCrudo);
    return this.idempotente(sesion, v.data.version, (tx) =>
      cambiarEstadoPalabra(tx, { id, activa: v.data.activa, version: v.data.version }),
    );
  }

  /**
   * El estudio desactiva o reactiva una global solo para él. Pedir el estado que ya tiene no cambia nada y responde igual (la BD lo avisa
   * como «sin cambios», 22023): la acción es idempotente y la API no da error por repetirla. El cuerpo y el id ya están validados, así
   * que ningún otro motivo produce 22023.
   */
  async estadoGlobal(sesion: SesionResuelta, idCrudo: string, cuerpo: unknown): Promise<Record<string, never>> {
    const v = estadoGlobalSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const id = idDeRuta(idCrudo);
    try {
      await this.ejecutar(sesion, (tx) => cambiarEstadoGlobal(tx, { palabraGlobalId: id, activa: v.data.activa }));
    } catch (e) {
      if (!esSqlstate(e, "22023")) throw aErrorHttp(e);
    }
    return {};
  }

  /** 200 `{ version }` (la nueva; la misma si el umbral ya era ese); versión 0 si el estudio nunca fijó uno. */
  async fijarUmbral(sesion: SesionResuelta, cuerpo: unknown): Promise<{ version: number }> {
    const v = umbralSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.idempotente(sesion, v.data.version, (tx) => fijarUmbral(tx, { umbral: v.data.umbral, version: v.data.version }));
  }

  /**
   * Una escritura con versión que devuelve la nueva. Si el estado pedido ya es el vigente la BD responde «sin cambios» (22023, después de
   * comprobar que la versión es la vigente): no se escribe nada y se responde con la misma versión, sin error. El cuerpo ya está
   * validado, así que ningún otro motivo produce 22023.
   */
  private async idempotente(sesion: SesionResuelta, versionVigente: number, operacion: (tx: Tx) => Promise<number>): Promise<{ version: number }> {
    try {
      return { version: await this.ejecutar(sesion, operacion) };
    } catch (e) {
      if (esSqlstate(e, "22023")) return { version: versionVigente };
      throw aErrorHttp(e);
    }
  }

  private escribir<T>(sesion: SesionResuelta, operacion: (tx: Tx) => Promise<T>): Promise<T> {
    return this.ejecutar(sesion, operacion).catch((e: unknown) => {
      throw aErrorHttp(e);
    });
  }

  /** Una transacción del estudio de la sesión; un interbloqueo o fallo de serialización se reintenta una vez. */
  private ejecutar<T>(sesion: SesionResuelta, operacion: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = contextoDe(sesion);
    return conReintentoUnico(() => this.db.withTenant(ctx, operacion));
  }
}
