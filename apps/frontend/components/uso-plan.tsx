"use client";

import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { MENSAJES_PLAN, cargarUso, type ResultadoUso } from "../lib/planes";
import { MENSAJES_REGISTRO } from "../lib/registro";
import { Alert, Card } from "./ui";

// Indicador de uso del plan (spec 006, D7, D8, D14, CA-10). Muestra lo que entrega GET /plan/uso: los
// límites los decide el backend. Sumar activos y pendientes es presentación (D7: ambos cuentan). Si la
// petición falla, no pinta nada y la pantalla sigue igual. Con 409 sin_plan (estudio sin suscripción, D14) muestra
// el aviso de sin plan en lugar de la región de uso.

const FORMATO_FECHA: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "America/Lima",
};

function fechaDePrueba(iso: string | null): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return new Date(iso).toLocaleDateString("es-PE", FORMATO_FECHA);
}

/** Barra de uso (decorativa: el texto de arriba lleva la cifra, D5). Solo presentación: el límite lo decide el backend. */
function BarraUso({ usados, limite, alcanzado }: { usados: number; limite: number; alcanzado: boolean }) {
  const ancho = limite > 0 ? Math.min(100, Math.round((usados / limite) * 100)) : 100;
  return (
    <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-neutro-fondo">
      <div
        className={alcanzado ? "h-full rounded-full bg-aviso" : "h-full rounded-full bg-primario"}
        style={{ width: `${ancho}%` }}
      />
    </div>
  );
}

interface PropsUsoPlan {
  /**
   * La pantalla ya anuncia «límite de RUCs» en su propio aviso (409 `cupo_rucs`): aquí se omite esa línea
   * para que el mismo texto no salga en dos `role="alert"` (spec 018, T5a, CA-10).
   */
  avisoRucsAnunciado?: boolean;
}

export function UsoPlan({ avisoRucsAnunciado = false }: PropsUsoPlan = {}) {
  const [resultado, setResultado] = useState<ResultadoUso | null>(null);

  useEffect(() => {
    let vigente = true;
    cargarUso()
      .then((r) => {
        if (vigente) setResultado(r);
      })
      .catch(() => {
        if (vigente) setResultado({ estado: "sin_datos" });
      });
    return () => {
      vigente = false;
    };
  }, []);

  if (!resultado || resultado.estado === "sin_datos") return null;

  if (resultado.estado === "sin_plan") {
    return (
      <Alert tono="aviso" role="status" className="w-full max-w-xl">
        <CircleAlert aria-hidden="true" />
        <p className="m-0">{MENSAJES_REGISTRO.sinPlan}</p>
      </Alert>
    );
  }

  const { plan, estado, pruebaVenceEn, rucs, usuarios } = resultado.uso;
  const cuenta = usuarios.usados + usuarios.pendientes;
  const alcanzoRucs = rucs.libres <= 0;
  const alcanzoUsuarios = usuarios.limite !== null && cuenta >= usuarios.limite;
  const vence = estado === "prueba" ? fechaDePrueba(pruebaVenceEn) : null;
  const pendientes =
    usuarios.pendientes > 0
      ? ` (${usuarios.pendientes} ${usuarios.pendientes === 1 ? "pendiente" : "pendientes"})`
      : "";

  return (
    <Card aria-label="Uso del plan" className="w-full max-w-xl gap-3 p-4 text-sm sm:p-6">
      <p className="m-0 font-titulo text-base font-bold">
        Plan {plan.nombre}
        {estado === "prueba" &&
          ` · periodo de prueba${vence ? `, vence el ${vence}` : ""}`}
      </p>
      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-tinta-media">
          RUCs: {rucs.usados} de {rucs.limite}
        </p>
        <BarraUso usados={rucs.usados} limite={rucs.limite} alcanzado={alcanzoRucs} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-tinta-media">
          Usuarios: {cuenta} de {usuarios.limite ?? "ilimitado"}
          {pendientes}
        </p>
        {usuarios.limite !== null && (
          <BarraUso usados={cuenta} limite={usuarios.limite} alcanzado={alcanzoUsuarios} />
        )}
      </div>
      {(alcanzoRucs || alcanzoUsuarios) && (
        <Alert tono="aviso" role="alert">
          <CircleAlert aria-hidden="true" />
          <div className="flex flex-col gap-1 [&_p]:m-0">
            {alcanzoRucs && !avisoRucsAnunciado && (
              <p>{MENSAJES_PLAN.limiteRucs}</p>
            )}
            {alcanzoUsuarios && <p>{MENSAJES_PLAN.limiteUsuarios}</p>}
            <p>{MENSAJES_PLAN.subirDePlan}</p>
          </div>
        </Alert>
      )}
    </Card>
  );
}
