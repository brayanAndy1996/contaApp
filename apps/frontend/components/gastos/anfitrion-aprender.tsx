"use client";

import type { FilaCompraVista } from "@contapp/shared";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { ContextoCompras } from "../../lib/compras";
import { AprenderPalabras } from "./aprender-palabras";

// Anfitrión de «Aprender estas palabras» (spec 027, T13a, CA-9, R-7). Al excluir desde el menú de una fila de la grilla, la
// compra sale de la vista «Con IGV» y su fila (con `AccionesFilaCompras`, `ExcluirCompra` y lo que lleve dentro) se
// desmonta: el diálogo no puede vivir ahí. La pantalla de compras monta este anfitrión por encima de la grilla y de la
// lupa; `ExcluirCompra` le delega el diálogo (`useOfrecerAprender`) y él lo mantiene hasta que se cierra. Sin anfitrión
// (otras pantallas y las pruebas de `ExcluirCompra`) el diálogo sigue dentro de `ExcluirCompra`, como antes.

export interface OfertaAprender {
  contexto: ContextoCompras;
  fila: Pick<FilaCompraVista, "id">;
  /** Se llama al cerrarse el diálogo (o de inmediato si no hay nada que ofrecer). */
  alCerrar: () => void;
}

type Ofrecer = (oferta: OfertaAprender) => void;

const Anfitrion = createContext<Ofrecer | null>(null);

/** `null` fuera de un `AnfitrionAprender`: quien excluye muestra el diálogo por su cuenta. */
export function useOfrecerAprender(): Ofrecer | null {
  return useContext(Anfitrion);
}

export function AnfitrionAprender({ children }: { children: ReactNode }) {
  const [oferta, setOferta] = useState<(OfertaAprender & { n: number }) | null>(null);
  const ofrecer = useCallback<Ofrecer>((nueva) => setOferta((previa) => ({ ...nueva, n: (previa?.n ?? 0) + 1 })), []);

  return (
    <Anfitrion.Provider value={ofrecer}>
      {children}
      {oferta !== null && (
        <AprenderPalabras
          key={oferta.n}
          contexto={oferta.contexto}
          fila={oferta.fila}
          alCerrar={() => {
            setOferta(null);
            oferta.alCerrar();
          }}
        />
      )}
    </Anfitrion.Provider>
  );
}
