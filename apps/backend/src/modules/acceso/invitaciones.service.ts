import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AuthRepoError,
  bloquearMiembros,
  crearInvitacion,
  listarInvitaciones,
  listarMiembros,
  nombreRolPropioDeInvitacion,
  reenviar,
  revocar,
  type AceptacionNueva,
  type ContappDb,
  type InvitacionListada,
  type Tx,
} from "@contapp/db";
import {
  aceptarConSesionSchema,
  aceptarInvitacionSchema,
  consultarInvitacionSchema,
  invitarSchema,
} from "@contapp/shared";
import {
  correoDeEntrada,
  type Encolador,
  type SesionResuelta,
} from "../auth/auth.service.js";
import type { Hasher } from "../auth/contrasena/hasher.js";
import {
  fijarContrasena,
  validarContrasena,
} from "../auth/contrasena/politica.js";
import { AuthError, ContrasenaInvalidaError } from "../auth/errores.js";
import {
  APP_ORIGIN,
  COLA_CORREO,
  COMUNES,
  DB,
  HASHER,
} from "../auth/inyeccion.js";
import {
  generarToken,
  hashToken,
  tokenConFormatoValido,
} from "../auth/sesion/token.js";
import {
  destinatariosPendientes,
  NOTIFICADOR,
  type Notificador,
} from "../notificaciones/notificador.js";
import { CUPO_USUARIOS, type CupoUsuarios } from "./cupo/cupo-usuarios.js";
import {
  idDeRuta,
  parsearCuerpo,
  traducirInvitacionExistente,
} from "./entrada.js";
import { releerEfectivos } from "./efectivo.js";
import { AccesoError, type CodigoAcceso } from "./errores.js";
import { mensajeInvitacion } from "./mensajes.js";
import type { RolPropioRef } from "./yo.controller.js";
import {
  exigirContencion,
  exigirGestor as exigirGestorDe,
  resolverRol,
  traducirAsignacion,
  type Llamante,
} from "./usuarios.service.js";

/**
 * Forma mínima de un correo (sin espacios, una arroba con texto a ambos lados), como en 004, y sin caracteres
 * de control (H-005-1b-2: NUL daba 500 y BEL/ESC llegaban a la BD y al correo; la BD también lo rechaza).
 */
const FORMA_CORREO = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u;
/** UUID que ningún rol tiene: un rol propio sin id se busca como inexistente (404). */
const UUID_NULO = "00000000-0000-0000-0000-000000000000";
/** Nombre visible de la cuenta nueva (sin espacios al borde). */
const NOMBRE_MAX = 200;
/**
 * Caracteres de control (C0, DEL, C1; H-005-1b-3) y de formato (ancho cero, marcas y aislamientos bidi, BOM,
 * etiquetas; H-005-2a-2): no van en el nombre. La BD (0016) rechaza los mismos por rangos de código. Spec 006 (a3):
 * también los separadores de línea y párrafo U+2028/U+2029 (no son Cc ni Cf); 0025 los suma a `registro_pendiente`.
 */
const CONTROL_O_FORMATO = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** Al menos una letra o un dígito decimal (como `[[:alnum:]]` bajo ICU en 0016): un nombre no es solo signos. */
const LETRA_O_DIGITO = /[\p{L}\p{Nd}]/u;

/** Nombre visible válido (ya recortado): 1..200, sin control ni formato, con alguna letra o dígito. */
export function nombreValido(nombre: string): boolean {
  return (
    nombre.length > 0 &&
    nombre.length <= NOMBRE_MAX &&
    !CONTROL_O_FORMATO.test(nombre) &&
    LETRA_O_DIGITO.test(nombre)
  );
}

/** Resultado de `invitacion_aceptar_nueva` -> error (null = aceptada). `cuenta_existe` no consume (D15). */
const TRAS_ACEPTAR: Record<AceptacionNueva, CodigoAcceso | null> = {
  aceptada: null,
  cuenta_existe: "requiere_sesion",
  invalida: "invitacion_invalida",
};

/** Invitación pendiente tal como se responde: con `rolPropio: {id, nombre}` (030) en vez de las columnas del rol propio. */
export type InvitacionRespuesta = Omit<InvitacionListada, "rolId" | "rolNombre"> & {
  rolPropio: RolPropioRef | null;
};

/** 030: `rolPropio` por fila (null con un rol de sistema). */
export function respuestaDe(i: InvitacionListada): InvitacionRespuesta {
  const { rolId, rolNombre, ...resto } = i;
  return {
    ...resto,
    rolPropio: i.rol === "propio" && rolId !== null && rolNombre !== null ? { id: rolId, nombre: rolNombre } : null,
  };
}
export interface InvitacionConsultada {
  estudio: { nombre: string };
  rol: string;
  /** T15a (030): solo con rol propio y solo su nombre actual (nunca id, permisos ni alcance). */
  rolPropio?: { nombre: string };
  correo: string;
  cuentaExiste: boolean;
}
export interface AceptadaConSesion {
  estudio: { id: string; nombre: string };
}

type DbAcceso = Pick<ContappDb, "withTenant" | "withAuth">;

/**
 * Invitaciones (CA-2, CA-3, D7, D15). Solo el SHA-256 del token va a la BD y nada de lo que se responde lo
 * lleva (CA-14). El correo sale por la cola tras el commit. Toda respuesta de token no vivo es la misma
 * (`invitacion_invalida`), sin Argon2.
 */
@Injectable()
export class InvitacionesService {
  constructor(
    @Inject(DB) private readonly db: DbAcceso,
    @Inject(HASHER) private readonly hasher: Hasher,
    @Inject(COLA_CORREO) private readonly cola: Encolador,
    @Inject(COMUNES) private readonly comunes: ReadonlySet<string>,
    @Inject(APP_ORIGIN) private readonly appOrigin: string,
    @Inject(CUPO_USUARIOS) private readonly cupo: CupoUsuarios,
    @Optional() @Inject(NOTIFICADOR) private readonly notificador?: Notificador,
  ) {}

  async listar(l: Llamante): Promise<InvitacionRespuesta[]> {
    const filas = await this.db.withTenant(
      { tenantId: l.tenantId, userId: l.usuarioId },
      (tx) => listarInvitaciones(tx),
    );
    return filas.map(respuestaDe);
  }

  /**
   * zod -> correo normalizado -> en una transacción: actor releído (D3) y D8 -> miembro activo o desactivado
   * del estudio: 409 `ya_es_miembro` -> `CupoUsuarios` -> invitación (otra pendiente: 409) -> correo.
   */
  async invitar(l: Llamante, cuerpo: unknown): Promise<InvitacionRespuesta> {
    const entrada = parsearCuerpo(invitarSchema, cuerpo);
    const correo = correoDeEntrada(entrada.correo);
    if (!FORMA_CORREO.test(correo)) throw new AccesoError("solicitud_invalida");
    const token = generarToken();
    let avisar: string[] = [];
    const creada = await this.enTenant(l, async (tx) => {
      // 030: el rol puede ser propio (`{ rolId }`): ajeno o inexistente 404; contenido en el actor (U2, U4) o 403.
      const actor = await this.actorGestor(tx, l);
      const nuevo = await resolverRol(tx, entrada.rol);
      exigirContencion(actor, null, nuevo);
      // RLS: solo los miembros de este estudio; no revela cuentas de otros estudios (CA-2).
      const miembros = await listarMiembros(tx);
      if (miembros.some((m) => m.correo === correo))
        throw new AccesoError("ya_es_miembro");
      await this.cupo.alInvitar(tx, l.tenantId);
      const invitacion = await crearInvitacion(tx, {
        correo,
        rol: nuevo.rol,
        rolId: nuevo.rolId,
        invitadoPor: l.usuarioId,
        tokenHash: hashToken(token),
      });
      avisar = await destinatariosPendientes(this.notificador, tx);
      return invitacion;
    });
    // Spec 017 (D-9): aviso en vivo tras el commit (el 90 % o el 100 % de usuarios que cruzó la invitación).
    await this.notificador?.avisar(l.tenantId, avisar);
    this.cola.encolar(mensajeInvitacion(correo, this.appOrigin, token));
    return respuestaDe(creada);
  }

  /** Nuevo token (el anterior deja de valer) y 72 h más; solo un Dueño toca una invitación de rol `dueno`. */
  async reenviar(
    l: Llamante,
    idRuta: string | undefined,
  ): Promise<InvitacionRespuesta> {
    const id = idDeRuta(idRuta);
    const token = generarToken();
    const inv = await this.sobreInvitacion(l, (tx) =>
      reenviar(tx, id, hashToken(token)),
    );
    this.cola.encolar(mensajeInvitacion(inv.correo, this.appOrigin, token));
    return respuestaDe(inv);
  }

  async revocar(l: Llamante, idRuta: string | undefined): Promise<void> {
    const id = idDeRuta(idRuta);
    await this.sobreInvitacion(l, (tx) => revocar(tx, id));
  }

  /** Público, sin efectos (D7). Estudio solo por nombre: nunca su ID. */
  async consultar(cuerpo: unknown): Promise<InvitacionConsultada> {
    const { token } = parsearCuerpo(consultarInvitacionSchema, cuerpo);
    const v = await this.vigente(token);
    // T15a (030): el nombre del rol propio se lee con la RLS del estudio de la propia invitación (tenantId de la BD, nunca de la
    // entrada) y por el mismo hash de token. Si ya no está viva o su rol no se puede leer: el mismo 400 que un token inválido.
    let rolPropio: { nombre: string } | undefined;
    if (v.rol === "propio") {
      const nombre = await this.db.withTenant(
        { tenantId: v.tenantId, foto: true },
        (tx) => nombreRolPropioDeInvitacion(tx, hashToken(token)),
      );
      if (nombre === null) throw new AccesoError("invitacion_invalida");
      rolPropio = { nombre };
    }
    return {
      estudio: { nombre: v.estudioNombre },
      rol: v.rol,
      ...(rolPropio === undefined ? {} : { rolPropio }),
      correo: v.correo,
      cuentaExiste: v.cuentaExiste,
    };
  }

  /**
   * Plan (Aceptación): zod -> política de 004 (antes de tocar el token) -> invitación viva (si no,
   * `invitacion_invalida` sin Argon2) -> cuenta existente: 409 `requiere_sesion` sin consumir (D15) ->
   * `fijarContrasena` -> `cupo.alAceptar` + `invitacion_aceptar_nueva` (usuario, credencial y membresía en una
   * transacción).
   */
  async aceptar(cuerpo: unknown): Promise<void> {
    const {
      token,
      nombre: nombreCrudo,
      contrasena,
    } = parsearCuerpo(aceptarInvitacionSchema, cuerpo);
    const motivo = validarContrasena(contrasena, this.comunes);
    if (motivo !== null) throw new ContrasenaInvalidaError(motivo);
    // H-005-1b-3, H-005-2a-2: nombre inválido -> 400 antes de tocar el token y de Argon2 (la BD lo revalida).
    const nombre = nombreCrudo.trim();
    if (!nombreValido(nombre)) throw new AccesoError("solicitud_invalida");
    const v = await this.vigente(token);
    if (v.cuentaExiste) throw new AccesoError("requiere_sesion");

    const hash = await fijarContrasena(contrasena, {
      hasher: this.hasher,
      comunes: this.comunes,
    });
    // D11 (plan, ratificación 7): el cupo del estudio de la invitación se consulta en la misma transacción,
    // antes de crear la cuenta. `tenantId` no cambia; `invitacion_aceptar_nueva` revalida el token FOR UPDATE.
    const resultado = await this.db
      .withAuth(async (a) => {
        await this.cupo.alAceptar(a, v.tenantId);
        return a.invitacionAceptarNueva(hashToken(token), nombre, hash);
      })
      .catch((e: unknown): AceptacionNueva => {
        // Dos invitaciones distintas para el mismo correo nuevo chocan en `usuario.email`: una gana (plan, Riesgos).
        if (e instanceof AuthRepoError) return "invalida";
        throw e;
      });
    const codigo = TRAS_ACEPTAR[resultado];
    if (codigo !== null) throw new AccesoError(codigo);
  }

  /**
   * D15: el titular de la cuenta acepta con su sesión viva (mismo correo, sin membresía previa). El cupo se
   * consulta en la misma transacción que crea la membresía (D11).
   */
  async aceptarConSesion(
    s: SesionResuelta,
    cuerpo: unknown,
    xEstudio?: string,
  ): Promise<AceptadaConSesion> {
    // Ruta sin estudio, pero un `X-Estudio` distinto del de la sesión no llega al negocio (D13, HU-40).
    if (xEstudio !== undefined && xEstudio !== s.tenantActivo)
      throw new AuthError("estudio_desfasado");
    const { token } = parsearCuerpo(aceptarConSesionSchema, cuerpo);
    if (!tokenConFormatoValido(token))
      throw new AccesoError("invitacion_invalida");
    // Orden de bloqueo (T15): invitación vigente -> cupo del estudio -> membresía, todo en el mismo `withAuth`.
    // El cupo se consulta antes de crear la membresía; si no hay cupo (409) o la invitación no procede, no queda nada.
    const r = await this.db.withAuth(async (a) => {
      const v = await a.invitacionVigente(hashToken(token));
      if (v === null) return null;
      await this.cupo.alAceptar(a, v.tenantId);
      return a.invitacionAceptarExistente(hashToken(token), hashToken(s.token));
    });
    if (r === null) throw new AccesoError("invitacion_invalida");
    return { estudio: { id: r.tenantId, nombre: r.estudioNombre } };
  }

  private async vigente(token: string) {
    if (!tokenConFormatoValido(token))
      throw new AccesoError("invitacion_invalida");
    const v = await this.db.withAuth((a) =>
      a.invitacionVigente(hashToken(token)),
    );
    if (v === null) throw new AccesoError("invitacion_invalida");
    return v;
  }

  private async enTenant<T>(
    l: Llamante,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.withTenant(
        { tenantId: l.tenantId, userId: l.usuarioId },
        fn,
      );
    } catch (e) {
      throw traducirAsignacion(traducirInvitacionExistente(e));
    }
  }

  /** Actor releído y bloqueado en la transacción (D3): activo y con `usuarios.gestionar`, con sus permisos efectivos (030). */
  private async actorGestor(tx: Tx, l: Llamante) {
    const filas = await releerEfectivos(tx, await bloquearMiembros(tx, [l.usuarioId]));
    return exigirGestorDe(filas.get(l.usuarioId.toLowerCase()) ?? null);
  }

  /**
   * Reenviar/revocar: aplica el cambio y comprueba D8 sobre el rol de la invitación en la misma transacción
   * (si falla, se deshace). `null` (inexistente, ajena, aceptada o revocada) -> 404. 030: con el rol propio de la invitación.
   */
  private async sobreInvitacion(
    l: Llamante,
    cambio: (tx: Tx) => Promise<InvitacionListada | null>,
  ): Promise<InvitacionListada> {
    return this.enTenant(l, async (tx) => {
      const actor = await this.actorGestor(tx, l);
      const inv = await cambio(tx);
      if (inv === null) throw new AccesoError("no_encontrado");
      // El rol de la invitación (030: también propio). Uno que no se puede leer (la FK y el CHECK lo impiden) da 404 y se deshace.
      const rol = await resolverRol(tx, inv.rol === "propio" ? { rolId: inv.rolId ?? UUID_NULO } : inv.rol);
      const actual = { rol: inv.rol, efectivo: rol.efectivo };
      exigirContencion(actor, actual, actual);
      return inv;
    });
  }
}
