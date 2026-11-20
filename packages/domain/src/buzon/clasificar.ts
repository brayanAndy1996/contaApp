// Spec 023 (D-7, CA-5, P-3): clasificación de un mensaje del buzón SOL. El código de tipo gana
// sobre el asunto; una palabra débil o una abreviatura de una palabra clave ("Coact.", "Res. Det.") sin patrón completo
// da crítico con motivo `duda`.
import {
  CATALOGO_BUZON,
  EXCEPCIONES_ABREVIATURAS,
  EXCEPCIONES_DEBILES,
  LARGO_MINIMO_ABREVIATURA,
  PATRONES_ASUNTO,
  type CategoriaBuzon,
  type CategoriaCritica,
  type MotivoCritico,
} from "./catalogo";
import { normalizarAsunto } from "./normalizar";

export interface EntradaClasificacion {
  readonly codigoTipo: string | null;
  readonly asunto: string;
}

export interface Clasificacion {
  readonly categoria: CategoriaBuzon;
  readonly critico: boolean;
  /** `null` solo cuando no es crítico. */
  readonly motivo: MotivoCritico | null;
  readonly versionCatalogo: number;
}

function critico(
  categoria: CategoriaCritica,
  motivo: MotivoCritico,
): Clasificacion {
  return {
    categoria,
    critico: true,
    motivo,
    versionCatalogo: CATALOGO_BUZON.version,
  };
}

function porCodigo(codigoTipo: string | null): CategoriaCritica | null {
  if (codigoTipo === null) return null;
  const codigo = codigoTipo.trim().toUpperCase();
  if (codigo.length === 0) return null;
  for (const c of CATALOGO_BUZON.categorias) {
    if (c.codigosTipo.includes(codigo)) return c.categoria;
  }
  return null;
}

export function clasificarMensaje(
  entrada: EntradaClasificacion,
): Clasificacion {
  const categoriaCodigo = porCodigo(entrada.codigoTipo);
  if (categoriaCodigo !== null) return critico(categoriaCodigo, "codigo");

  const normalizado = normalizarAsunto(entrada.asunto);
  const palabras = new Set(normalizado.split(" "));
  const compacto = normalizado.split(" ").join("");

  for (const p of PATRONES_ASUNTO) {
    if (
      p.frases.some((f) => compacto.includes(f)) ||
      p.siglas.some((s) => palabras.has(s))
    ) {
      return critico(p.categoria, "asunto");
    }
  }

  let sinExcepciones = compacto;
  for (const e of EXCEPCIONES_DEBILES) {
    sinExcepciones = sinExcepciones.split(e).join(" ");
  }
  for (const p of PATRONES_ASUNTO) {
    if (p.debiles.some((d) => sinExcepciones.includes(d))) {
      return critico(p.categoria, "duda");
    }
  }

  // H-023-2-11: abreviaturas ("cob coact", "req fisc", "res det"): una palabra que es el comienzo de una palabra clave.
  const abreviaturas = [...palabras].filter(
    (w) =>
      w.length >= LARGO_MINIMO_ABREVIATURA &&
      !EXCEPCIONES_ABREVIATURAS.includes(w),
  );
  for (const p of PATRONES_ASUNTO) {
    if (
      p.abreviables.some((clave) =>
        abreviaturas.some((w) => clave.startsWith(w)),
      )
    ) {
      return critico(p.categoria, "duda");
    }
  }

  return {
    categoria: "otro",
    critico: false,
    motivo: null,
    versionCatalogo: CATALOGO_BUZON.version,
  };
}
