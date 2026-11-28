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
 * Casos: token, compras, ventas y registro presentado de compras (5.51, `descargarRegistroPresentado`, codProceso 01 y, si
 * no hay datos, 02 una vez; sin codMoneda).
 * Solo hace el POST del token y GET (lectura). Imprime solo FORMAS y tiempos (líneas `[contrato-sire]`): nunca filas,
 * montos, RUC, nombres, tickets ni tokens. Las aserciones usan mensajes fijos para que un fallo tampoco los muestre.
 *
 * `SIRE_CONTRATO_FALSO=1` (junto con `SIRE_CONTRATO=1`) corre lo mismo contra el servidor falso en 127.0.0.1 con los TXT
 * sintéticos y NO lee ninguna credencial: sirve para comprobar esta prueba sin SUNAT.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LibroSire, TokenSire } from "../puertos.js";
import {
  contratoLibro,
  contratoRegistro,
  contratoToken,
  credencialesDelEntorno,
  lineaTotales,
  prepararServidorFalso,
  sumarTotalesP5,
  type EntradaContrato,
  type InformeLibro,
  type InformeRegistro,
} from "./pruebas/contrato-sire.js";

const activa = process.env["SIRE_CONTRATO"] === "1";
const falso = process.env["SIRE_CONTRATO_FALSO"] === "1";

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

/** Registro presentado (5.51): «sin datos en 01 y 02» no falla; cualquier rechazo de SUNAT sí (sus `cod`/`msg` ya salieron). */
function afirmarRegistro(i: InformeRegistro): void {
  if (i.sinDatos) return;
  expect(i.error, `registro presentado: fallo ${i.error?.clase ?? ""} ${i.error?.detalle ?? ""} (ver línea HTTP/cod/msg)`).toBeNull();
  expect(
    i.solicitudes.every((s) => s.estado >= 200 && s.estado < 300),
    "registro presentado: SUNAT aceptó la solicitud 5.51",
  ).toBe(true);
  expect(i.codProcesoConDatos !== null, "registro presentado: algún codProceso (01 o 02) dio datos").toBe(true);
  expect(i.ticket.estados.length > 0, "registro presentado: se consultó el ticket").toBe(true);
  expect(
    i.ticket.estados.every((e) => ESTADOS_DEL_MANUAL.includes(e)),
    "registro presentado: todos los estados del ticket son del anexo III",
  ).toBe(true);
  expect(["04", "06"].includes(i.ticket.estados[i.ticket.estados.length - 1] ?? ""), "registro presentado: el ticket termina en 04 o 06").toBe(true);
  expect(i.archivos.length > 0, "registro presentado: se descargó al menos un archivo").toBe(true);
  expect(i.archivos.every((a) => a.zipLegible && a.columnas > 0), "registro presentado: cada parte es un ZIP con un TXT con encabezado").toBe(true);
  afirmarFormaFilas("registro presentado", i);
}

describe.skipIf(!activa)(falso ? "contrato SIRE (servidor falso local)" : "contrato SIRE (SUNAT real, solo lectura)", () => {
  let entrada: EntradaContrato | undefined;
  let periodos: string[] = [];
  const todos: { filas: InformeLibro["filas"]; error: { detalle: string } | null }[] = [];
  let cerrar: () => Promise<void> = () => Promise.resolve();
  let token: TokenSire | undefined;

  beforeAll(async () => {
    if (falso) {
      const servidor = await prepararServidorFalso();
      entrada = { ...servidor.entrada, emitir };
      periodos = [servidor.entrada.periodo];
      cerrar = servidor.cerrar;
    } else {
      const { credencial, periodo, periodos: lista } = credencialesDelEntorno(process.env);
      entrada = { credencial, periodo, emitir };
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
    "compras: registro presentado (5.51) con el cliente real, codProceso 01 y, sin datos, 02; sin codMoneda",
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
});
