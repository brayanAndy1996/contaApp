import { Inject, Injectable } from "@nestjs/common";
import {
  AccesoRepoError,
  bloquearRoles,
  eliminarRol,
  guardarRol,
  impactoRol,
  leerRol,
  listarRoles,
  miembroActual,
  usoRol,
  type ContappDb,
  type ImpactoRol,
  type RolLeido,
  type RolListado,
  type Tx,
} from "@contapp/db";
import {
  PERMISOS,
  ROLES,
  crearRolSchema,
  editarRolSchema,
  esNombreRolReservado,
  permisosEfectivos,
  puedeGestionar,
  puedeGestionarRol,
  validarCombinacion,
  type AlcanceRol,
  type Efectivo,
  type Permiso,
  type Rol,
} from "@contapp/shared";
import { DB } from "../../auth/inyeccion.js";
import { idDeRuta, parsearCuerpo } from "../entrada.js";
import { AccesoError } from "../errores.js";
import type { Llamante } from "../usuarios.service.js";

/** Rol de sistema tal como lo ve `GET /roles` (solo lectura: viven en código). */
export interface RolSistemaRespuesta {
  rol: Rol;
  alcance: AlcanceRol;
  permisos: Permiso[];
}

export interface ListaRoles {
  sistema: RolSistemaRespuesta[];
  propios: RolListado[];
}

export interface Asignables {
  sistema: Rol[];
  propios: Array<{ id: string; nombre: string }>;
}

export type RolRespuesta = RolLeido;

/** Intentos de DELETE /roles/:id cuando el 23503 ya no se explica con los conteos (carrera; ver `eliminar`). */
const ELIMINAR_INTENTOS = 3;

/** Los permisos de un rol de sistema en el orden del catálogo. */
const enOrdenDeCatalogo = (permisos: ReadonlySet<Permiso>): Permiso[] =>
  PERMISOS.filter((p) => permisos.has(p));

/** Un rol propio guardado, como `Efectivo` (nunca cuenta como Dueño: `rolSistema` null). */
const efectivoDe = (r: { permisos: readonly string[]; alcance: AlcanceRol }): Efectivo =>
  permisosEfectivos("propio", { permisos: r.permisos as readonly Permiso[], alcance: r.alcance });

/**
 * Roles propios del estudio (spec 030: CA-1, CA-2, CA-5, CA-6, U5, U6, U9). Sin SQL propio: repos de `@contapp/db` dentro de
 * `withTenant`. La regla de escalada, U3, el límite y la auditoría viven en las funciones de la 0082 (CA-5 en BD); aquí se repite U3
 * antes de llegar a la BD (422 con el permiso faltante) y los SQLSTATE de la BD se traducen a códigos fijos.
 */
@Injectable()
export class RolesService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  private conTenant<T>(l: Llamante, f: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenant({ tenantId: l.tenantId, userId: l.usuarioId }, f);
  }

  /** Los 5 roles de sistema (solo lectura) y los propios del estudio con sus conteos de uso. */
  async listar(l: Llamante): Promise<ListaRoles> {
    const propios = await this.conTenant(l, (tx) => listarRoles(tx));
    const sistema = ROLES.map((rol) => {
      const e = permisosEfectivos(rol);
      return { rol, alcance: e.alcance, permisos: enOrdenDeCatalogo(e.permisos) };
    });
    return { sistema, propios };
  }

  /** Lo que el actor puede asignar al invitar o cambiar de rol: `puedeGestionar(actor, null, rol)` (U2, U4). */
  async asignables(l: Llamante): Promise<Asignables> {
    return this.conTenant(l, async (tx) => {
      const m = await miembroActual(tx, l.usuarioId);
      if (m === null) throw new AccesoError("estudio_requerido");
      // Sin definición del rol propio (no ocurre: FK compuesta) se resuelve al mínimo: nada que asignar.
      const actor =
        m.rol === "propio"
          ? efectivoDe(m.propio ?? { permisos: [], alcance: "asignado" })
          : permisosEfectivos(m.rol);
      const propios = (await listarRoles(tx))
        .filter((r) => puedeGestionar(actor, null, efectivoDe(r)))
        .map((r) => ({ id: r.id, nombre: r.nombre }));
      const sistema = ROLES.filter((r) => puedeGestionar(actor, null, permisosEfectivos(r)));
      return { sistema, propios };
    });
  }

  async crear(l: Llamante, cuerpo: unknown): Promise<RolRespuesta> {
    const datos = parsearCuerpo(crearRolSchema, cuerpo);
    exigirNombreLibre(datos.nombre);
    exigirCombinacion(datos.permisos, datos.alcance);
    try {
      return await this.conTenant(l, async (tx) => {
        // `baseRolId` solo parte la pantalla de un rol existente: debe ser de este estudio (404 si no).
        if (datos.baseRolId !== undefined && (await leerRol(tx, datos.baseRolId)) === null)
          throw new AccesoError("no_encontrado");
        const id = await guardarRol(tx, datos);
        return (await leerRol(tx, id)) as RolLeido;
      });
    } catch (e) {
      throw traducir(e);
    }
  }

  /** Cambio parcial: lo no enviado conserva su valor. Bajo el candado de roles, así dos parciales no se pisan. */
  async editar(l: Llamante, idRuta: string | undefined, cuerpo: unknown): Promise<RolRespuesta> {
    const id = idDeRuta(idRuta);
    const cambio = parsearCuerpo(editarRolSchema, cuerpo);
    if (Object.keys(cambio).length === 0) throw new AccesoError("solicitud_invalida");
    if (cambio.nombre !== undefined) exigirNombreLibre(cambio.nombre);
    if (cambio.permisos !== undefined) exigirCombinacion(cambio.permisos, cambio.alcance ?? "asignado");
    try {
      return await this.conTenant(l, async (tx) => {
        await bloquearRoles(tx);
        const actual = await leerRol(tx, id);
        if (actual === null) throw new AccesoError("no_encontrado");
        await guardarRol(tx, {
          id,
          nombre: cambio.nombre ?? actual.nombre,
          alcance: cambio.alcance ?? actual.alcance,
          permisos: cambio.permisos ?? actual.permisos,
        });
        return (await leerRol(tx, id)) as RolLeido;
      });
    } catch (e) {
      throw traducir(e);
    }
  }

  async eliminar(l: Llamante, idRuta: string | undefined): Promise<void> {
    const id = idDeRuta(idRuta);
    // 23503: en uso. `acceso.rol_eliminar` (0084) bloquea solo con miembros activos o invitaciones vigentes, los mismos predicados de
    // `usoRol`. La transacción abortó, así que los conteos se leen en otra: si entre ambas lo que bloqueaba desapareció (revocada,
    // vencida, cambio de rol), se reintenta en vez de responder un 409 en ceros.
    for (let intento = 1; ; intento++) {
      try {
        await this.conTenant(l, (tx) => eliminarRol(tx, id));
        return;
      } catch (e) {
        if (!(e instanceof AccesoRepoError && e.codigo === "23503")) throw traducir(e);
        const uso = await this.conTenant(l, (tx) => usoRol(tx, id));
        if (uso.miembros + uso.invitaciones > 0 || intento >= ELIMINAR_INTENTOS) {
          throw new AccesoError("rol_en_uso", { miembros: uso.miembros, invitaciones: uso.invitaciones });
        }
      }
    }
  }

  /** U6, U8: efecto de una edición, sin aplicarla (se valida igual que editar; lo no enviado conserva su valor). */
  async impacto(l: Llamante, idRuta: string | undefined, cuerpo: unknown): Promise<ImpactoRol> {
    const id = idDeRuta(idRuta);
    const cambio = parsearCuerpo(editarRolSchema, cuerpo);
    if (cambio.permisos !== undefined) exigirCombinacion(cambio.permisos, cambio.alcance ?? "asignado");
    try {
      return await this.conTenant(l, async (tx) => {
        const actual = await leerRol(tx, id);
        if (actual === null) throw new AccesoError("no_encontrado");
        const despues = { alcance: cambio.alcance ?? actual.alcance, permisos: cambio.permisos ?? actual.permisos };
        // T13 (ronda 1a): mismas reglas y códigos que `acceso.rol_guardar` en el PATCH (RL001 -> rol_propio, 42501 -> escalada),
        // antes de contar nada: un rol que el actor no podría editar no revela su impacto (U2).
        const m = await miembroActual(tx, l.usuarioId);
        if (m === null) throw new AccesoError("estudio_requerido");
        if (m.rolId !== null && m.rolId.toLowerCase() === id.toLowerCase()) throw new AccesoError("rol_propio");
        const actor = m.rol === "propio" ? efectivoDe(m.propio ?? { permisos: [], alcance: "asignado" }) : permisosEfectivos(m.rol);
        if (!puedeGestionarRol(actor, efectivoDe(actual), efectivoDe(despues), false)) throw new AccesoError("escalada");
        return impactoRol(tx, id, despues);
      });
    } catch (e) {
      throw traducir(e);
    }
  }
}

/** CA-1 (T13): un nombre que, normalizado como `nombre_clave`, es el de un rol de sistema es 409, igual que el CHECK de la BD. */
function exigirNombreLibre(nombre: string): void {
  if (esNombreRolReservado(nombre)) throw new AccesoError("nombre_duplicado");
}

/** U3 y el catálogo (CA-2): 422 con código fijo; solo `combinacion_invalida` nombra el permiso (del catálogo, no es eco). */
function exigirCombinacion(permisos: readonly string[], alcance: AlcanceRol): void {
  const r = validarCombinacion(permisos, alcance);
  if (r.ok) return;
  if (r.error === "permiso_invalido") throw new AccesoError("permiso_invalido");
  throw new AccesoError("combinacion_invalida", { permiso: r.permiso });
}

/** SQLSTATE de las funciones de 0082 -> código HTTP fijo; lo demás sigue (el filtro global lo vuelve 500 sin detalles). */
function traducir(e: unknown): unknown {
  if (!(e instanceof AccesoRepoError)) return e;
  switch (e.codigo) {
    case "42501":
      return new AccesoError("escalada");
    case "RL001":
      return new AccesoError("rol_propio");
    case "54000":
      return new AccesoError("limite_roles");
    case "23505":
    case "23514": // CHECK del nombre contra los de sistema (alcance y catálogo ya los validó `exigirCombinacion`)
      return new AccesoError("nombre_duplicado");
    case "P0002":
      return new AccesoError("no_encontrado");
    default:
      return e;
  }
}
