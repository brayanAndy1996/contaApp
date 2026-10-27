import { Inject, Injectable } from "@nestjs/common";
import {
  AuthRepoError,
  bloquearMiembro,
  crearInvitacion,
  listarInvitaciones,
  listarMiembros,
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
  puedeGestionar,
  type Rol,
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
import { CUPO_USUARIOS, type CupoUsuarios } from "./cupo/cupo-usuarios.js";
import {
  idDeRuta,
  parsearCuerpo,
  traducirInvitacionExistente,
} from "./entrada.js";
import { AccesoError, type CodigoAcceso } from "./errores.js";
import { mensajeInvitacion } from "./mensajes.js";
import {
  exigirGestor as exigirGestorDe,
  type Llamante,
} from "./usuarios.service.js";

/** Forma mínima de un correo (sin espacios, una arroba con texto a ambos lados), como en 004. */
const FORMA_CORREO = /^[^\s@]+@[^\s@]+$/;
/** Nombre visible de la cuenta nueva (sin espacios al borde). */
const NOMBRE_MAX = 200;

/** Resultado de `invitacion_aceptar_nueva` -> error (null = aceptada). `cuenta_existe` no consume (D15). */
const TRAS_ACEPTAR: Record<AceptacionNueva, CodigoAcceso | null> = {
  aceptada: null,
  cuenta_existe: "requiere_sesion",
  invalida: "invitacion_invalida",
};

export type InvitacionRespuesta = InvitacionListada;
export interface InvitacionConsultada {
  estudio: { nombre: string };
  rol: string;
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
  ) {}

  async listar(l: Llamante): Promise<InvitacionRespuesta[]> {
    return this.db.withTenant(
      { tenantId: l.tenantId, userId: l.usuarioId },
      (tx) => listarInvitaciones(tx),
    );
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
    const creada = await this.enTenant(l, async (tx) => {
      await this.exigirGestor(tx, l, null, entrada.rol);
      // RLS: solo los miembros de este estudio; no revela cuentas de otros estudios (CA-2).
      const miembros = await listarMiembros(tx);
      if (miembros.some((m) => m.correo === correo))
        throw new AccesoError("ya_es_miembro");
      await this.cupo.alInvitar(tx, l.tenantId);
      return crearInvitacion(tx, {
        correo,
        rol: entrada.rol,
        invitadoPor: l.usuarioId,
        tokenHash: hashToken(token),
      });
    });
    this.cola.encolar(mensajeInvitacion(correo, this.appOrigin, token));
    return creada;
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
    return inv;
  }

  async revocar(l: Llamante, idRuta: string | undefined): Promise<void> {
    const id = idDeRuta(idRuta);
    await this.sobreInvitacion(l, (tx) => revocar(tx, id));
  }

  /** Público, sin efectos (D7). Estudio solo por nombre: nunca su ID. */
  async consultar(cuerpo: unknown): Promise<InvitacionConsultada> {
    const { token } = parsearCuerpo(consultarInvitacionSchema, cuerpo);
    const v = await this.vigente(token);
    return {
      estudio: { nombre: v.estudioNombre },
      rol: v.rol,
      correo: v.correo,
      cuentaExiste: v.cuentaExiste,
    };
  }

  /**
   * Plan (Aceptación): zod -> política de 004 (antes de tocar el token) -> invitación viva (si no,
   * `invitacion_invalida` sin Argon2) -> cuenta existente: 409 `requiere_sesion` sin consumir (D15) ->
   * `fijarContrasena` -> `invitacion_aceptar_nueva` (usuario, credencial y membresía en una transacción).
   */
  async aceptar(cuerpo: unknown): Promise<void> {
    const {
      token,
      nombre: nombreCrudo,
      contrasena,
    } = parsearCuerpo(aceptarInvitacionSchema, cuerpo);
    const motivo = validarContrasena(contrasena, this.comunes);
    if (motivo !== null) throw new ContrasenaInvalidaError(motivo);
    const nombre = nombreCrudo.trim();
    if (nombre.length === 0 || nombre.length > NOMBRE_MAX)
      throw new AccesoError("solicitud_invalida");
    const v = await this.vigente(token);
    if (v.cuentaExiste) throw new AccesoError("requiere_sesion");

    const hash = await fijarContrasena(contrasena, {
      hasher: this.hasher,
      comunes: this.comunes,
    });
    // Pendiente (escalado en T10): `alAceptar(a, tenantId)` necesita el estudio de la invitación, que
    // `invitacion_vigente` no devuelve; irá en esta misma transacción, antes de `invitacion_aceptar_nueva`.
    const resultado = await this.db
      .withAuth((a) => a.invitacionAceptarNueva(hashToken(token), nombre, hash))
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
    const r = await this.db.withAuth(async (a) => {
      const aceptada = await a.invitacionAceptarExistente(
        hashToken(token),
        hashToken(s.token),
      );
      if (aceptada !== null) await this.cupo.alAceptar(a, aceptada.tenantId);
      return aceptada;
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
      throw traducirInvitacionExistente(e);
    }
  }

  /** Actor releído y bloqueado en la transacción (D3): activo, con `usuarios.gestionar` y D8 sobre el rol. */
  private async exigirGestor(
    tx: Tx,
    l: Llamante,
    objetivo: Rol | null,
    nuevo: Rol | null,
  ): Promise<void> {
    const rol = exigirGestorDe(await bloquearMiembro(tx, l.usuarioId));
    if (!puedeGestionar(rol, objetivo, nuevo))
      throw new AccesoError("permiso_denegado");
  }

  /**
   * Reenviar/revocar: aplica el cambio y comprueba D8 sobre el rol de la invitación en la misma transacción
   * (si falla, se deshace). `null` (inexistente, ajena, aceptada o revocada) -> 404.
   */
  private async sobreInvitacion(
    l: Llamante,
    cambio: (tx: Tx) => Promise<InvitacionListada | null>,
  ): Promise<InvitacionListada> {
    return this.enTenant(l, async (tx) => {
      const rol = exigirGestorDe(await bloquearMiembro(tx, l.usuarioId));
      const inv = await cambio(tx);
      if (inv === null) throw new AccesoError("no_encontrado");
      if (!puedeGestionar(rol, inv.rol, inv.rol))
        throw new AccesoError("permiso_denegado");
      return inv;
    });
  }
}
