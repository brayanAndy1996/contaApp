"use client";

import { useEffect, useRef, useState } from "react";
import {
  cuerpoPreferencias,
  guardarPreferenciasCorreo,
  leerPreferenciasCorreo,
  MENSAJES_CORREO as M,
  type PreferenciasCorreoVista,
} from "../../lib/correo";
import { Alert, Button, Card } from "../ui";

// Invitación única al resumen diario (spec 028, R-15, U-8). Se muestra mientras `invitacionResumen` sea true: «Activar
// resumen» y «Ahora no» guardan el resto de preferencias como están y apagan la invitación en el servidor.

interface TarjetaProps {
  enviando: boolean;
  error: boolean;
  alElegir: (activar: boolean) => void;
}

/** Tarjeta de la invitación, sin datos propios: la usan `InvitacionResumen` y `PreferenciasCorreo`. */
export function TarjetaInvitacionResumen({ enviando, error, alElegir }: TarjetaProps) {
  return (
    <Card data-slot="invitacion-resumen" className="gap-3 border-primario/30 bg-primario-suave">
      <p className="m-0 font-titulo text-base font-bold text-tinta">{M.invitacion}</p>
      {error && <Alert tono="error">{M.errorInvitacion}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button className="h-11" disabled={enviando} onClick={() => alElegir(true)}>
          {M.activarResumen}
        </Button>
        <Button variant="secundario" className="h-11" disabled={enviando} onClick={() => alElegir(false)}>
          {M.ahoraNo}
        </Button>
      </div>
    </Card>
  );
}

export function InvitacionResumen() {
  const [vista, setVista] = useState<PreferenciasCorreoVista | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(false);
  const ocupado = useRef(false);

  useEffect(() => {
    let vigente = true;
    leerPreferenciasCorreo().then((v) => {
      if (vigente) setVista(v);
    });
    return () => {
      vigente = false;
    };
  }, []);

  async function elegir(activar: boolean) {
    if (!vista || ocupado.current) return;
    ocupado.current = true;
    setEnviando(true);
    setError(false);
    const r = await guardarPreferenciasCorreo(cuerpoPreferencias(vista, vista.todosDisponible, { resumen: activar }));
    if (r.tipo === "ok") setVista(null);
    else setError(true);
    ocupado.current = false;
    setEnviando(false);
  }

  if (!vista?.invitacionResumen) return null;
  return <TarjetaInvitacionResumen enviando={enviando} error={error} alElegir={elegir} />;
}
