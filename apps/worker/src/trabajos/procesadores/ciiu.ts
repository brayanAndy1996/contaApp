// CIIU del proveedor y del cliente al llegar el XML (spec 027, R-14; CA-16). Lee los RUC pendientes de la caché del estudio, consulta
// cada uno por el puerto `ConsultaRuc` SIN transacción abierta (008 D6) y guarda lo obtenido con `gnd_ciiu_guardar` en una
// transacción corta. `ErrorDatos` guarda «sin dato» (`null`, 30 días); `ErrorTransitorio` y cualquier otro fallo no guardan nada.
// NUNCA lanza: un CIIU que falta solo quita señales al puntaje y no puede fallar el trabajo del XML. Nada de lo consultado ni de los
// errores llega a logs: la función no registra.
import { ciiuPendientes, guardarCiiu, type ContappDb } from "@contapp/db";
import { ErrorDatos, type ConsultaRuc } from "@contapp/sunat";

export interface DepsCiiu {
  db: Pick<ContappDb, "withTenant">;
  consultaRuc: ConsultaRuc;
}

/** `gnd_ciiu_guardar` acepta hasta 50 entradas por llamada. */
const MAX_ENTRADAS = 50;
const RUC = /^[0-9]{11}$/;
const CIIU = /^[0-9]{4}$/;

/** Consulta (fuera de transacción) los RUC sin caché o con más de 30 días y los guarda; nunca lanza. */
export async function asegurarCiiu(
  d: DepsCiiu,
  estudio: { tenantId: string },
  rucs: readonly string[],
): Promise<void> {
  try {
    const pedidos = [...new Set(rucs.filter((r) => typeof r === "string" && RUC.test(r)))];
    if (pedidos.length === 0) return;
    const pendientes = await d.db.withTenant(estudio, (tx) => ciiuPendientes(tx, pedidos));

    const entradas: { ruc: string; ciiu: string | null }[] = [];
    for (const ruc of pendientes) {
      try {
        const datos = await d.consultaRuc.consultar(ruc);
        entradas.push({ ruc, ciiu: typeof datos.ciiu === "string" && CIIU.test(datos.ciiu) ? datos.ciiu : null });
      } catch (e) {
        // Solo la clase cuenta: «sin dato» si el padrón no acepta el RUC; si es transitorio o inesperado, se pedirá de nuevo.
        if (e instanceof ErrorDatos) entradas.push({ ruc, ciiu: null });
      }
    }

    for (let i = 0; i < entradas.length; i += MAX_ENTRADAS) {
      const trozo = entradas.slice(i, i + MAX_ENTRADAS);
      await d.db.withTenant(estudio, (tx) => guardarCiiu(tx, trozo));
    }
  } catch {
    // La caché es una ayuda: la BD caída o una función que rechaza no tumban el XML. No se registra nada (sin secretos en logs).
  }
}
