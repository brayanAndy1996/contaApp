// Ayuda de prueba de 013 (T3): las 11 filas de fixtures/sire/20700000002-ventas-202610.json copiadas a mano (packages/domain no
// hace IO, así que sus pruebas no leen el JSON; igual que FIXTURE_* de 012). Si el fixture cambia, esta copia debe cambiar:
// la comprobación contra el JSON real va en packages/sunat (fixtures.humo.spec.ts / T4).
export interface FilaFixtureVenta {
  readonly tipo: string;
  readonly serie: string;
  readonly numero: string;
  readonly moneda: "PEN" | "USD";
  readonly tipoCambio: string | null;
  readonly baseGravada: string;
  readonly igv: string;
  readonly exonerada: string;
  readonly inafecta: string;
  readonly isc: string;
  readonly icbper: string;
  readonly otros: string;
  readonly total: string;
}

function fila(
  tipo: string,
  serie: string,
  numero: string,
  moneda: "PEN" | "USD",
  tipoCambio: string | null,
  m: readonly [string, string, string, string, string, string, string, string],
): FilaFixtureVenta {
  return {
    tipo, serie, numero, moneda, tipoCambio,
    baseGravada: m[0], igv: m[1], exonerada: m[2], inafecta: m[3], isc: m[4], icbper: m[5], otros: m[6], total: m[7],
  };
}

/** Orden del JSON: B001-290 y 292 (sin la 291), F001-10 a 12, NC F001-1, USD F002-1 (TC 3.300) y F002-2 (sin TC), B003-400, 401 y 405. */
export const FIXTURE_VENTAS_202610: readonly FilaFixtureVenta[] = [
  fila("03", "B001", "290", "PEN", null, ["100.00","18.00","0.00","0.00","0.00","0.00","0.00","118.00"]),
  fila("03", "B001", "292", "PEN", null, ["50.00","9.00","0.00","0.00","0.00","0.00","0.00","59.00"]),
  fila("01", "F001", "10", "PEN", null, ["200.00","36.00","0.00","0.00","0.00","0.00","0.00","236.00"]),
  fila("01", "F001", "11", "PEN", null, ["300.00","54.00","0.00","0.00","0.00","0.00","0.00","354.00"]),
  fila("01", "F001", "12", "PEN", null, ["0.00","0.00","150.00","0.00","0.00","0.00","0.00","150.00"]),
  fila("07", "F001", "1", "PEN", null, ["-50.00","-9.00","0.00","0.00","0.00","0.00","0.00","-59.00"]),
  fila("01", "F002", "1", "USD", "3.300", ["200.00","36.00","0.00","0.00","0.00","0.00","0.00","236.00"]),
  fila("01", "F002", "2", "USD", null, ["100.00","18.00","0.00","0.00","0.00","0.00","0.00","118.00"]),
  fila("03", "B003", "400", "PEN", null, ["25.00","4.50","0.00","0.00","0.00","0.00","0.00","29.50"]),
  fila("03", "B003", "401", "PEN", null, ["40.00","7.20","0.00","0.00","0.00","0.00","0.00","47.20"]),
  fila("03", "B003", "405", "PEN", null, ["60.00","10.80","0.00","0.00","0.00","0.00","0.00","70.80"]),
];
