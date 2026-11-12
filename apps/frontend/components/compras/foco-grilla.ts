// Marca de foco pendiente de la grilla de compras (spec 018, T11d).
//
// El foco se pone en un efecto tras renderizar. La marca dice a qué celda hay que llevarlo: una celda concreta
// (Tab, flechas: la celda destino aún no es la activa del render en curso) o «la activa» (Esc, cierre de fila: la
// celda activa no cambia). Un efecto de un render ANTERIOR (efectos pasivos aún sin ejecutar cuando se pulsa Tab
// pegado a la última tecla) corre con la celda activa vieja: si consumiera una marca con otro destino, enfocaría el
// campo viejo, apagaría la marca y el render nuevo lo desmontaría, dejando el foco en `body`. Por eso solo se
// consume cuando la celda activa del efecto es la pedida.

export interface CeldaFoco {
  r: number;
  c: number;
}

/** Celda a la que llevar el foco, `"activa"` (la que sea la activa) o `null` si no hay nada pendiente. */
export type MarcaFoco = CeldaFoco | "activa" | null;

/** Si el efecto de este render debe enfocar y consumir la marca. */
export function debeEnfocar(marca: MarcaFoco, activa: CeldaFoco): boolean {
  if (marca === null) return false;
  if (marca === "activa") return true;
  return marca.r === activa.r && marca.c === activa.c;
}
