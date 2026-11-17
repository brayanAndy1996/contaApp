"use client";

import { useState, type FormEvent } from "react";
import { api } from "../../../../lib/api";
import { obtenerSesion, reiniciarSesion } from "../../../../lib/sesion";
import { Alert, Button, Card, Input, Label } from "../../../../components/ui";

const ACTUALIZADA = "Tu contraseña fue actualizada.";
const ACTUAL_INCORRECTA = "La contraseña actual no es correcta.";
const LONGITUD = "La contraseña debe tener entre 12 y 128 caracteres.";
const COMUN = "Esa contraseña es demasiado común. Elige otra.";
const ERROR_GENERAL = "No se pudo cambiar la contraseña. Inténtalo de nuevo.";

function mensajeDeError(
  status: number,
  datos: { codigo?: string; motivo?: string } | null,
): string {
  // El 401 de este formulario es "la actual es incorrecta"; el de sesión caducada ya lo maneja api().
  if (status === 401) return ACTUAL_INCORRECTA;
  if (status === 400 && datos?.codigo === "contrasena_invalida") {
    return datos.motivo === "comun" ? COMUN : LONGITUD;
  }
  return ERROR_GENERAL;
}

export default function CambioContrasena() {
  const [mensaje, setMensaje] = useState<{
    texto: string;
    error: boolean;
  } | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function cambiar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    // Campos sin control: así la contraseña no queda en el DOM (atributo value) ni en el estado.
    const formulario = evento.currentTarget;
    const datosForm = new FormData(formulario);
    const actual = String(datosForm.get("actual") ?? "");
    const nueva = String(datosForm.get("nueva") ?? "");
    setEnviando(true);
    setMensaje(null);
    try {
      const r = await api<{ codigo?: string; motivo?: string }>(
        "/auth/contrasena",
        { method: "POST", body: { actual, nueva }, manejar401: false },
      );
      if (r.ok) {
        // La cookie y el token CSRF rotaron: se vuelve a leer la sesión.
        reiniciarSesion();
        await obtenerSesion();
        formulario.reset();
        setMensaje({ texto: ACTUALIZADA, error: false });
      } else if (r.status !== 401 || r.datos?.codigo !== "sesion_invalida") {
        setMensaje({ texto: mensajeDeError(r.status, r.datos), error: true });
      }
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
          Cambiar contraseña
        </h1>
        <form onSubmit={cambiar} className="flex flex-col gap-4">
          <Label>
            Contraseña actual
            <Input
              type="password"
              name="actual"
              autoComplete="current-password"
              required
              className="max-lg:h-11"
            />
          </Label>
          <Label>
            Nueva contraseña
            <Input
              type="password"
              name="nueva"
              autoComplete="new-password"
              required
              className="max-lg:h-11"
            />
          </Label>
          {mensaje && (
            <Alert tono={mensaje.error ? "error" : "ok"}>{mensaje.texto}</Alert>
          )}
          <Button type="submit" disabled={enviando} className="max-lg:h-11">
            Cambiar contraseña
          </Button>
        </form>
      </Card>
    </main>
  );
}
