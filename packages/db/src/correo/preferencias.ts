// Preferencias de correo del usuario de la sesión (spec 028; R-15, R-10, R-9, CA-1, CA-10, CA-12), con la `tx` del backend
// (`app.tenant_id` y `app.user_id`). Leer no escribe; fijar pasa por `correo_preferencias_fijar` (0074), que valida, audita y omite lo
// pendiente al apagar (D-7), y devuelve la vista releída en la misma transacción.
import {
  ARGUMENTO_INVALIDO,
  consultarCorreo,
  CorreoRepoError,
  fechaONull,
  SIN_PERMISO,
  type TxConsulta,
} from "./errores";

/** Vista cruda del usuario de la sesión en el estudio activo (el backend la convierte a `PreferenciasCorreoVista`). */
export interface PreferenciasLeidas {
  /** Efectivas: la fila si existe; si no, la inicial por rol (U-1, U-8): `planLimite` solo para Dueño, `resumen` apagado. */
  buzonCritico: boolean;
  credencialInvalida: boolean;
  planLimite: boolean;
  resumen: boolean;
  /** Valor guardado de «todos los clientes» (false sin fila); `todosIgnorado` dice si hoy no rige. */
  todosClientes: boolean;
  /** Dueño o Administrador sin ninguna asignación. */
  todosDisponible: boolean;
  /** Marcada pero hoy sin efecto (con asignaciones o sin rol Dueño o Administrador). */
  todosIgnorado: boolean;
  /** Todavía no existe la fila del resumen (R-15). */
  invitacionResumen: boolean;
  /** `creado_en` del último envío del usuario en el estudio si está `fallido`; null si no hay envíos o el último no falló (R-9). */
  ultimoEnvioFallido: Date | null;
}

export interface PreferenciasAFijar {
  buzonCritico: boolean;
  credencialInvalida: boolean;
  planLimite: boolean;
  resumen: boolean;
  todosClientes: boolean;
}

const CLAVES: readonly (keyof PreferenciasAFijar)[] = [
  "buzonCritico",
  "credencialInvalida",
  "planLimite",
  "resumen",
  "todosClientes",
];

// Una consulta: la membresía activa del usuario de la sesión (la RLS ata al estudio), sus filas (la RLS del backend solo deja ver las
// propias), si tiene asignaciones y su último envío entregado o fallido. Sin usuario o sin membresía activa: ninguna fila (42501).
const SQL_LEER = `
select m.rol,
       (select coalesce(jsonb_object_agg(p.tipo, jsonb_build_object('activo', p.activo, 'todos', p.todos_clientes)), '{}'::jsonb)
          from correo_preferencia p where p.usuario_id = m.usuario_id) as filas,
       exists (select 1 from asignacion a where a.usuario_id = m.usuario_id) as asignado,
       (select case when e.estado = 'fallido' then e.creado_en end
          from correo_envio e
         where e.usuario_id = m.usuario_id and e.estado in ('enviado', 'fallido')
         order by e.creado_en desc, e.id desc limit 1) as fallido
  from membresia m
 where m.usuario_id = nullif(current_setting('app.user_id', true), '')::uuid
   and m.desactivada_en is null`;

const SQL_FIJAR = "select correo_preferencias_fijar($1::jsonb) as r";

interface Fila {
  activo: boolean;
  todos: boolean;
}

export async function leerPreferencias(
  tx: TxConsulta,
): Promise<PreferenciasLeidas> {
  const [f] = await consultarCorreo(tx, SQL_LEER, []);
  if (f === undefined) throw new CorreoRepoError(SIN_PERMISO);
  const rol = String(f.rol);
  const filas = (f.filas ?? {}) as Record<string, Fila | undefined>;
  const efectiva = (tipo: string, inicial: boolean): boolean =>
    filas[tipo]?.activo ?? inicial;
  const todosClientes = filas.resumen?.todos === true;
  const todosDisponible =
    (rol === "dueno" || rol === "admin") && f.asignado !== true;
  return {
    buzonCritico: efectiva("buzon_critico", true),
    credencialInvalida: efectiva("credencial_invalida", true),
    planLimite: efectiva("plan_limite", rol === "dueno"),
    resumen: efectiva("resumen", false),
    todosClientes,
    todosDisponible,
    todosIgnorado: todosClientes && !todosDisponible,
    invitacionResumen: filas.resumen === undefined,
    ultimoEnvioFallido: fechaONull(f.fallido),
  };
}

/** `correo_preferencias_fijar(p jsonb)`; devuelve lo mismo que `leerPreferencias` justo después, en la misma transacción. */
export async function fijarPreferencias(
  tx: TxConsulta,
  p: PreferenciasAFijar,
): Promise<PreferenciasLeidas> {
  const entrada: unknown = p;
  if (typeof entrada !== "object" || entrada === null || Array.isArray(entrada))
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  const claves = Object.keys(entrada);
  if (
    claves.length !== CLAVES.length ||
    !CLAVES.every(
      (k) => typeof (entrada as Record<string, unknown>)[k] === "boolean",
    )
  )
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  const limpio = Object.fromEntries(CLAVES.map((k) => [k, p[k]]));
  await consultarCorreo(tx, SQL_FIJAR, [JSON.stringify(limpio)]);
  return leerPreferencias(tx);
}
