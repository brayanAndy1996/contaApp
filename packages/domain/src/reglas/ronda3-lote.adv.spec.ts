// Spec 021 · ronda adversarial 3 sobre T25c (b): `crearEvaluadorReglas` valida el contexto una vez. Ataques: un contexto que se
// vuelve inválido después de crear el evaluador (getters que cambian, apagadas mutadas, Proxy revocado) y estado compartido entre
// filas (una fila que lanza entre dos válidas, resultados congelados, la fila mutada después de evaluarla). Si pasa, regresión.
import { describe, expect, it } from "vitest";
import { crearEvaluadorReglas, evaluarReglas } from "./motor";
import { EntradaReglasInvalidaError } from "./errores";
import type { CodigoReglaMotor, ContextoReglas, FilaEvaluable } from "./tipos";
import { MontosComprobante } from "../comprobante/index";
import { DICCIONARIO_GLOSAS_BASE } from "../texto/index";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const fila = (id: string, numero: string, m: Record<string, string>): FilaEvaluable => ({
  id,
  proveedor: { tipo: "6", numero },
  comprobante: { tipo: "01", serie: "F001", numero: "77" },
  montos: MontosComprobante.desde("PEN", { ...CERO, ...m }),
});
const FILAS: FilaEvaluable[] = [
  fila("a", "20100070970", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
  fila("b", "20999999999", { biDg: "21.48", igvDg: "1.61", total: "23.09" }),
  fila("c", "20500000009", { biDgng: "50.00", total: "50.00" }),
];
const VALIDO: ContextoReglas = {
  proveedoresConocidos: [{ tipo: "6", numero: "20100070970" }],
  proveedoresIsc: [{ tipo: "6", numero: "20500000009" }],
  diccionario: DICCIONARIO_GLOSAS_BASE,
  reglasApagadas: ["R-RED"],
};

describe("ronda 3 · crearEvaluadorReglas: contexto que cambia tras crear y estado compartido entre filas", () => {
  it("getters que se vuelven inválidos, apagadas mutadas y Proxy revocado no cuelan; una fila que lanza no contamina a las demás", () => {
    const esperado = evaluarReglas(FILAS, VALIDO);

    // 1) Getters: válidos en la primera lectura, inválidos después (documento fuera de gramática, diccionario falso, código raro).
    const lecturas: Record<string, number> = {};
    const leer = <T,>(k: string, bueno: T, malo: unknown): T => {
      lecturas[k] = (lecturas[k] ?? 0) + 1;
      return (lecturas[k] === 1 ? bueno : malo) as T;
    };
    const cambiante = {
      get proveedoresConocidos() { return leer("conocidos", VALIDO.proveedoresConocidos, [{ tipo: "6", numero: "no valido!" }]); },
      get proveedoresIsc() { return leer("isc", VALIDO.proveedoresIsc, 5); },
      get diccionario() { return leer("dic", DICCIONARIO_GLOSAS_BASE, { buscar: () => null }); },
      get reglasApagadas() { return leer("apagadas", ["R-RED"], ["R-NO-EXISTE"]); },
    } as unknown as ContextoReglas;
    const porGetters = crearEvaluadorReglas(cambiante);
    expect(porGetters(FILAS)).toEqual(esperado);
    expect(porGetters(FILAS)).toEqual(esperado);
    expect(lecturas, "cada clave del contexto se lee una sola vez").toEqual({ conocidos: 1, isc: 1, dic: 1, apagadas: 1 });
    // Y el mismo contexto, leído de nuevo (ya inválido), lanza: el evaluador no lo volvió a leer.
    expect(() => evaluarReglas(FILAS, cambiante)).toThrow(EntradaReglasInvalidaError);

    // 2) Apagadas mutadas tras crear (código desconocido, o apagar todo): no cambia lo evaluado.
    const apagadas: CodigoReglaMotor[] = ["R-RED"];
    const conMutables = crearEvaluadorReglas({ ...VALIDO, reglasApagadas: apagadas });
    apagadas.push("R-NO-EXISTE" as never, "R-MIX", "R-NEW", "R-ISC" as never);
    expect(conMutables(FILAS)).toEqual(esperado);

    // 3) Proxy revocado después de crear: el evaluador no vuelve a tocar el contexto.
    const { proxy, revoke } = Proxy.revocable({ ...VALIDO }, {});
    const porProxy = crearEvaluadorReglas(proxy);
    revoke();
    expect(porProxy(FILAS)).toEqual(esperado);

    // 4) Estado compartido entre filas: una fila inválida entre dos llamadas válidas no deja rastro; los resultados están
    //    congelados y mutar la fila ya evaluada no cambia lo que salió ni lo que sale después con la fila original.
    const evaluar = crearEvaluadorReglas(VALIDO);
    const primero = evaluar([FILAS[0]!]);
    expect(() => evaluar([{ ...FILAS[1]!, extra: 1 } as never])).toThrow(EntradaReglasInvalidaError);
    expect(() => evaluar([FILAS[1]!, FILAS[1]!])).toThrow(EntradaReglasInvalidaError);
    expect(evaluar([FILAS[0]!])).toEqual(primero);
    expect(Object.isFrozen(primero.hallazgos)).toBe(true);
    expect(() => (primero.hallazgos as unknown as unknown[]).push({})).toThrow(TypeError);
    const mutable = { ...FILAS[2]!, proveedor: { ...FILAS[2]!.proveedor } };
    const conMutable = evaluar([mutable]);
    const copia = JSON.parse(JSON.stringify(conMutable)) as unknown;
    (mutable.proveedor as { numero: string }).numero = "20100070970";
    expect(JSON.parse(JSON.stringify(conMutable))).toEqual(copia);
    expect(evaluar([FILAS[2]!])).toEqual(evaluarReglas([FILAS[2]!], VALIDO));
    expect(evaluar(FILAS)).toEqual(esperado);
  });
});
