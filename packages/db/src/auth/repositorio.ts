// AuthRepo: una función TS por función SQL `auth.*` (SECURITY DEFINER, migraciones 0007_auth a 0010_auth_final,
// 0013_acceso_auth, que agrega las tres de invitación, y 0024_planes_auth, que agrega las 11 de registro, cupo de
// aceptación y plataforma).
// SQL estático `select * from auth.<función>($1, ...)` con parámetros posicionales (nunca se interpola un
// valor); columnas de salida = nombres OUT del plan (las escalares: columna con el nombre de la función);
// camelCase en TS; cero filas -> null; cualquier error de `pg` -> AuthRepoError (solo SQLSTATE). Las de plataforma
// además traducen sus rechazos estables (P0001) a PlataformaReglaError (motivo de una lista cerrada).
import type { Tx } from "../with-tenant";
import { AuthRepoError, PlataformaReglaError } from "./errores";

export type TxConsulta = Pick<Tx, "query">;
export type TipoLimite =
  | "login_ip"
  | "recup_correo"
  | "recup_ip"
  | "restab_ip"
  | "registro_ip"
  | "registro_correo";

export interface LoginPreparado {
  permitido: boolean;
  usuarioId: string | null;
  hash: string | null;
  alcanzaBloqueo: boolean;
}
export interface SesionEmitida {
  sesionId: string;
  expiraAbsoluta: Date;
}
export interface SesionValida {
  sesionId: string;
  usuarioId: string;
  tenantActivo: string | null;
  estudioRevocado: boolean;
  expiraAbsoluta: Date;
}
export interface LoginExitoArgs {
  clave: Buffer;
  usuarioId: string;
  /** Hash PHC que se verificó (el de `loginPreparar`): si la credencial cambió, no hay sesión (0010, O-1). */
  hashVerificado: string;
  tokenHash: Buffer;
  tenantActivo: string | null;
  hashNuevo: string | null;
  tokenAnteriorHash: Buffer | null;
}
export interface RecuperacionConsumida {
  usuarioId: string;
  correo: string;
}

/** Invitación viva (005, D7): lo que ve quien abre el enlace. Nunca el token ni su hash. */
export interface InvitacionVigente {
  /** Estudio de la invitación (0014): solo para `CupoUsuarios.alAceptar`; nunca se devuelve por HTTP. */
  tenantId: string;
  estudioNombre: string;
  correo: string;
  rol: string;
  cuentaExiste: boolean;
}
export type AceptacionNueva = "aceptada" | "cuenta_existe" | "invalida";
export interface AceptacionExistente {
  tenantId: string;
  estudioNombre: string;
}

/** 006 (D3): solicitud de registro; en BD solo se guarda el hash del token. */
export interface RegistroSolicitud {
  correo: string;
  estudio: string;
  ruc: string | null;
  nombre: string;
  tokenHash: Buffer;
}
/** 006: lo que ve quien abre el enlace de registro. Nunca el token ni su hash. */
export interface RegistroVigente {
  nombreEstudio: string;
  correo: string;
  cuentaExiste: boolean;
}
export type ConfirmacionNueva = "creado" | "cuenta_existe" | "invalida" | "sin_plan";
export interface RegistroConfirmado {
  tenantId: string;
  estudioNombre: string;
}
/** 006: plan completo (solo plataforma). Precios como cadena decimal de `pg` (NUMERIC(14,2)), nunca `number`. */
export interface PlanFila {
  id: string;
  codigo: string;
  nombre: string;
  precioMensual: string;
  precioAnual: string | null;
  maxRucs: number;
  maxUsuarios: number | null;
  precioRucExtra: string;
  maxRucsExtra: number;
  frecuenciaBuzonMin: number;
  features: Record<string, unknown>;
  activo: boolean;
}
/** 006: datos de alta o reemplazo completo de un plan (D11). */
export type DatosPlan = Omit<PlanFila, "id">;
/** 006 (D13): estudio visto por la plataforma; plan y estado null si el estudio no tiene suscripción. */
export interface EstudioPlataforma {
  id: string;
  nombre: string;
  plan: { codigo: string; nombre: string } | null;
  estado: "prueba" | "activa" | null;
}
export interface SuscripcionAsignada {
  tenantId: string;
  planId: string;
  planCodigo: string;
  planNombre: string;
  estado: "prueba" | "activa";
  rucsExtraContratados: number;
}

export interface AuthRepo {
  limiteConsumir(tipo: TipoLimite, sujeto: string): Promise<boolean>;
  loginPreparar(correo: string, clave: Buffer): Promise<LoginPreparado>;
  /** null si el estudio pedido no tiene membresía o la credencial ya no es la verificada (no se crea sesión). */
  loginExito(a: LoginExitoArgs): Promise<SesionEmitida | null>;
  sesionValidar(tokenHash: Buffer): Promise<SesionValida | null>;
  /** 008 (D22): valida igual que `sesionValidar` pero sin escrituras (no renueva `ultimo_uso` ni limpia el estudio). */
  sesionConsultar(tokenHash: Buffer): Promise<SesionValida | null>;
  sesionRotar(tokenHash: Buffer, tokenHashNuevo: Buffer, tenantNuevo: string | null): Promise<SesionEmitida | null>;
  sesionRevocar(tokenHash: Buffer): Promise<void>;
  sesionesCerrarTodas(tokenHash: Buffer): Promise<number>;
  ultimoEstudio(tokenHash: Buffer): Promise<string | null>;
  recuperacionCrear(correo: string, tokenHash: Buffer): Promise<boolean>;
  /** Sin efectos: el token existe, no se usó, no se invalidó y no venció (0008, antes de Argon2). */
  recuperacionVigente(tokenHash: Buffer): Promise<boolean>;
  recuperacionConsumir(tokenHash: Buffer, hashNuevo: string): Promise<RecuperacionConsumida | null>;
  contrasenaCambiar(tokenHash: Buffer, hashNuevo: string, tokenHashNuevo: Buffer): Promise<string | null>;
  /** 005: sin efectos; null si la invitación no está viva (aceptada, revocada, vencida o desconocida). */
  invitacionVigente(tokenHash: Buffer): Promise<InvitacionVigente | null>;
  /** 005, CA-3: crea usuario, credencial y membresía; 'cuenta_existe' no consume la invitación (D15). */
  invitacionAceptarNueva(tokenHash: Buffer, nombre: string, hash: string): Promise<AceptacionNueva>;
  /** 005, D15: con la sesión viva del titular (mismo correo, sin membresía previa); null si no procede. */
  invitacionAceptarExistente(tokenHash: Buffer, tokenHashSesion: Buffer): Promise<AceptacionExistente | null>;
  /** 006 (D3): mismo trabajo y mismo retorno exista o no la cuenta; invalida los pendientes del mismo correo. */
  registroCrear(s: RegistroSolicitud): Promise<void>;
  /** 006: sin efectos; null si el enlace no está vivo (vencido, consumido, invalidado o desconocido). */
  registroVigente(tokenHash: Buffer): Promise<RegistroVigente | null>;
  /** 006, CA-3: todo o nada; 'cuenta_existe' y 'sin_plan' no consumen el enlace. */
  registroConfirmarNueva(tokenHash: Buffer, hash: string): Promise<ConfirmacionNueva>;
  /** 006: con la sesión viva del titular (correo exacto del pendiente); null si no procede. */
  registroConfirmarExistente(tokenHash: Buffer, tokenHashSesion: Buffer): Promise<RegistroConfirmado | null>;
  /** 006 (D4, D7): toma el bloqueo `plan.cupo` del estudio y comprueba activos + 1 <= max; false sin suscripción. */
  cupoUsuariosAceptar(tenantId: string): Promise<boolean>;
  /** 006 (D5): usuario de la sesión si es admin de plataforma vivo; null si no. */
  plataformaYo(tokenHashSesion: Buffer): Promise<string | null>;
  /** 006: las de plataforma lanzan AuthRepoError 42501 si la sesión no es de un admin vivo. */
  planListar(tokenHashSesion: Buffer): Promise<PlanFila[]>;
  /** 23514 (valor inválido) y 23505 (código repetido) salen como AuthRepoError. */
  planCrear(tokenHashSesion: Buffer, datos: DatosPlan): Promise<PlanFila>;
  /** Reemplazo completo; plan inexistente -> PlataformaReglaError('no_encontrado'). */
  planEditar(tokenHashSesion: Buffer, planId: string, datos: DatosPlan): Promise<PlanFila>;
  estudiosListar(tokenHashSesion: Buffer): Promise<EstudioPlataforma[]>;
  /** PlataformaReglaError: 'no_encontrado' (estudio, suscripción o plan), 'plan_inactivo', 'extra_sobre_tope'. */
  suscripcionAsignar(
    tokenHashSesion: Buffer,
    tenantId: string,
    planId: string,
    rucsExtra: number,
  ): Promise<SuscripcionAsignada>;
}

const SQL = {
  limiteConsumir: "select * from auth.limite_consumir($1::text, $2::text)",
  loginPreparar: "select * from auth.login_preparar($1::text, $2::bytea)",
  loginExito:
    "select * from auth.login_exito($1::bytea, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::text, $7::bytea)",
  sesionValidar: "select * from auth.sesion_validar($1::bytea)",
  sesionConsultar: "select * from auth.sesion_consultar($1::bytea)",
  sesionRotar: "select * from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)",
  sesionRevocar: "select * from auth.sesion_revocar($1::bytea)",
  sesionesCerrarTodas: "select * from auth.sesiones_cerrar_todas($1::bytea)",
  ultimoEstudio: "select * from auth.ultimo_estudio($1::bytea)",
  recuperacionCrear: "select * from auth.recuperacion_crear($1::text, $2::bytea)",
  recuperacionVigente: "select * from auth.recuperacion_vigente($1::bytea)",
  recuperacionConsumir: "select * from auth.recuperacion_consumir($1::bytea, $2::text)",
  contrasenaCambiar: "select * from auth.contrasena_cambiar($1::bytea, $2::text, $3::bytea)",
  invitacionVigente: "select * from auth.invitacion_vigente($1::bytea)",
  invitacionAceptarNueva: "select * from auth.invitacion_aceptar_nueva($1::bytea, $2::text, $3::text)",
  invitacionAceptarExistente: "select * from auth.invitacion_aceptar_existente($1::bytea, $2::bytea)",
  registroCrear: "select * from auth.registro_crear($1::text, $2::text, $3::text, $4::text, $5::bytea)",
  registroVigente: "select * from auth.registro_vigente($1::bytea)",
  registroConfirmarNueva: "select * from auth.registro_confirmar_nueva($1::bytea, $2::text)",
  registroConfirmarExistente: "select * from auth.registro_confirmar_existente($1::bytea, $2::bytea)",
  cupoUsuariosAceptar: "select * from auth.cupo_usuarios_aceptar($1::uuid)",
  plataformaYo: "select * from auth.plataforma_yo($1::bytea)",
  planListar: "select * from auth.plan_listar($1::bytea)",
  planCrear:
    "select * from auth.plan_crear($1::bytea, $2::text, $3::text, $4::numeric, $5::numeric, $6::int, $7::int, $8::numeric, $9::int, $10::int, $11::jsonb, $12::boolean)",
  planEditar:
    "select * from auth.plan_editar($1::bytea, $2::uuid, $3::text, $4::text, $5::numeric, $6::numeric, $7::int, $8::int, $9::numeric, $10::int, $11::int, $12::jsonb, $13::boolean)",
  estudiosListar: "select * from auth.estudios_listar($1::bytea)",
  suscripcionAsignar: "select * from auth.suscripcion_asignar($1::bytea, $2::uuid, $3::uuid, $4::int)",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fila = Record<string, any>;

const sesionEmitida = (f: Fila): SesionEmitida => ({
  sesionId: f.sesion_id,
  expiraAbsoluta: f.expira_absoluta,
});

const sesionValida = (f: Fila[]): SesionValida | null =>
  f.length === 0
    ? null
    : {
        sesionId: f[0]!.sesion_id,
        usuarioId: f[0]!.usuario_id,
        tenantActivo: f[0]!.tenant_activo ?? null,
        estudioRevocado: f[0]!.estudio_revocado === true,
        expiraAbsoluta: f[0]!.expira_absoluta,
      };

const planFila = (f: Fila): PlanFila => ({
  id: f.id,
  codigo: f.codigo,
  nombre: f.nombre,
  precioMensual: f.precio_mensual,
  precioAnual: f.precio_anual ?? null,
  maxRucs: Number(f.max_rucs),
  maxUsuarios: f.max_usuarios === null ? null : Number(f.max_usuarios),
  precioRucExtra: f.precio_ruc_extra,
  maxRucsExtra: Number(f.max_rucs_extra),
  frecuenciaBuzonMin: Number(f.frecuencia_buzon_min),
  features: f.features,
  activo: f.activo === true,
});

/** Los 11 campos de `DatosPlan` en el orden posicional de plan_crear / plan_editar. */
const camposPlan = (d: DatosPlan): unknown[] => [
  d.codigo,
  d.nombre,
  d.precioMensual,
  d.precioAnual,
  d.maxRucs,
  d.maxUsuarios,
  d.precioRucExtra,
  d.maxRucsExtra,
  d.frecuenciaBuzonMin,
  JSON.stringify(d.features),
  d.activo,
];

/** Fachada sobre la transacción abierta por `withAuth`. */
export function crearAuthRepo(tx: TxConsulta): AuthRepo {
  /** Ejecuta y mapea; todo error (de pg o de forma) sale como AuthRepoError sin rastro del original. */
  async function ejecutar<T>(
    texto: string,
    valores: unknown[],
    mapear: (filas: Fila[]) => T,
    traducir: (e: unknown) => AuthRepoError = AuthRepoError.desde,
  ): Promise<T> {
    try {
      const r = await tx.query(texto, valores);
      return mapear(r.rows as Fila[]);
    } catch (e) {
      throw traducir(e);
    }
  }
  /** Funciones de plataforma: además traducen los rechazos estables a PlataformaReglaError. */
  const plataforma = <T>(texto: string, valores: unknown[], mapear: (filas: Fila[]) => T) =>
    ejecutar(texto, valores, mapear, PlataformaReglaError.desde);

  return {
    limiteConsumir: (tipo, sujeto) =>
      ejecutar(SQL.limiteConsumir, [tipo, sujeto], (f) => f[0]!.limite_consumir === true),
    loginPreparar: (correo, clave) =>
      ejecutar(SQL.loginPreparar, [correo, clave], (f) => ({
        permitido: f[0]!.permitido === true,
        usuarioId: f[0]!.usuario_id ?? null,
        hash: f[0]!.hash ?? null,
        alcanzaBloqueo: f[0]!.alcanza_bloqueo === true,
      })),
    loginExito: (a) =>
      ejecutar(
        SQL.loginExito,
        [a.clave, a.usuarioId, a.hashVerificado, a.tokenHash, a.tenantActivo, a.hashNuevo, a.tokenAnteriorHash],
        (f) => (f.length === 0 ? null : sesionEmitida(f[0]!)),
      ),
    sesionValidar: (tokenHash) => ejecutar(SQL.sesionValidar, [tokenHash], sesionValida),
    sesionConsultar: (tokenHash) => ejecutar(SQL.sesionConsultar, [tokenHash], sesionValida),
    sesionRotar: (tokenHash, tokenHashNuevo, tenantNuevo) =>
      ejecutar(SQL.sesionRotar, [tokenHash, tokenHashNuevo, tenantNuevo], (f) =>
        f.length === 0 ? null : sesionEmitida(f[0]!),
      ),
    sesionRevocar: (tokenHash) => ejecutar(SQL.sesionRevocar, [tokenHash], () => undefined),
    sesionesCerrarTodas: (tokenHash) =>
      ejecutar(SQL.sesionesCerrarTodas, [tokenHash], (f) => Number(f[0]!.sesiones_cerrar_todas)),
    ultimoEstudio: (tokenHash) =>
      ejecutar(SQL.ultimoEstudio, [tokenHash], (f) => (f[0]!.ultimo_estudio as string | null) ?? null),
    recuperacionCrear: (correo, tokenHash) =>
      ejecutar(SQL.recuperacionCrear, [correo, tokenHash], (f) => f[0]!.recuperacion_crear === true),
    recuperacionVigente: (tokenHash) =>
      ejecutar(SQL.recuperacionVigente, [tokenHash], (f) => f[0]!.recuperacion_vigente === true),
    recuperacionConsumir: (tokenHash, hashNuevo) =>
      ejecutar(SQL.recuperacionConsumir, [tokenHash, hashNuevo], (f) =>
        f.length === 0 ? null : { usuarioId: f[0]!.usuario_id as string, correo: f[0]!.correo as string },
      ),
    contrasenaCambiar: (tokenHash, hashNuevo, tokenHashNuevo) =>
      ejecutar(
        SQL.contrasenaCambiar,
        [tokenHash, hashNuevo, tokenHashNuevo],
        (f) => (f[0]?.contrasena_cambiar as string | null | undefined) ?? null,
      ),
    invitacionVigente: (tokenHash) =>
      ejecutar(SQL.invitacionVigente, [tokenHash], (f) =>
        f.length === 0
          ? null
          : {
              tenantId: f[0]!.tenant_id as string,
              estudioNombre: f[0]!.estudio_nombre as string,
              correo: f[0]!.correo as string,
              rol: f[0]!.rol as string,
              cuentaExiste: f[0]!.cuenta_existe === true,
            },
      ),
    invitacionAceptarNueva: (tokenHash, nombre, hash) =>
      ejecutar(
        SQL.invitacionAceptarNueva,
        [tokenHash, nombre, hash],
        (f) => f[0]!.invitacion_aceptar_nueva as AceptacionNueva,
      ),
    invitacionAceptarExistente: (tokenHash, tokenHashSesion) =>
      ejecutar(SQL.invitacionAceptarExistente, [tokenHash, tokenHashSesion], (f) =>
        f.length === 0
          ? null
          : { tenantId: f[0]!.tenant_id as string, estudioNombre: f[0]!.estudio_nombre as string },
      ),
    registroCrear: (s) =>
      ejecutar(SQL.registroCrear, [s.correo, s.estudio, s.ruc, s.nombre, s.tokenHash], () => undefined),
    registroVigente: (tokenHash) =>
      ejecutar(SQL.registroVigente, [tokenHash], (f) =>
        f.length === 0
          ? null
          : {
              nombreEstudio: f[0]!.nombre_estudio as string,
              correo: f[0]!.correo as string,
              cuentaExiste: f[0]!.cuenta_existe === true,
            },
      ),
    registroConfirmarNueva: (tokenHash, hash) =>
      ejecutar(
        SQL.registroConfirmarNueva,
        [tokenHash, hash],
        (f) => f[0]!.registro_confirmar_nueva as ConfirmacionNueva,
      ),
    registroConfirmarExistente: (tokenHash, tokenHashSesion) =>
      ejecutar(SQL.registroConfirmarExistente, [tokenHash, tokenHashSesion], (f) =>
        f.length === 0
          ? null
          : { tenantId: f[0]!.tenant_id as string, estudioNombre: f[0]!.estudio_nombre as string },
      ),
    cupoUsuariosAceptar: (tenantId) =>
      ejecutar(SQL.cupoUsuariosAceptar, [tenantId], (f) => f[0]!.cupo_usuarios_aceptar === true),
    plataformaYo: (tokenHashSesion) =>
      plataforma(SQL.plataformaYo, [tokenHashSesion], (f) => (f[0]?.usuario_id as string | undefined) ?? null),
    planListar: (tokenHashSesion) => plataforma(SQL.planListar, [tokenHashSesion], (f) => f.map(planFila)),
    planCrear: (tokenHashSesion, datos) =>
      plataforma(SQL.planCrear, [tokenHashSesion, ...camposPlan(datos)], (f) => planFila(f[0]!)),
    planEditar: (tokenHashSesion, planId, datos) =>
      plataforma(SQL.planEditar, [tokenHashSesion, planId, ...camposPlan(datos)], (f) => planFila(f[0]!)),
    estudiosListar: (tokenHashSesion) =>
      plataforma(SQL.estudiosListar, [tokenHashSesion], (f) =>
        f.map((x) => ({
          id: x.id as string,
          nombre: x.nombre as string,
          plan: x.plan_codigo == null ? null : { codigo: x.plan_codigo as string, nombre: x.plan_nombre as string },
          estado: (x.estado ?? null) as EstudioPlataforma["estado"],
        })),
      ),
    suscripcionAsignar: (tokenHashSesion, tenantId, planId, rucsExtra) =>
      plataforma(SQL.suscripcionAsignar, [tokenHashSesion, tenantId, planId, rucsExtra], (f) => ({
        tenantId: f[0]!.tenant_id as string,
        planId: f[0]!.plan_id as string,
        planCodigo: f[0]!.plan_codigo as string,
        planNombre: f[0]!.plan_nombre as string,
        estado: f[0]!.estado as SuscripcionAsignada["estado"],
        rucsExtraContratados: Number(f[0]!.rucs_extra_contratados),
      })),
  };
}
