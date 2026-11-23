"use client";

import type { FilaCompraVista } from "@contapp/shared";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
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
  // La oferta vigente vive también en un ref: al llegar otra mientras la primera aún carga, la reemplazada avisa UNA vez
  // (H-027-2-9; nadie queda esperando su `alCerrar`) y su respuesta tardía no abre diálogo (el `key` desmonta su `AprenderPalabras`).
  const vigente = useRef<{ n: number; alCerrar: () => void } | null>(null);
  const contador = useRef(0);
  const ofrecer = useCallback<Ofrecer>((nueva) => {
    const reemplazada = vigente.current;
    contador.current += 1;
    const n = contador.current;
    vigente.current = { n, alCerrar: nueva.alCerrar };
    setOferta({ ...nueva, n });
    reemplazada?.alCerrar();
  }, []);

  return (
    <Anfitrion.Provider value={ofrecer}>
      {children}
      {oferta !== null && (
        <AprenderPalabras
          key={oferta.n}
          contexto={oferta.contexto}
          fila={oferta.fila}
          alCerrar={() => {
            if (vigente.current?.n !== oferta.n) return;
            vigente.current = null;
            setOferta(null);
            oferta.alCerrar();
          }}
        />
      )}
    </Anfitrion.Provider>
  );
}
