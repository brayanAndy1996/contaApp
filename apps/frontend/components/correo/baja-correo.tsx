"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { darDeBajaCorreo, MENSAJES_CORREO as M, TOKEN_BAJA_FORMA } from "../../lib/correo";
import { Alert, Button, Card, enlace } from "../ui";
import { cn } from "../../lib/utils";

// Baja con un clic desde el correo (spec 028, R-7, R-8, D-4, U-18). Al cargar, la página NO hace ninguna petición: lee `t`,
// lo guarda en memoria y lo borra de la barra. Solo el botón llama a la API, una vez, y el resultado es siempre el mismo
// texto (sin oráculo de token válido). El token nunca se muestra, ni va en una URL, cabecera ni consola.

const ENLACE = cn(enlace, "text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center");

export function BajaCorreo() {
  const token = useRef<string | null>(null);
  const ocupado = useRef(false);
  const [enviando, setEnviando] = useState(false);
  const [listo, setListo] = useState(false);

  useEffect(() => {
    // Con el doble montaje de desarrollo la segunda lectura ya no ve `t`: no se pisa el token guardado.
    const t = new URLSearchParams(window.location.search).get("t");
    if (t !== null && TOKEN_BAJA_FORMA.test(t)) token.current = t;
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function darseDeBaja() {
    if (ocupado.current) return;
    ocupado.current = true;
    setEnviando(true);
    const valor = token.current;
    token.current = null;
    if (valor) await darDeBajaCorreo(valor);
    setEnviando(false);
    setListo(true);
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          {M.bajaTitulo}
        </h1>
        {listo ? (
          <>
            <Alert tono="ok">{M.bajaListo}</Alert>
            <Link href="/cuenta/correo" className={ENLACE}>
              {M.bajaEnlaceCuenta}
            </Link>
          </>
        ) : (
          <>
            <p className="m-0 text-tinta-media">{M.bajaPregunta}</p>
            <Button className="h-11" disabled={enviando} onClick={darseDeBaja}>
              {M.bajaBoton}
            </Button>
          </>
        )}
      </Card>
    </main>
  );
}
