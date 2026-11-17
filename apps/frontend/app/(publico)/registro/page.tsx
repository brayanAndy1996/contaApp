"use client";

import Link from "next/link";
import { registroSolicitudSchema } from "@contapp/shared";
import { useState, type FormEvent } from "react";
import { MENSAJES } from "../../../lib/acceso";
import { api } from "../../../lib/api";
import { MENSAJES_REGISTRO } from "../../../lib/registro";
import {
  Alert,
  Button,
  Card,
  Input,
  Label,
  enlace,
} from "../../../components/ui";
import { cn } from "../../../lib/utils";

const ENLACE = cn(
  enlace,
  "text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center",
);

// Registro público de un estudio (spec 006, D3, CA-3, CA-4, CA-10). Pide nombre del estudio, RUC
// opcional, nombre y correo del Dueño; no pide contraseña (se fija al confirmar el correo). La respuesta
// es la misma exista o no una cuenta con ese correo, así que la pantalla no distingue casos.

export default function Registro() {
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [errorRuc, setErrorRuc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (enviando) return;
    const campos = new FormData(evento.currentTarget);
    const leer = (nombre: string) => String(campos.get(nombre) ?? "").trim();
    // El RUC solo viaja si se escribió: el esquema de shared no admite cadena vacía.
    const ruc = leer("ruc");
    const entrada = {
      estudio: leer("estudio"),
      ...(ruc ? { ruc } : {}),
      nombre: leer("nombre"),
      correo: leer("correo"),
    };

    setError(null);
    setErrorRuc(null);
    const valida = registroSolicitudSchema.safeParse(entrada);
    if (!valida.success) {
      const problemas = valida.error.issues;
      if (problemas.some((p) => p.path[0] === "ruc")) {
        setErrorRuc(MENSAJES_REGISTRO.rucInvalido);
      }
      if (problemas.some((p) => p.path[0] !== "ruc")) {
        setError(MENSAJES_REGISTRO.solicitudInvalida);
      }
      return;
    }

    setEnviando(true);
    try {
      const r = await api("/registro", {
        method: "POST",
        body: valida.data,
        sinSesion: true,
      });
      if (r.ok) setEnviado(true);
      else if (r.status === 429) setError(MENSAJES_REGISTRO.demasiadosIntentos);
      else if (r.status === 400) setError(MENSAJES_REGISTRO.solicitudInvalida);
      else setError(MENSAJES.errorGeneral);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          Crear estudio en ContApp
        </h1>
        {enviado ? (
          <>
            <Alert tono="ok">{MENSAJES_REGISTRO.revisaCorreo}</Alert>
            <p className="text-sm">{MENSAJES_REGISTRO.enlaceVence}</p>
          </>
        ) : (
          <form onSubmit={enviar} className="flex flex-col gap-4">
            <Label>
              Nombre del estudio
              <Input
                name="estudio"
                type="text"
                required
                autoComplete="organization"
                className="max-lg:h-11"
              />
            </Label>
            <Label>
              RUC del estudio (opcional)
              <Input
                name="ruc"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={errorRuc ? true : undefined}
                className="max-lg:h-11"
              />
            </Label>
            {errorRuc && <p className="text-sm text-error">{errorRuc}</p>}
            <Label>
              Tu nombre
              <Input
                name="nombre"
                type="text"
                required
                autoComplete="name"
                className="max-lg:h-11"
              />
            </Label>
            <Label>
              Correo
              <Input
                name="correo"
                type="email"
                required
                autoComplete="email"
                className="max-lg:h-11"
              />
            </Label>
            {error && <Alert tono="error">{error}</Alert>}
            <Button type="submit" disabled={enviando} className="max-lg:h-11">
              Crear estudio
            </Button>
          </form>
        )}
        <Link href="/login" className={ENLACE}>
          Ya tengo cuenta
        </Link>
      </Card>
    </main>
  );
}
