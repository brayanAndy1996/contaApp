"use client";

import type { SesionCuenta } from "@contapp/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  MENSAJES_SEGURIDAD as M,
  fechaHora,
  sesionesDeRespuesta,
} from "../../lib/seguridad";
import { Alert, Badge, Button, Card, CardDescription, CardTitle } from "../ui";

/** Sesiones activas de la cuenta (RF-014): revocar una o todas las demás. */
export function SesionesCuenta() {
  const [sesiones, setSesiones] = useState<SesionCuenta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await api<unknown>("/auth/sesiones");
      if (r.ok) {
        setSesiones(sesionesDeRespuesta(r.datos));
        return true;
      }
      if (r.status !== 401 && r.status !== 403) setError(M.errorSesiones);
    } catch {
      setError(M.errorSesiones);
    }
    return false;
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function revocar(ruta: string) {
    setError(null);
    try {
      const r = await api(ruta, { method: "POST" });
      if (!r.ok) {
        if (r.status !== 401) setError(M.errorRevocar);
        return;
      }
      await cargar();
    } catch {
      setError(M.errorRevocar);
    }
  }

  const hayOtras = sesiones?.some((s) => !s.actual) ?? false;

  return (
    <Card>
      <div className="flex flex-col gap-1">
        <CardTitle>Sesiones activas</CardTitle>
        <CardDescription>
          Dispositivos con la sesión abierta en tu cuenta. Revoca los que no
          reconozcas.
        </CardDescription>
      </div>
      {error && <Alert tono="error">{error}</Alert>}
      {sesiones && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {sesiones.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-linea px-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-tinta">
                    {s.dispositivo}
                  </span>
                  {s.actual && <Badge tono="info">Esta sesión</Badge>}
                </div>
                {s.ip && (
                  <span className="text-xs text-tinta-suave">{s.ip}</span>
                )}
                <span className="text-xs text-tinta-suave">
                  Último uso: {fechaHora(s.ultimoUso)}
                </span>
              </div>
              {!s.actual && (
                <Button
                  type="button"
                  variant="secundario"
                  size="sm"
                  aria-label={`Revocar la sesión de ${s.dispositivo}`}
                  onClick={() => void revocar(`/auth/sesiones/${s.id}/revocar`)}
                  className="max-lg:h-11"
                >
                  Revocar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {hayOtras && (
        <Button
          type="button"
          variant="secundario"
          onClick={() => void revocar("/auth/sesiones/revocar-otras")}
          className="self-start max-lg:h-11"
        >
          Revocar las demás sesiones
        </Button>
      )}
    </Card>
  );
}
