// Interruptores del motor y aporte al catálogo del estudio (spec 021, RF-089, P-8, P-10). Sin fila = encendido. Cambiar un
// interruptor toma el advisory EXCLUSIVO `reglas_motor:<estudio>`: espera a las descargas en curso, que lo toman compartido en
// `reglas_historial_vigentes` y `aplicar_regla_historial` (0048), así que una descarga aplica con el interruptor que leyó y la
// siguiente ya ve el nuevo. La auditoría (`estudio.regla_motor`, `estudio.aporte_catalogo`) la escriben los triggers de 0047.
import { consultar, type TxConsulta } from "../compras/errores";
import type { LecturaMotor } from "./tipos";

const SQL_FILAS = `select codigo, activa from estudio_regla_motor order by codigo`;
const SQL_APORTE = `select aportar_catalogo from estudio_reglas_config`;

// La misma clave que 0048: el estudio normalizado (uuid canónico en minúsculas).
const SQL_CANDADO = `select pg_advisory_xact_lock(
    hashtextextended('reglas_motor:' || nullif(current_setting('app.tenant_id', true), '')::uuid::text, 0))`;

const SQL_FIJAR_MOTOR = `insert into estudio_regla_motor (codigo, activa, actualizada_por) values ($1, $2, $3)
  on conflict (tenant_id, codigo) do update
    set activa = excluded.activa, actualizada_por = excluded.actualizada_por, actualizada_en = now()
    where estudio_regla_motor.activa is distinct from excluded.activa`;

const SQL_FIJAR_APORTE = `insert into estudio_reglas_config (aportar_catalogo) values ($1)
  on conflict (tenant_id) do update set aportar_catalogo = excluded.aportar_catalogo
    where estudio_reglas_config.aportar_catalogo is distinct from excluded.aportar_catalogo`;

/** Las filas guardadas del estudio y el aporte (sin fila de configuración: `true`). */
export async function leerReglasMotor(tx: TxConsulta): Promise<LecturaMotor> {
  const filas = await consultar(tx, SQL_FILAS);
  const aporte = await consultar(tx, SQL_APORTE);
  return {
    filas: filas.rows.map((f) => ({ codigo: f.codigo as string, activa: f.activa as boolean })),
    aportarCatalogo: (aporte.rows[0]?.aportar_catalogo as boolean | undefined) ?? true,
  };
}

/** Enciende o apaga una regla del motor del estudio. Un código fuera del catálogo lo rechaza el CHECK (23514). */
export async function fijarReglaMotor(
  tx: TxConsulta,
  e: { codigo: string; activa: boolean; usuarioId: string },
): Promise<void> {
  await consultar(tx, SQL_CANDADO);
  await consultar(tx, SQL_FIJAR_MOTOR, [e.codigo, e.activa, e.usuarioId]);
}

/** Enciende o apaga el aporte de confirmaciones al catálogo (P-10). El actor de la auditoría sale del contexto. */
export async function fijarAporte(
  tx: TxConsulta,
  e: { aportar: boolean; usuarioId: string },
): Promise<void> {
  await consultar(tx, SQL_FIJAR_APORTE, [e.aportar]);
}
