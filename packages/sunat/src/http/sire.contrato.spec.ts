/**
 * Prueba de contrato MANUAL del SIRE (spec 041, T9, CA-15, P-5, P-7). La corre el usuario, en su máquina, con su propio
 * RUC y un periodo pasado. NUNCA corre en `test`, `test:int` ni en CI (`vitest.config.mts` la excluye; la comprueba
 * `vitest-contrato.spec.ts`).
 *
 *   SIRE_CONTRATO=1 pnpm --filter @contapp/sunat test:contrato
 *
 * Variables (de la sesión o de un `.env` ignorado por git): SIRE_CONTRATO_{CLIENT_ID,CLIENT_SECRET,RUC,USUARIO,CLAVE,PERIODO}.
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
  contratoToken,
  credencialesDelEntorno,
  prepararServidorFalso,
  type EntradaContrato,
  type InformeLibro,
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
  const f = i.filas;
  expect(f !== null, `${libro}: hay resultado de filas`).toBe(true);
  if (f === null) return;
  expect(f.tipoInvalido, `${libro}: tipo de comprobante de 2 dígitos`).toBe(0);
  expect(f.numeroVacio, `${libro}: número de comprobante no vacío`).toBe(0);
  expect(f.fechaInvalida, `${libro}: fecha AAAA-MM-DD`).toBe(0);
  expect(f.monedaInvalida, `${libro}: moneda PEN o USD`).toBe(0);
  expect(f.montoInvalido, `${libro}: montos con 2 decimales (cadena)`).toBe(0);
  expect(f.tipoCambioInvalido, `${libro}: tipo de cambio solo en USD y con forma 0.000`).toBe(0);
}

describe.skipIf(!activa)(falso ? "contrato SIRE (servidor falso local)" : "contrato SIRE (SUNAT real, solo lectura)", () => {
  let entrada: EntradaContrato | undefined;
  let cerrar: () => Promise<void> = () => Promise.resolve();
  let token: TokenSire | undefined;

  beforeAll(async () => {
    if (falso) {
      const servidor = await prepararServidorFalso();
      entrada = { ...servidor.entrada, emitir };
      cerrar = servidor.cerrar;
    } else {
      const { credencial, periodo } = credencialesDelEntorno(process.env);
      entrada = { credencial, periodo, emitir };
    }
  });

  afterAll(async () => {
    await cerrar();
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
        const informe = await contratoLibro(entrada!, token!, libro);
        afirmarLibro(libro, informe);
      },
      TIMEOUT_MS,
    );
  }
});
