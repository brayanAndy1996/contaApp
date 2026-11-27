"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { verificarSegundoFactorSchema } from "@contapp/shared";
import { api } from "../../lib/api";
import { MENSAJES_SEGURIDAD, codigoDe } from "../../lib/seguridad";
import { RUTA_SEGURIDAD } from "../../lib/sesion";
import { Alert, Button, Input, Label, enlace } from "../ui";
import { cn } from "../../lib/utils";

const ENLACE = cn(
  enlace,
  "text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center",
);

const ERROR_GENERAL = "No se pudo iniciar sesión. Inténtalo de nuevo.";

type ModoCodigo = "totp" | "recuperacion";

export interface RespuestaVerificacion {
  estudioActivo?: { id: string; nombre: string } | null;
  requiereEstudio?: boolean;
}

interface PropiedadesPasoCodigo {
  /** CSRF de la sesión `pendiente` que trae el login; solo vive en el estado de quien lo recibió. */
  csrf: string;
  /**
   * Verificación aceptada (200). Si devuelve una promesa, el botón sigue ocupado hasta que termine; un
   * rechazo se muestra como error general.
   */
  alVerificar: (datos: RespuestaVerificacion | null) => void | Promise<void>;
  /** 401 `sesion_invalida`: la sesión pendiente caducó; quien llama vuelve a pedir la contraseña. */
  alCaducar: () => void;
}

/**
 * Paso del código de verificación (spec 029): código de la aplicación o de recuperación. Lo comparten
 * /login, /invitacion y /registro/confirmar. Sesión `pendiente`: `sinSesion` + `csrf` del login (sin
 * GET /auth/sesion ni X-Estudio); un 401 `codigo_invalido` es un dato erróneo y llega a la pantalla sin
 * reintento ni /login. El código no se guarda fuera de este estado.
 */
export function PasoCodigo({ csrf, alVerificar, alCaducar }: PropiedadesPasoCodigo) {
  const [modo, setModo] = useState<ModoCodigo>("totp");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const recuperacion = modo === "recuperacion";

  function cambiarModo(nuevo: ModoCodigo) {
    setModo(nuevo);
    setError(null);
  }

  async function verificar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    // Campo sin estado controlado: el código nunca queda en el DOM (atributo `value`) ni en el estado.
    const codigo = String(
      new FormData(evento.currentTarget).get("codigo") ?? "",
    );
    const cuerpo =
      modo === "totp"
        ? { codigo: codigo.trim() }
        : { codigoRecuperacion: codigo.trim().toUpperCase() };
    setError(null);
    if (!verificarSegundoFactorSchema.safeParse(cuerpo).success) {
      setError(MENSAJES_SEGURIDAD.codigoIncorrecto);
      return;
    }
    setEnviando(true);
    try {
      const r = await api<RespuestaVerificacion>("/auth/2fa/verificar", {
        method: "POST",
        body: cuerpo,
        sinSesion: true,
        csrf,
      });
      if (r.ok) {
        await alVerificar(r.datos);
        return;
      }
      if (r.status === 401 && codigoDe(r.datos) === "sesion_invalida") {
        alCaducar();
        return;
      }
      setError(
        r.status === 401
          ? MENSAJES_SEGURIDAD.codigoIncorrecto
          : r.status === 429
            ? MENSAJES_SEGURIDAD.demasiadosIntentos
            : ERROR_GENERAL,
      );
    } catch {
      setError(ERROR_GENERAL);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form onSubmit={verificar} className="flex flex-col gap-4">
      <Label>
        {recuperacion ? "Código de recuperación" : "Código de verificación"}
        <Input
          key={modo}
          name="codigo"
          type="text"
          required
          autoFocus
          {...(recuperacion
            ? {
                autoComplete: "off",
                autoCapitalize: "characters",
                spellCheck: false,
                placeholder: "XXXX-XXXX-XXXX",
              }
            : {
                autoComplete: "one-time-code",
                inputMode: "numeric" as const,
                placeholder: "000000",
              })}
          className="max-lg:h-11"
        />
      </Label>
      {error && <Alert tono="error">{error}</Alert>}
      <Button type="submit" disabled={enviando} className="max-lg:h-11">
        Verificar
      </Button>
      <button
        type="button"
        onClick={() => cambiarModo(recuperacion ? "totp" : "recuperacion")}
        className={cn(ENLACE, "self-start text-left")}
      >
        {recuperacion
          ? "Usar el código de mi aplicación"
          : "Usar un código de recuperación"}
      </button>
    </form>
  );
}

/** Aviso cuando el rol exige el segundo factor y la sesión aún no lo tiene: solo se puede enrolar. */
export function AvisoFactorExigido() {
  return (
    <>
      <Alert tono="error">{MENSAJES_SEGURIDAD.exigidoAviso}</Alert>
      <Link href={RUTA_SEGURIDAD} className={ENLACE}>
        Ir a Seguridad
      </Link>
    </>
  );
}
