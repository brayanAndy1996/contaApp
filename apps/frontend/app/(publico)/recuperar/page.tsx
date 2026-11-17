"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { api } from "../../../lib/api";
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

// El mismo mensaje exista o no el correo (CA-8); nunca se repite el correo escrito.
const ENVIADO =
  "Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.";
const ERROR_GENERAL = "No se pudo enviar la solicitud. Inténtalo de nuevo.";

export default function Recuperar() {
  const [correo, setCorreo] = useState("");
  const [mensaje, setMensaje] = useState<{
    texto: string;
    error: boolean;
  } | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function pedir(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setEnviando(true);
    setMensaje(null);
    try {
      const r = await api("/auth/recuperar", {
        method: "POST",
        body: { correo },
        sinSesion: true,
      });
      setMensaje(
        r.ok
          ? { texto: ENVIADO, error: false }
          : { texto: ERROR_GENERAL, error: true },
      );
    } catch {
      setMensaje({ texto: ERROR_GENERAL, error: true });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="m-0 font-titulo text-[28px] font-extrabold leading-tight tracking-tight text-tinta">
          Recuperar contraseña
        </h1>
        <form onSubmit={pedir} className="flex flex-col gap-4">
          <Label>
            Correo
            <Input
              type="email"
              autoComplete="username"
              required
              value={correo}
              onChange={(e) => setCorreo(e.target.value)}
              className="max-lg:h-11"
            />
          </Label>
          {mensaje && (
            <Alert tono={mensaje.error ? "error" : "info"}>
              {mensaje.texto}
            </Alert>
          )}
          <Button type="submit" disabled={enviando} className="max-lg:h-11">
            Enviar enlace
          </Button>
          <Link href="/login" className={ENLACE}>
            Volver a iniciar sesión
          </Link>
        </form>
      </Card>
    </main>
  );
}
