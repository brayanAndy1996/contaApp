// Spec 027 · T15 (ronda adversarial 1, dominio). Caja negra con spec.md (R-3, R-4, R-7, R-11, D-7; CA-9, CA-18) y caja blanca de
// `texto/diccionario.ts` (`esPalabra`, `#agregarDeToken`) y `gastos/terminos.ts`. Cada prueba que falla es un hallazgo H-027-1-n.
//  - Normalización entre aprender y coincidir: lo que `proponerTerminos` ofrece (el token tal cual, en plural si la glosa lo trae) es
//    lo que se guarda; la coincidencia de 011 solo acepta el plural simple del lado de la GLOSA (token = palabra + s/es).
//  - D-7: sin S1 no hay hallazgo, ni con umbral 1 y todas las demás señales al máximo.
import { describe, expect, it } from "vitest";
import { ctx, de, evaluar, fila, xml } from "../../tests/ayudas/filas-motor";
import { FECHA_SABADO, PROV_MOTOR, SEMILLA_GLOBAL, contextoGastos } from "../../tests/ayudas/gastos";
import type { ContextoReglas } from "../reglas/index";
import { crearDiccionarioEfectivo } from "./contexto";
import { puntuarGastoPersonal } from "./puntaje";
import { proponerTerminos } from "./terminos";

const aprendida = (palabra: string) => ({ palabra, categoria: "entretenimiento", excepciones: [] as string[], activa: true });
const conPropias = (palabras: string[]) =>
  crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: [], propias: palabras.map(aprendida) });
const palabrasDe = (glosa: string, palabras: string[]) =>
  conPropias(palabras)
    .coincidenciasPorItem([glosa])
    .map((c) => c.palabra);

describe("T15 · aprender → coincidir (R-4, R-7, CA-9)", () => {
  it("CA-9: el término propuesto de «AUDIFONOS BLUETOOTH JBL X2 UND 2.00» y guardado tal cual marca la siguiente compra con «audífono»", () => {
    const propuestos = proponerTerminos(["AUDIFONOS BLUETOOTH JBL X2 UND 2.00"], conPropias([]));
    expect(propuestos).toContain("audifonos");
    // El usuario elige «audifonos» (CA-9) y se guarda normalizado, sin cambiarlo: la siguiente evaluación con «audífono» debe marcar.
    expect(palabrasDe("AUDÍFONO INALAMBRICO", ["audifonos"])).toEqual(["audifonos"]);
    expect(palabrasDe("Audífono Sony", ["audifonos"])).toEqual(["audifonos"]);
  });

  it("aprender de una glosa en plural y volver a pedir la propuesta de una compra en singular no ofrece otra vez la misma palabra", () => {
    // Tras guardar «parlantes» (propuesto de «PARLANTES PORTATILES»), una glosa «PARLANTE PORTATIL» no debería proponer «parlante» de nuevo
    // (sería la misma palabra con otra forma, que el diccionario del estudio acumularía repetida).
    expect(proponerTerminos(["PARLANTE PORTATIL"], conPropias(["parlantes", "portatiles"]))).toEqual([]);
  });

  it("palabra aprendida en singular («audifono») marca la glosa en plural, con tilde, con punto final y como abreviatura (nota del equipo)", () => {
    for (const glosa of ["AUDIFONOS JBL", "AUDÍFONOS JBL", "audifonos.", "AUDIFONOS.38", "audif. jbl", "2 AUDIFONOES"]) {
      expect(palabrasDe(glosa, ["audifono"]), glosa).toEqual(["audifono"]);
    }
    // Y no vuelve a proponerla.
    expect(proponerTerminos(["AUDÍFONOS BLUETOOTH"], conPropias(["audifono"]))).toEqual(["bluetooth"]);
  });
});

describe("T15 · D-7: sin palabra clave no hay hallazgo (R-3, R-11, CA-18)", () => {
  const conGastos = (g: ReturnType<typeof contextoGastos>, over: Partial<ContextoReglas> = {}): ContextoReglas =>
    ctx({ gastos: g, ...over } as Partial<ContextoReglas>);
  const gp = (glosas: string[], fecha: string, g: ReturnType<typeof contextoGastos>, over: Partial<ContextoReglas> = {}) =>
    de(evaluar([fila({ xml: xml({ glosas, fechaEmision: fecha } as never) })], conGastos(g, over)).hallazgos, "R-GP");

  // Restaurante (5610, rubro de consumo personal, grupo 561 ≠ 475 del cliente) un sábado, proveedor nuevo y con 2 excluidas: S2 + S4 + S5 + S6.
  const historial = [{ proveedor: { ...PROV_MOTOR }, aceptadas6: 0, excluidas6: 2, excluidas12: 5 }];
  const maximo = (umbral: number) =>
    contextoGastos({ umbral, ciiuCliente: "4752", ciiuProveedores: [{ proveedor: { ...PROV_MOTOR }, ciiu: "5610" }], historial });

  it("umbral 1 y S2 + S4 + S5 + S6 (puntaje 9) sin palabra: ningún hallazgo", () => {
    const r = puntuarGastoPersonal(
      { glosas: ["MENU EJECUTIVO"], fechaEmision: FECHA_SABADO, proveedor: { ...PROV_MOTOR }, esNuevo: true },
      maximo(1),
    );
    expect(r).toMatchObject({ palabra: null, puntaje: 9 });
    expect(gp(["MENU EJECUTIVO"], FECHA_SABADO, maximo(1), { proveedoresConocidos: [] })).toEqual([]);
  });

  it("palabra anulada por su excepción en el mismo ítem («zapatilla de seguridad») con todas las demás señales: ningún hallazgo", () => {
    expect(gp(["ZAPATILLA DE SEGURIDAD PUNTA DE ACERO"], FECHA_SABADO, maximo(1), { proveedoresConocidos: [] })).toEqual([]);
  });

  it("varios ítems sin palabra y uno vacío o solo con números: ningún hallazgo", () => {
    expect(gp(["", "123 456", "...", "MENU"], FECHA_SABADO, maximo(1), { proveedoresConocidos: [] })).toEqual([]);
  });
});
