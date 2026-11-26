// Soporte del correo de avisos por SQL (spec 028, T21). Misma regla que `siembra.ts`: solo opera sobre `contapp_e2e` con
// la conexión de migraciones. La programación del resumen es una fila única de plataforma (`correo_programacion`): el
// soporte mueve su hora a las 00:00, admite todos los días y la deja sin día cerrado, para que el siguiente ciclo del
// worker (60 s) cree el resumen del día de la prueba aunque corra de noche, en fin de semana o tras el primer ciclo del
// día; `restaurarProgramacionDeResumen` la devuelve a lo de fábrica (07:00, lunes a viernes).
import { Pool } from "pg";
import { BD_E2E } from "./pila/entorno.js";

function url(): string {
  const u = process.env.MIGRATIONS_DATABASE_URL;
  if (u === undefined || new URL(u).pathname !== `/${BD_E2E}`) {
    throw new Error(`El soporte del correo solo opera sobre ${BD_E2E}.`);
  }
  return u;
}

const MS_ESPERA_CICLO = 30_000;

/**
 * Pone la hora del resumen en 00:00 y todos los días, y deja el día sin cerrar. Si un ciclo del worker está en curso
 * espera a que termine antes de abrir el día (si no, el cierre de ese ciclo lo volvería a cerrar).
 */
export async function adelantarResumen(): Promise<void> {
  const pool = new Pool({ connectionString: url(), max: 1 });
  try {
    await pool.query(
      `update correo_programacion
          set hora_resumen = '00:00', dias_resumen = '{1,2,3,4,5,6,7}'
        where id = 1`,
    );
    const limite = Date.now() + MS_ESPERA_CICLO;
    for (;;) {
      const r = await pool.query(
        `update correo_programacion set resumen_cerrado = null
          where id = 1 and (ciclo_hasta is null or ciclo_hasta < clock_timestamp())`,
      );
      if (r.rowCount === 1) return;
      if (Date.now() > limite) {
        throw new Error("Un ciclo de correo no terminó a tiempo.");
      }
      await new Promise((ok) => setTimeout(ok, 250));
    }
  } finally {
    await pool.end();
  }
}

/** Devuelve la hora y los días del resumen a los de fábrica (07:00, lunes a viernes). */
export async function restaurarProgramacionDeResumen(): Promise<void> {
  const pool = new Pool({ connectionString: url(), max: 1 });
  try {
    await pool.query(
      `update correo_programacion
          set hora_resumen = '07:00', dias_resumen = '{1,2,3,4,5}'
        where id = 1`,
    );
  } finally {
    await pool.end();
  }
}
