import type {
  CuadreCompra,
  DetalleCompra,
  EstadoPeriodoCompras,
  FilaCompraVista,
  HallazgoVista,
  ListadoCompras,
  ResumenComprasVista,
  VersionCompraVista,
} from "@contapp/shared";
import { MENSAJES_COMPRAS } from "../lib/compras";
import { iguales, sumar } from "../lib/montos-compras";
import { rutaSesion, yoDe } from "./acceso";
import { clienteDe } from "./clientes";
import {
  instalarFetchFalso,
  type FetchFalso,
  type Llamada,
  type Manejador,
} from "./soporte";

// Soporte de las pruebas de la pantalla de compras (spec 015, T2): las 5 compras de
// `fixtures/sire/20700000002-compras-202610.json` con los hallazgos que 014 les calcula, un generador de
// 5.000 filas y un `fetch` simulado del contrato de 014 (`/clientes/:clienteId/periodos/:periodo/compras`).
// Los textos visibles salen de `MENSAJES_COMPRAS` (una sola fuente, plan 015). Solo datos de prueba; los
// montos son SIEMPRE cadenas y el total sale de `sumar`, nunca de aritmética con `number`.

export { MENSAJES_COMPRAS };

export const CLIENTE_ID = "c-1";
export const PERIODO = "202610";
export const BASE = `/api/clientes/${CLIENTE_ID}/periodos/${PERIODO}/compras`;

/** Permisos de prueba. `lectura` y `sinAprobar` sirven para los casos de solo lectura (D-13). */
export const PERMISOS = {
  todos: ["clientes.ver", "sire.descargar", "sire.clasificar", "sire.aprobar_generar"],
  sinAprobar: ["clientes.ver", "sire.descargar", "sire.clasificar"],
  lectura: ["clientes.ver"],
  soloDescargar: ["clientes.ver", "sire.descargar"],
  sinVer: [] as string[],
} as const;

/** UUID válido y determinista (los esquemas de `shared` exigen `z.uuid()`). */
export function uuidDe(prefijo: number, n: number): string {
  return `${String(prefijo).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Razón social hostil: debe verse como texto, nunca ejecutarse (CA-2). */
export const TEXTO_HOSTIL = `<img src=x onerror=alert(1)>`;

// ---------------------------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------------------------

type Montos = FilaCompraVista["montos"];
type MontosSinTotal = Omit<Montos, "total">;

const CEROS: MontosSinTotal = {
  biDg: "0.00",
  igvDg: "0.00",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "0.00",
  igvDng: "0.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otrosTributos: "0.00",
};

/** Las 10 columnas (por omisión en cero) y su total, que es la suma de ellas. */
export function montosDe(parcial: Partial<MontosSinTotal> = {}): Montos {
  const columnas: MontosSinTotal = { ...CEROS, ...parcial };
  return { ...columnas, total: sumar(Object.values(columnas)) };
}

export function filaDe(parcial: Partial<FilaCompraVista> = {}): FilaCompraVista {
  return {
    id: uuidDe(1, 1),
    origen: "sire",
    tipo: "01",
    serie: "F001",
    numero: "1",
    proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR PRUEBA S.A.C." },
    fecha: "2026-10-01",
    moneda: "PEN",
    tipoCambio: null,
    version: 1,
    montos: montosDe({ biDg: "100.00", igvDg: "18.00" }),
    excluida: false,
    motivo: null,
    clasificada: true,
    proveedorNuevo: false,
    hallazgos: [],
    ...parcial,
  };
}

const hallazgoIsc: HallazgoVista = {
  regla: "R-ISC",
  destino: "DG",
  explicacion:
    "La base gravada tiene IGV en cero y el proveedor emite ISC: se sugiere mover 770.00 a ISC.",
  sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
  requiereConfirmacion: true,
  dato: null,
  masiva: false,
};

const hallazgoMix: HallazgoVista = {
  regla: "R-MIX",
  destino: "DG",
  explicacion:
    "El IGV no cuadra con 18 % ni 10 % de la base: la base gravada estaría entre 8.92 y 8.97.",
  sugerencia: {
    tipo: "separar",
    columnaBi: "biDg",
    min: "8.92",
    max: "8.97",
    estimado: "8.94",
    exacto: null,
  },
  requiereConfirmacion: true,
  dato: "gravado",
  masiva: false,
};

const hallazgoNuevo: HallazgoVista = {
  regla: "R-NEW",
  destino: null,
  explicacion: "Proveedor nuevo: elige su destino.",
  sugerencia: { tipo: "clasificar" },
  requiereConfirmacion: true,
  dato: "destino",
  masiva: false,
};

const hallazgoGlosa: HallazgoVista = {
  regla: "R-GP",
  destino: null,
  explicacion: "La glosa menciona «zapatillas»: podría ser un gasto personal.",
  sugerencia: { tipo: "excluir", palabra: "zapatillas", categoria: "personal" },
  requiereConfirmacion: true,
  dato: null,
  masiva: false,
};

/** R-ISC: base gravada con IGV en cero de un proveedor que emite ISC (014: «F001-1040»). */
export const C_1040_ISC = filaDe({
  id: uuidDe(1, 1040),
  numero: "1040",
  proveedor: { tipo: "6", numero: "20700000011", razonSocial: "PRUEBA PROVEEDOR ISC S.A.C." },
  fecha: "2026-10-02",
  montos: montosDe({ biDg: "770.00" }),
  hallazgos: [hallazgoIsc],
});

/** R-MIX: IGV que no cuadra; pide el monto gravado (8.97 en las pruebas de 014). */
export const C_2056_MIXTA = filaDe({
  id: uuidDe(1, 2056),
  numero: "2056",
  proveedor: { tipo: "6", numero: "20700000045", razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." },
  fecha: "2026-10-05",
  montos: montosDe({ biDg: "21.48", igvDg: "1.61" }),
  hallazgos: [hallazgoMix],
});

/** Proveedor nuevo con ICBPER; sin clasificar (R-NEW). */
export const C_3064_BOLSAS = filaDe({
  id: uuidDe(1, 3064),
  numero: "3064",
  proveedor: { tipo: "6", numero: "20700000053", razonSocial: "PRUEBA PROVEEDOR BOLSAS S.A.C." },
  fecha: "2026-10-08",
  montos: montosDe({ biDg: "100.00", igvDg: "18.00", icbper: "1.50" }),
  clasificada: false,
  proveedorNuevo: true,
  hallazgos: [hallazgoNuevo],
});

/** En USD con tipo de cambio 3.300. */
export const C_4062_USD = filaDe({
  id: uuidDe(1, 4062),
  numero: "4062",
  proveedor: { tipo: "6", numero: "20700000061", razonSocial: "PRUEBA PROVEEDOR USD S.A.C." },
  fecha: "2026-10-12",
  moneda: "USD",
  tipoCambio: "3.300",
  montos: montosDe({ biDg: "0.15", igvDg: "0.03" }),
});

/** R-GP: la glosa menciona «zapatillas». */
export const C_5070_ZAPATILLAS = filaDe({
  id: uuidDe(1, 5070),
  numero: "5070",
  proveedor: { tipo: "6", numero: "20700000070", razonSocial: "PRUEBA PROVEEDOR CALZADO S.A.C." },
  fecha: "2026-10-14",
  montos: montosDe({ biDg: "150.00", igvDg: "27.00" }),
  hallazgos: [hallazgoGlosa],
});

/** Las 5 compras de 014 en el orden del SIRE. */
export const FILAS_014: FilaCompraVista[] = [
  C_1040_ISC,
  C_2056_MIXTA,
  C_3064_BOLSAS,
  C_4062_USD,
  C_5070_ZAPATILLAS,
];

const PARES_BASE_IGV: readonly [string, string][] = [
  ["100.00", "18.00"],
  ["250.00", "45.00"],
  ["80.50", "14.49"],
  ["1234.56", "222.22"],
  ["15.00", "2.70"],
];

/**
 * `n` compras distintas y deterministas (el comprobante F001-<10000 + i> es único), cada décima con una
 * alerta R-NEW y cada centésima excluida. Para medir la virtualización con 5.000 filas.
 */
export function generarFilas(n: number): FilaCompraVista[] {
  const filas: FilaCompraVista[] = [];
  for (let i = 1; i <= n; i += 1) {
    const [base, igv] = PARES_BASE_IGV[i % PARES_BASE_IGV.length]!;
    filas.push(
      filaDe({
        id: uuidDe(2, i),
        numero: String(10000 + i),
        proveedor: {
          tipo: "6",
          numero: `2080${String(i).padStart(7, "0")}`,
          razonSocial: `PROVEEDOR GENERADO ${i}`,
        },
        fecha: "2026-10-15",
        montos: montosDe({ biDg: base, igvDg: igv }),
        excluida: i % 100 === 0,
        motivo: i % 100 === 0 ? "Gasto personal" : null,
        proveedorNuevo: i % 10 === 0,
        clasificada: i % 10 !== 0,
        hallazgos: i % 10 === 0 ? [hallazgoNuevo] : [],
      }),
    );
  }
  return filas;
}

// ---------------------------------------------------------------------------------------------
// Respuestas de ejemplo
// ---------------------------------------------------------------------------------------------

export const CUADRE_OK: CuadreCompra = { cuadra: true, celdas: [] };

export function listadoDe(
  filas: FilaCompraVista[],
  siguiente: string | null = null,
): ListadoCompras {
  return { filas, siguiente };
}

/** Versión 1 (valor original del SIRE) de una fila. */
export function versionOriginalDe(fila: FilaCompraVista): VersionCompraVista {
  return {
    n: 1,
    accion: fila.origen === "agregada" ? "agregada" : "original",
    operacionId: null,
    usuarioId: null,
    autor: null,
    creadaEn: "2026-10-20T15:00:00.000Z",
    excluida: false,
    motivo: null,
    clasificada: fila.origen === "agregada",
    montos: fila.montos,
  };
}

export function detalleDe(fila: FilaCompraVista): DetalleCompra {
  const original = versionOriginalDe(fila);
  return { original, vigente: fila, versiones: [original], hallazgos: fila.hallazgos };
}

/** Cuerpo de las acciones sobre una fila: la fila nueva y su cuadre. */
export const accionDe = (fila: FilaCompraVista, cuadre: CuadreCompra = CUADRE_OK) => ({
  fila,
  cuadre,
});

/** Resumen del periodo con las filas vivas (no excluidas) sumadas tal cual; sin diferencia. */
export function resumenDe(
  filas: FilaCompraVista[],
  parcial: Partial<ResumenComprasVista> = {},
  estado: EstadoPeriodoCompras = "abierto",
): ResumenComprasVista {
  const vivas = filas.filter((f) => !f.excluida);
  const suma = (lista: FilaCompraVista[]): Montos => {
    const columnas = Object.keys(montosDe()) as (keyof Montos)[];
    const salida = { ...montosDe() };
    for (const c of columnas) salida[c] = sumar(lista.map((f) => f.montos[c]));
    return salida;
  };
  const conIgv = vivas.filter((f) => !iguales(sumar([f.montos.igvDg, f.montos.igvDgng, f.montos.igvDng]), "0.00"));
  const sinIgv = vivas.filter((f) => iguales(sumar([f.montos.igvDg, f.montos.igvDgng, f.montos.igvDng]), "0.00"));
  const original = suma(vivas);
  return {
    estado,
    casilleros: { original, vigente: original, diferencia: montosDe() },
    conIgv: { n: conIgv.length, casilleros: suma(conIgv) },
    sinIgv: { n: sinIgv.length, casilleros: suma(sinIgv) },
    filasSinConvertir: [],
    por: null,
    autor: null,
    en: null,
    ...parcial,
  };
}

// ---------------------------------------------------------------------------------------------
// fetch simulado
// ---------------------------------------------------------------------------------------------

/** Lo que el backend simulado responde; las pruebas lo mutan para simular el avance. */
export interface EstadoCompras {
  filas: FilaCompraVista[];
  /** Si se da, es el cuerpo de `GET …/resumen`; si no, se calcula de `filas`. */
  resumen: ResumenComprasVista | null;
  estado: EstadoPeriodoCompras;
  /** La más reciente primero. */
  propuestas: unknown[];
  /** Por `propuestaId`. */
  diferencias: Record<string, unknown[]>;
  /** Respuesta de `GET /api/trabajos`. */
  trabajos: unknown[];
}

export interface OpcionesCompras {
  permisos?: readonly string[];
  cliente?: Parameters<typeof clienteDe>[0];
  estado?: Partial<EstadoCompras>;
  /**
   * Manejadores propios (ganan sobre los de compras). La clave es `"POST /api/clientes/…/compras/<id>/clasificar"`;
   * con una función recibe la llamada y el `estado` vivo para cambiarlo al responder.
   */
  extra?:
    | Record<string, Manejador>
    | ((estado: EstadoCompras) => Record<string, Manejador>);
}

export interface FetchCompras extends FetchFalso {
  estado: EstadoCompras;
  /** Llamadas a `GET <BASE>` (el listado) con su query. */
  listados(): Llamada[];
}

/** Parámetros de consulta de una llamada o URL (`?limite=1000&vista=con_igv&…`). */
export function consultaDe(url: string): URLSearchParams {
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1));
}

const normalizar = (t: string): string => t.toLowerCase();

/** Aplica al listado los filtros del servidor (`vista`, `alertas`, `proveedorNuevo`, `q`). */
export function filtrarFilas(
  filas: FilaCompraVista[],
  consulta: URLSearchParams,
): FilaCompraVista[] {
  const vista = consulta.get("vista") ?? "con_igv";
  const q = normalizar((consulta.get("q") ?? "").trim());
  return filas.filter((f) => {
    const igv = sumar([f.montos.igvDg, f.montos.igvDgng, f.montos.igvDng]);
    if (vista === "excluidas" ? !f.excluida : f.excluida) return false;
    if (vista === "con_igv" && iguales(igv, "0.00")) return false;
    if (vista === "sin_igv" && !iguales(igv, "0.00")) return false;
    if (consulta.get("alertas") === "true" && f.hallazgos.length === 0) return false;
    if (consulta.get("proveedorNuevo") === "true" && !f.proveedorNuevo) return false;
    if (q !== "") {
      const pajar = normalizar(
        `${f.proveedor.numero} ${f.proveedor.razonSocial ?? ""} ${f.serie}-${f.numero}`,
      );
      if (!pajar.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Instala `fetch`: sesión, permisos, cliente y las lecturas de 014 (listado por cursor con filtros, resumen,
 * propuestas, diferencias, detalle y trabajos). Las escrituras no tienen respuesta por omisión: cada prueba
 * declara las que usa en `extra`, para que una ruta no esperada falle a la vista.
 */
export function instalarFetchCompras(opciones: OpcionesCompras = {}): FetchCompras {
  const estado: EstadoCompras = {
    filas: [...FILAS_014],
    resumen: null,
    estado: "abierto",
    propuestas: [],
    diferencias: {},
    trabajos: [],
    ...opciones.estado,
  };
  const permisos = [...(opciones.permisos ?? PERMISOS.todos)];
  const propias: Record<string, Manejador> =
    typeof opciones.extra === "function"
      ? opciones.extra(estado)
      : (opciones.extra ?? {});

  const fijas: Record<string, Manejador> = {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    [`GET /api/clientes/${CLIENTE_ID}`]: {
      status: 200,
      cuerpo: clienteDe({ id: CLIENTE_ID, ...opciones.cliente }),
    },
    [`GET ${BASE}`]: (llamada) => {
      const consulta = consultaDe(llamada.url);
      const limite = Number(consulta.get("limite") ?? "1000");
      const desde = consulta.has("cursor") ? Number(consulta.get("cursor")) : 0;
      if (!Number.isInteger(desde) || desde < 0 || !Number.isInteger(limite) || limite < 1) {
        return { status: 400, cuerpo: { codigo: "solicitud_invalida" } };
      }
      const todas = filtrarFilas(estado.filas, consulta);
      const hasta = desde + limite;
      return {
        status: 200,
        cuerpo: listadoDe(
          todas.slice(desde, hasta),
          hasta < todas.length ? String(hasta) : null,
        ),
      };
    },
    [`GET ${BASE}/resumen`]: () => ({
      status: 200,
      cuerpo: estado.resumen ?? resumenDe(estado.filas, {}, estado.estado),
    }),
    [`GET ${BASE}/propuestas`]: () => ({ status: 200, cuerpo: estado.propuestas }),
    "GET /api/trabajos": () => ({ status: 200, cuerpo: estado.trabajos }),
    "GET /api/trabajos/resumen": { status: 404, cuerpo: { codigo: "no_encontrado" } },
  };

  // `fetch` simulado resuelve la ruta con `rutas[clave]`: un Proxy permite rutas con id sin enumerarlas
  // (con 5.000 filas serían miles de claves).
  const rutas = new Proxy({} as Record<string, Manejador>, {
    get(_, clave) {
      if (typeof clave !== "string") return undefined;
      if (clave in propias) return propias[clave];
      if (clave in fijas) return fijas[clave];
      const [metodo, ruta = ""] = clave.split(" ");
      if (metodo !== "GET" || !ruta.startsWith(`${BASE}/`)) return undefined;
      const resto = ruta.slice(BASE.length + 1);
      const parteDiferencias = /^propuestas\/([^/]+)\/diferencias$/.exec(resto);
      if (parteDiferencias) {
        const lista = estado.diferencias[parteDiferencias[1]!];
        return lista === undefined
          ? { status: 404, cuerpo: { codigo: "no_encontrada" } }
          : { status: 200, cuerpo: lista };
      }
      if (resto.includes("/")) return undefined;
      const fila = estado.filas.find((f) => f.id === resto);
      return fila === undefined
        ? { status: 404, cuerpo: { codigo: "no_encontrada" } }
        : { status: 200, cuerpo: detalleDe(fila) };
    },
  });

  const base = instalarFetchFalso(rutas);
  return {
    llamadas: base.llamadas,
    de: base.de,
    estado,
    listados: () => base.de(`GET ${BASE}`),
  };
}
