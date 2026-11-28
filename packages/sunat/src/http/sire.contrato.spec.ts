/**
 * Prueba de contrato MANUAL del SIRE (spec 041, T9, CA-15, P-5, P-7). La corre el usuario, en su máquina, con su propio
 * RUC y un periodo pasado. NUNCA corre en `test`, `test:int` ni en CI (`vitest.config.mts` la excluye; la comprueba
 * `vitest-contrato.spec.ts`).
 *
 *   SIRE_CONTRATO=1 pnpm --filter @contapp/sunat test:contrato          (PowerShell: $env:SIRE_CONTRATO="1"; pnpm ...)
 *
 * Variables (de la sesión o de un `.env` ignorado por git): SIRE_CONTRATO_{CLIENT_ID,CLIENT_SECRET,RUC,USUARIO,CLAVE,PERIODO}.
 * `SIRE_CONTRATO_PERIODO` admite varios periodos AAAAMM separados por comas (p. ej. `202510,202509,202508`): cada caso
 * recorre todos, imprime las líneas P-5 por periodo y, al final, una línea con los totales sumados de P-5/P-6. Un periodo
 * sin datos no falla la prueba.
 * Casos: token, compras, ventas y registro presentado de compras (5.51, `descargarRegistroPresentado`: UNA solicitud con
 * `codProceso` 70 y `codMoneda` PEN —obligatorio pero sin efecto de filtro—, un ticket y un archivo con los comprobantes de todas
 * las monedas, cada fila con la suya; el informe es plano).
 * Solo hace el POST del token y GET (lectura). Imprime solo FORMAS y tiempos (líneas `[contrato-sire]`): nunca filas,
 * montos, RUC, nombres, tickets ni tokens. Las aserciones usan mensajes fijos para que un fallo tampoco los muestre.
 *
 * Todo fallo HTTP (token, exportar, ticket, archivo, solicitud 5.51) imprime una línea `[contrato-sire] … FALLO HTTP n` con el
 * código HTTP, las claves de primer nivel del cuerpo de error y `cod`/`msg` (principal y de su lista de errores): nunca el
 * cuerpo. El fallo de un caso (p. ej. ventas) no impide que corran los demás (cada caso es un `it` aparte).
 * `SIRE_CONTRATO_DIAGNOSTICO=1` (opcional, además de `SIRE_CONTRATO=1`): añade un caso que, para el registro presentado de
 * cada periodo, hace 12 GET de 5.51 (codProceso 70, 01, 02, 00 × sin codMoneda, PEN, USD) y por variante imprime solo HTTP,
 * tiempo y cod/msg; si una devuelve numTicket solo lo informa (no sigue el ticket). No toca el flujo normal del registro.
 *
 * Si el lector rechaza un archivo (`zip_invalido`), imprime su ESTRUCTURA (firma en hex, tamaño, EOCD, ZIP64, y por entrada: extensión,
 * ruta/directorio, nombre con las secuencias de 4+ dígitos tapadas, método, banderas, tamaños y CRC) y el motivo deducido contra las
 * reglas de `zip-seguro.ts`; nunca el contenido. En el registro, además, una línea con la estructura de la propuesta de compras
 * (referencia). Los casos corren en el orden token, compras, ventas, registro: la referencia sale si compras corrió antes.
 *
 * Encabezado del registro: el real difiere del de la propuesta solo en la columna 34 («ID Proyecto Operadores/Partícipes», no se
 * mapea). El informe lo distingue (`diferencia` «solo_no_mapeadas»): no es un fallo. Si la diferencia toca una columna que se
 * mapea, el cliente falla con `encabezado` y el informe lo dice («mapeadas»).
 *
 * `SIRE_CONTRATO_FALSO=1` (junto con `SIRE_CONTRATO=1`) corre lo mismo contra el servidor falso en 127.0.0.1 con los TXT
 * sintéticos y NO lee ninguna credencial: sirve para comprobar esta prueba sin SUNAT; el archivo del registro se sirve con la
 * estructura real del ZIP (3 entradas). Con `SIRE_CONTRATO_FALSO_ARCHIVOS_RAROS=1` el archivo del registro es rechazable (ZIP con
 * 2 entradas, una con ruta y descriptor de datos) y la prueba del registro FALLA a propósito, para ver las líneas de estructura.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LibroSire, TokenSire } from "../puertos.js";
import {
  contratoDiagnostico,
  contratoLibro,
  contratoRegistro,
  contratoToken,
  credencialesDelEntorno,
  diagnosticoActivo,
  lineaTotales,
  prepararServidorFalso,
  sumarTotalesP5,
  type EntradaContrato,
  type InformeLibro,
  type InformeRegistro,
} from "./pruebas/contrato-sire.js";

const activa = process.env["SIRE_CONTRATO"] === "1";
const falso = process.env["SIRE_CONTRATO_FALSO"] === "1";
/** Solo con el servidor falso: ventas da 503 y 5.51 da 422 con lista de errores (para comprobar la salida de los fallos). */
const falsoConErrores = falso && process.env["SIRE_CONTRATO_FALSO_ERRORES"] === "1";
const falsoConArchivosRaros = falso && process.env["SIRE_CONTRATO_FALSO_ARCHIVOS_RAROS"] === "1";
const diagnostico = diagnosticoActivo(process.env);

/** Anexo III: 01 cargado, 02 validando, 03 con errores, 04 sin errores, 05 en proceso, 06 terminado. */
const ESTADOS_DEL_MANUAL = ["01", "02", "03", "04", "05", "06"];
/** Una operación completa puede tardar el presupuesto (90 s) más la lectura. */
const TIMEOUT_MS = 150_000;

const emitir = (linea: string): void => {
  console.info(linea);
};

/** Un periodo sin datos (propuesta vacía o ticket listo sin archivos) no es un fallo del contrato. */
function periodoSinDatosLibro(i: InformeLibro): boolean {
  if (i.error === null) return i.filas !== null && i.filas.total === 0;
  const ultimo = i.ticket.estados[i.ticket.estados.length - 1] ?? "";
  return i.error.detalle === "sin_datos" || (["04", "06"].includes(ultimo) && i.ticket.partes === 0);
}

/** Forma común de las filas (montos, fechas, moneda, tipo de cambio). */
function afirmarFormaFilas(etiqueta: string, i: { filas: InformeLibro["filas"] }): void {
  const f = i.filas;
  expect(f !== null, `${etiqueta}: hay resultado de filas`).toBe(true);
  if (f === null) return;
  expect(f.tipoInvalido, `${etiqueta}: tipo de comprobante de 2 dígitos`).toBe(0);
  expect(f.numeroVacio, `${etiqueta}: número de comprobante no vacío`).toBe(0);
  expect(f.fechaInvalida, `${etiqueta}: fecha AAAA-MM-DD`).toBe(0);
  expect(f.monedaInvalida, `${etiqueta}: moneda PEN o USD`).toBe(0);
  expect(f.montoInvalido, `${etiqueta}: montos con 2 decimales (cadena)`).toBe(0);
  expect(f.tipoCambioInvalido, `${etiqueta}: tipo de cambio solo en USD y con forma 0.000`).toBe(0);
}

function afirmarLibro(libro: LibroSire, i: InformeLibro): void {
  const etiqueta = `${libro}: fallo ${i.error?.clase ?? ""} ${i.error?.detalle ?? ""}`;
  expect(i.error, etiqueta).toBeNull();
  expect(i.exportar !== null && i.exportar.campos.includes("numTicket"), `${libro}: la exportación devuelve numTicket`).toBe(true);
  expect(i.ticket.estados.length > 0, `${libro}: se consultó el ticket`).toBe(true);
  expect(
    i.ticket.estados.every((e) => ESTADOS_DEL_MANUAL.includes(e)),
    `${libro}: todos los estados del ticket son del anexo III`,
  ).toBe(true);
  expect(["04", "06"].includes(i.ticket.estados[i.ticket.estados.length - 1] ?? ""), `${libro}: el ticket termina en 04 o 06`).toBe(true);
  expect(i.ticket.partes > 0, `${libro}: el ticket trae al menos un archivo`).toBe(true);
  expect(i.archivos.length, `${libro}: se descargó cada parte del ticket`).toBe(i.ticket.partes);
  expect(i.archivos.every((a) => a.zipLegible && a.columnas > 0), `${libro}: cada parte es un ZIP con un TXT con encabezado`).toBe(true);

  // Si `descargarPropuesta` terminó, las columnas requeridas estaban todas y cada fila pasó el mapeo; aquí se verifica la
  // forma del resultado (cadenas canónicas, no `number`).
  afirmarFormaFilas(libro, i);
}

/**
 * Registro presentado (5.51): un error `sin_datos` solo vale si SUNAT dijo «sin datos» (422/400 con cod 1070 o TXT solo con
 * encabezado); cualquier otro fallo o rechazo de SUNAT falla (sus `cod`/`msg` ya salieron). Con ticket: estados del anexo III,
 * termina en 04/06, al menos un archivo legible y encabezado igual al de la propuesta o que difiere solo en nombres de columnas
 * que no se mapean. NO se exige que la columna `Moneda` sea la pedida: `codMoneda` no filtra y cada fila trae su moneda.
 */
function afirmarRegistro(i: InformeRegistro): void {
  if (i.error !== null && i.error.detalle === "sin_datos" && i.sinDatos) return;
  expect(i.error, `registro presentado: fallo ${i.error?.clase ?? ""} ${i.error?.detalle ?? ""} (ver líneas HTTP/cod/msg)`).toBeNull();
  const etiqueta = "registro presentado";
  expect(i.solicitud !== null, `${etiqueta}: se hizo la solicitud 5.51`).toBe(true);
  if (i.solicitud === null) return;
  expect(i.solicitud.codProceso, `${etiqueta}: codProceso 70`).toBe("70");
  expect(i.solicitud.estado >= 200 && i.solicitud.estado < 300, `${etiqueta}: SUNAT aceptó la solicitud`).toBe(true);
  expect(i.solicitud.devolvioTicket, `${etiqueta}: la solicitud devuelve numTicket`).toBe(true);
  expect(i.ticket.estados.length > 0, `${etiqueta}: se consultó el ticket`).toBe(true);
  expect(
    i.ticket.estados.every((e) => ESTADOS_DEL_MANUAL.includes(e)),
    `${etiqueta}: todos los estados del ticket son del anexo III`,
  ).toBe(true);
  expect(["04", "06"].includes(i.ticket.estados[i.ticket.estados.length - 1] ?? ""), `${etiqueta}: el ticket termina en 04 o 06`).toBe(true);
  expect(i.archivos.length > 0, `${etiqueta}: se descargó al menos un archivo`).toBe(true);
  expect(i.archivos.every((a) => a.zipLegible && a.columnas > 0), `${etiqueta}: cada parte es un ZIP con un TXT con encabezado`).toBe(true);
  expect(
    i.archivos.every((a) => a.encabezadoCoincide || a.diferencia === "solo_no_mapeadas"),
    `${etiqueta}: el encabezado es igual al de la propuesta o solo difiere en nombres de columnas que no se mapean`,
  ).toBe(true);
  // Las filas traen su propia moneda (PEN o USD); no se compara con la pedida.
  afirmarFormaFilas(etiqueta, { filas: i.filasArchivo });
  afirmarFormaFilas(`${etiqueta} (devuelto por el cliente)`, i);
}

describe.skipIf(!activa)(falso ? "contrato SIRE (servidor falso local)" : "contrato SIRE (SUNAT real, solo lectura)", () => {
  let entrada: EntradaContrato | undefined;
  let periodos: string[] = [];
  const todos: { filas: InformeLibro["filas"]; error: { detalle: string } | null }[] = [];
  let cerrar: () => Promise<void> = () => Promise.resolve();
  let token: TokenSire | undefined;

  beforeAll(async () => {
    if (falso) {
      const servidor = await prepararServidorFalso({ errores: falsoConErrores, archivosRaros: falsoConArchivosRaros });
      entrada = { ...servidor.entrada, emitir, referenciaZip: {} };
      periodos = [servidor.entrada.periodo];
      cerrar = servidor.cerrar;
    } else {
      const { credencial, periodo, periodos: lista } = credencialesDelEntorno(process.env);
      entrada = { credencial, periodo, emitir, referenciaZip: {} };
      periodos = lista;
    }
  });

  afterAll(async () => {
    await cerrar();
    // Una sola línea con lo sumado de todos los casos y periodos: ¿hubo NC, ND, USD, boletas, negativos?
    if (todos.length > 0) emitir(lineaTotales(sumarTotalesP5(periodos.length, todos)));
  });

  it(
    "token: POST de seguridad con respuesta de forma conocida",
    async () => {
      expect(entrada !== undefined, "entrada preparada").toBe(true);
      const r = await contratoToken(entrada!);
      token = r.token;
      expect(r.informe.tokenNoVacio, "token: access_token no vacío").toBe(true);
      expect(r.informe.segundosDeVida > 0, "token: expires_in positivo").toBe(true);
      expect(r.informe.campos.includes("access_token"), "token: la respuesta trae access_token").toBe(true);
      expect(r.informe.campos.includes("expires_in"), "token: la respuesta trae expires_in").toBe(true);
    },
    TIMEOUT_MS,
  );

  for (const libro of ["compras", "ventas"] as const) {
    it(
      `${libro}: exportar → ticket → archivo → TXT con columnas y tipos esperados`,
      async () => {
        expect(token !== undefined, `${libro}: hay token (el paso anterior debe pasar)`).toBe(true);
        const informes: { periodo: string; informe: InformeLibro }[] = [];
        for (const periodo of periodos) {
          const informe = await contratoLibro({ ...entrada!, periodo }, token!, libro);
          informes.push({ periodo, informe });
          todos.push(informe);
        }
        // Se imprime todo antes de afirmar; un periodo sin datos se salta, los demás deben cumplir el contrato.
        for (const { informe } of informes) {
          if (periodoSinDatosLibro(informe)) continue;
          afirmarLibro(libro, informe);
        }
        expect(informes.some(({ informe }) => !periodoSinDatosLibro(informe)), `${libro}: algún periodo tiene datos`).toBe(true);
      },
      TIMEOUT_MS,
    );
  }

  it(
    "compras: registro presentado (5.51) con el cliente real: una solicitud (codProceso 70 + codMoneda PEN), un ticket y un archivo con las filas de todas las monedas",
    async () => {
      expect(token !== undefined, "registro presentado: hay token (el primer paso debe pasar)").toBe(true);
      const informes: InformeRegistro[] = [];
      for (const periodo of periodos) {
        const informe = await contratoRegistro({ ...entrada!, periodo }, token!);
        informes.push(informe);
        todos.push(informe);
      }
      for (const informe of informes) afirmarRegistro(informe);
    },
    TIMEOUT_MS * 2,
  );

  it.skipIf(!diagnostico)(
    "diagnóstico 5.51: variantes de codProceso (70, 01, 02, 00) y codMoneda (sin, PEN, USD); solo informa",
    async () => {
      expect(token !== undefined, "diagnóstico: hay token (el primer paso debe pasar)").toBe(true);
      let variantes = 0;
      for (const periodo of periodos) variantes += (await contratoDiagnostico({ ...entrada!, periodo }, token!)).length;
      expect(variantes, "diagnóstico: se probaron las 12 variantes de cada periodo").toBe(12 * periodos.length);
    },
    TIMEOUT_MS * 2,
  );
});
