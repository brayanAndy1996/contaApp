// Evaluación de reglas de la descarga de compras (spec 014, D-4, plan «Worker»). Adapta `evaluarReglas` de 011 a la función
// `Evaluar` que `packages/db` recibe inyectada (`packages/db` no importa `packages/domain`): convierte la compra al
// `FilaEvaluable` del dominio y los hallazgos (con `Money`) a JSON con los montos como cadenas, la forma que se guarda en
// `compra_hallazgo` y que lee el backend.
//
// Una compra que las reglas no aceptan (p. ej. una DUA con número de 12 dígitos) NO tumba la descarga: `evaluar` devuelve
// `[]` y la fila queda sin hallazgo (D-4). Nada de lo evaluado se registra: el error se descarta sin mensaje.
import {
  DICCIONARIO_GLOSAS_BASE,
  MontosComprobante,
  evaluarReglas,
  type ContextoReglas,
  type DocProveedor,
  type Hallazgo,
  type Sugerencia,
} from "@contapp/domain";
import type {
  CompraLeida,
  EvaluarCompra as Evaluar,
  HallazgoCompra as HallazgoNuevo,
} from "@contapp/db";

const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Z-]{1,15}$/;
const ESPACIOS = /\s/g;
const MINUSCULA_ASCII = /[a-z]/g;

const enMayusculas = (s: string): string =>
  s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());

/**
 * Los proveedores del historial en la gramática de `DocProveedor`. `evaluarReglas` rechaza TODO el contexto si uno solo no
 * la cumple, así que uno fuera de gramática (guardado antes, con otro formato) se omite en vez de dejar a todo el periodo
 * sin hallazgos.
 */
export function proveedoresValidos(
  conocidos: readonly { tipo: string; numero: string }[],
): DocProveedor[] {
  const vistos = new Set<string>();
  const salida: DocProveedor[] = [];
  for (const c of conocidos) {
    const numero = enMayusculas(c.numero.replace(ESPACIOS, ""));
    if (!TIPO_DOC.test(c.tipo) || !NUMERO_DOC.test(numero)) continue;
    const clave = `${c.tipo}:${numero}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ tipo: c.tipo, numero });
  }
  return salida;
}

function sugerenciaJson(s: Sugerencia | null): unknown {
  if (s === null) return null;
  switch (s.tipo) {
    case "mover":
      return {
        tipo: "mover",
        origen: s.origen,
        destino: s.destino,
        monto: s.monto.toString(),
      };
    case "separar":
      return {
        tipo: "separar",
        columnaBi: s.columnaBi,
        min: s.min.toString(),
        max: s.max.toString(),
        estimado: s.estimado.toString(),
        exacto: s.exacto === null ? null : s.exacto.toString(),
      };
    case "ajustar":
      return {
        tipo: "ajustar",
        valores: Object.fromEntries(
          Object.entries(s.valores).map(([k, v]) => [k, v.toString()]),
        ),
      };
    case "clasificar":
      return { tipo: "clasificar" };
    case "excluir":
      return { tipo: "excluir", palabra: s.palabra, categoria: s.categoria };
  }
}

export function hallazgoAJson(h: Hallazgo): HallazgoNuevo {
  return {
    regla: h.regla,
    sugerencia: sugerenciaJson(h.sugerencia),
    lecturas: Object.fromEntries(
      Object.entries(h.lecturas).map(([k, v]) => [k, v.toString()]),
    ),
    requiereConfirmacion: h.requiereConfirmacion,
  };
}

/**
 * `Evaluar` sobre un único entorno (el historial de proveedores del cliente y el diccionario base) para todas las compras
 * de la descarga. Una fila por llamada. Se guarda UN hallazgo por regla y versión (la tabla lo exige): si una regla marca
 * varios destinos de la misma compra queda el primero, en el orden del dominio (DG, DGNG, DNG).
 */
export function crearEvaluarCompras(
  proveedoresConocidos: readonly { tipo: string; numero: string }[],
): Evaluar {
  const contexto: ContextoReglas = {
    proveedoresConocidos: proveedoresValidos(proveedoresConocidos),
    proveedoresIsc: [],
    diccionario: DICCIONARIO_GLOSAS_BASE,
  };
  return (c: CompraLeida): HallazgoNuevo[] => {
    try {
      const resultado = evaluarReglas(
        [
          {
            id: "fila",
            proveedor: { tipo: c.docTipo, numero: c.docNumero },
            comprobante: { tipo: c.tipoDoc, serie: c.serie, numero: c.numero },
            montos: MontosComprobante.desde(c.moneda, c.montos),
          },
        ],
        contexto,
      );
      const porRegla = new Map<string, HallazgoNuevo>();
      for (const h of resultado.hallazgos)
        if (!porRegla.has(h.regla)) porRegla.set(h.regla, hallazgoAJson(h));
      return [...porRegla.values()];
    } catch {
      return [];
    }
  };
}
