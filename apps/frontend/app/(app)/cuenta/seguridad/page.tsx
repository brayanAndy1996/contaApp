"use client";

import { useCallback, useEffect, useState } from "react";
import { CodigosRecuperacion } from "../../../../components/seguridad/codigos-recuperacion";
import { SesionesCuenta } from "../../../../components/seguridad/sesiones-cuenta";
import {
  TotpCuenta,
  type EstadoTotp,
} from "../../../../components/seguridad/totp-cuenta";
import { EncabezadoPagina } from "../../../../components/ui";
import {
  EVENTO_SESION_ACTUALIZADA,
  obtenerSesion,
  reiniciarSesion,
  type Sesion,
} from "../../../../lib/sesion";

const estadoDe = (s: Sesion): EstadoTotp => ({
  totpActivo: s.totpActivo === true,
  factorExigido: s.factorExigido === true,
});

// «Mi cuenta → Seguridad» (spec 029): verificación en dos pasos, códigos de recuperación y sesiones activas.
export default function Seguridad() {
  const [estado, setEstado] = useState<EstadoTotp | null>(null);
  // Los códigos de recuperación solo viven aquí, en memoria: no se persisten y se quitan con «Ya guardé…».
  const [codigos, setCodigos] = useState<string[] | null>(null);

  useEffect(() => {
    let vigente = true;
    obtenerSesion()
      .then((s) => {
        if (vigente && s) setEstado(estadoDe(s));
      })
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, []);

  // El token rota al activar o desactivar: se vuelve a leer la sesión y se avisa al marco (menú, bloqueo).
  const releer = useCallback(async () => {
    reiniciarSesion();
    const s = await obtenerSesion();
    if (s) setEstado(estadoDe(s));
    window.dispatchEvent(new Event(EVENTO_SESION_ACTUALIZADA));
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:px-6">
      <EncabezadoPagina
        titulo="Seguridad"
        descripcion="Protege tu cuenta y revisa dónde tienes la sesión abierta."
      />
      {codigos && (
        <CodigosRecuperacion
          codigos={codigos}
          alGuardar={() => setCodigos(null)}
        />
      )}
      {estado && (
        <>
          <TotpCuenta
            estado={estado}
            alCambiar={releer}
            alMostrarCodigos={setCodigos}
          />
          <SesionesCuenta key={String(estado.totpActivo)} />
        </>
      )}
    </main>
  );
}
