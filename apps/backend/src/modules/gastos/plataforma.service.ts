import { Inject, Injectable } from "@nestjs/common";
import type { AuthRepo, ContappDb } from "@contapp/db";
import {
  editarGlobalSchema,
  palabraGlobalSchema,
  type DiccionarioGlobalVista,
  type HistorialGlobalVista,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { idDeRuta, parsearCuerpo } from "../acceso/entrada.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { hashToken } from "../auth/sesion/token.js";
import { aErrorHttp } from "./errores.js";
import { normalizarExcepciones, normalizarPalabraGnd } from "./normalizar.js";
import { aDiccionarioGlobalVista, aHistorialGlobalVista, aPalabraGlobalVista } from "./vistas.js";

/** Página por omisión del historial y sus límites (`auth.gnd_global_historial` acepta 1 a 200). */
const LIMITE_POR_OMISION = 50;
const LIMITE_MAX = 200;
const ENTERO_POSITIVO = /^[0-9]{1,3}$/;
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/** `?limite=` (1 a 200, entero; por omisión 50) y `?antes=` (instante ISO 8601 con zona), o 400 `solicitud_invalida`. */
function paginaDe(limite: unknown, antes: unknown): { limite: number; antes: Date | null } {
  let n = LIMITE_POR_OMISION;
  if (limite !== undefined) {
    if (typeof limite !== "string" || !ENTERO_POSITIVO.test(limite)) throw new AccesoError("solicitud_invalida");
    n = Number(limite);
    if (n < 1 || n > LIMITE_MAX) throw new AccesoError("solicitud_invalida");
  }
  let fecha: Date | null = null;
  if (antes !== undefined) {
    if (typeof antes !== "string" || !FECHA_ISO.test(antes)) throw new AccesoError("solicitud_invalida");
    fecha = new Date(antes);
    if (Number.isNaN(fecha.getTime())) throw new AccesoError("solicitud_invalida");
  }
  return { limite: n, antes: fecha };
}

/**
 * Diccionario global del super-admin (spec 027, RF-117, U-2, U-13; D-2, D-4; CA-7, CA-14). Cada operación corre en UN `withAuth` con el hash
 * de la sesión viva: primero `plataformaYo` (un no-admin recibe el mismo 403 con cualquier cuerpo o id, antes de validar nada) y después la
 * función `auth.gnd_global_*`, que vuelve a revalidar el alta. Ninguna toca tablas del estudio; cada escritura deja su fila en el historial
 * global (la auditoría de 017 es por estudio). La palabra y las excepciones se normalizan con el dominio.
 */
@Injectable()
export class DiccionarioPlataformaService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withAuth">) {}

  private async ejecutar<T>(s: SesionResuelta, fn: (a: AuthRepo, hash: Buffer) => Promise<T>): Promise<T> {
    const hash = hashToken(s.token);
    try {
      return await this.db.withAuth(async (a) => {
        if ((await a.plataformaYo(hash)) === null) throw new AccesoError("permiso_denegado");
        return fn(a, hash);
      });
    } catch (e) {
      throw aErrorHttp(e);
    }
  }

  listar(s: SesionResuelta): Promise<DiccionarioGlobalVista> {
    return this.ejecutar(s, async (a, h) => aDiccionarioGlobalVista(await a.gndGlobalListar(h)));
  }

  agregar(s: SesionResuelta, cuerpo: unknown) {
    return this.ejecutar(s, async (a, h) => {
      const v = parsearCuerpo(palabraGlobalSchema, cuerpo);
      const palabra = normalizarPalabraGnd(v.palabra);
      const excepciones = normalizarExcepciones(v.excepciones);
      return aPalabraGlobalVista(await a.gndGlobalAgregar(h, { palabra, categoria: v.categoria, excepciones }));
    });
  }

  editar(s: SesionResuelta, idCrudo: string | undefined, cuerpo: unknown) {
    return this.ejecutar(s, async (a, h) => {
      const id = idDeRuta(idCrudo);
      const v = parsearCuerpo(editarGlobalSchema, cuerpo);
      const excepciones = normalizarExcepciones(v.excepciones);
      return aPalabraGlobalVista(
        await a.gndGlobalEditar(h, id, { categoria: v.categoria, excepciones, activa: v.activa, version: v.version }),
      );
    });
  }

  historial(s: SesionResuelta, limite: unknown, antes: unknown): Promise<HistorialGlobalVista> {
    return this.ejecutar(s, async (a, h) => {
      const p = paginaDe(limite, antes);
      return aHistorialGlobalVista(await a.gndGlobalHistorial(h, p.limite, p.antes), p.limite);
    });
  }
}
