"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PlanDto } from "@contapp/shared";
import { MENSAJES } from "../../../lib/acceso";
import { api } from "../../../lib/api";
import {
  MENSAJES_PLATAFORMA,
  mensajeDeAsignacion,
  mensajeGeneral,
  rucsExtraDe,
  useAccesoPlataforma,
  type EstudioPlataforma,
} from "../../../lib/plataforma";

// Estudios de la plataforma (spec 006, D5, D13, CA-10): plan y RUCs adicionales por estudio. Sin
// acceso (403 de /plataforma/yo) solo se muestra el aviso: ni datos ni acciones. El servidor valida
// cada asignación.

export default function AdminPlataforma() {
  const acceso = useAccesoPlataforma();
  const [estudios, setEstudios] = useState<EstudioPlataforma[]>([]);
  const [planes, setPlanes] = useState<PlanDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargarEstudios = useCallback(async () => {
    const r = await api<EstudioPlataforma[]>("/plataforma/estudios");
    if (r.ok && r.datos) setEstudios(r.datos);
    else if (r.status !== 401) setError(mensajeGeneral(r.status));
  }, []);

  const cargarPlanes = useCallback(async () => {
    const r = await api<PlanDto[]>("/plataforma/planes");
    if (r.ok && r.datos) setPlanes(r.datos);
    else if (r.status !== 401) setError(mensajeGeneral(r.status));
  }, []);

  useEffect(() => {
    if (acceso !== "admin") return;
    Promise.all([cargarEstudios(), cargarPlanes()]).catch(() =>
      setError(MENSAJES.errorGeneral),
    );
  }, [acceso, cargarEstudios, cargarPlanes]);

  async function asignar(
    estudio: EstudioPlataforma,
    planId: string,
    texto: string,
  ) {
    setAviso(null);
    const rucsExtra = rucsExtraDe(texto);
    if (rucsExtra === null) {
      setError(MENSAJES_PLATAFORMA.extraNoValido);
      return;
    }
    setError(null);
    setOcupado(true);
    try {
      const r = await api(`/plataforma/estudios/${estudio.id}/suscripcion`, {
        method: "PUT",
        body: { planId, rucsExtraContratados: rucsExtra },
      });
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeAsignacion(r.status, r.datos));
        return;
      }
      setAviso(MENSAJES_PLATAFORMA.suscripcionGuardada);
      await cargarEstudios();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  if (acceso === undefined) return <main className="p-6">Cargando…</main>;
  if (acceso !== "admin") {
    return (
      <main className="p-6">
        <p>
          {acceso === "sin_permiso"
            ? MENSAJES.sinPermiso
            : MENSAJES.errorGeneral}
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Administración de plataforma</h1>
      <nav className="text-sm">
        <Link href="/admin/planes" className="underline">
          Planes
        </Link>
      </nav>
      {error && (
        <div role="alert" className="text-sm text-red-600">
          <p>{error}</p>
        </div>
      )}
      {aviso && (
        <p role="status" className="text-sm">
          {aviso}
        </p>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Estudios</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Estudio</th>
              <th>Plan actual</th>
              <th>Estado</th>
              <th>Nuevo plan</th>
              <th>RUCs adicionales</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {estudios.map((e) => (
              <FilaEstudio
                key={`${e.id}:${e.plan.codigo}`}
                estudio={e}
                planes={planes}
                ocupado={ocupado}
                onAsignar={asignar}
              />
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

interface FilaEstudioProps {
  estudio: EstudioPlataforma;
  planes: PlanDto[];
  ocupado: boolean;
  onAsignar: (
    estudio: EstudioPlataforma,
    planId: string,
    rucsExtra: string,
  ) => Promise<void>;
}

/** Una fila por estudio. Solo se ofrecen planes activos; se preselecciona el plan actual por código. */
function FilaEstudio({
  estudio,
  planes,
  ocupado,
  onAsignar,
}: FilaEstudioProps) {
  const activos = planes.filter((p) => p.activo);
  const actual =
    activos.find((p) => p.codigo === estudio.plan.codigo)?.id ?? "";
  // Lo que elige el super-admin gana al plan actual, así la fila se completa aunque los planes lleguen después.
  const [elegido, setElegido] = useState<string | null>(null);
  const [rucsExtra, setRucsExtra] = useState("0");
  const planId = elegido ?? actual;

  return (
    <tr>
      <th scope="row" className="py-2 font-normal">
        {estudio.nombre}
      </th>
      <td>{estudio.plan.nombre}</td>
      <td>{estudio.estado}</td>
      <td>
        <select
          aria-label="Plan"
          value={planId}
          disabled={ocupado}
          onChange={(e) => setElegido(e.target.value)}
          className="rounded border px-2 py-1"
        >
          {planId === "" && (
            <option value="" disabled>
              Elige un plan
            </option>
          )}
          {activos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nombre}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          aria-label="RUCs adicionales"
          inputMode="numeric"
          value={rucsExtra}
          disabled={ocupado}
          onChange={(e) => setRucsExtra(e.target.value)}
          className="w-24 rounded border px-2 py-1"
        />
      </td>
      <td>
        <button
          type="button"
          disabled={ocupado || planId === ""}
          onClick={() => void onAsignar(estudio, planId, rucsExtra)}
          className="rounded border px-2 py-1"
        >
          Asignar plan
        </button>
      </td>
    </tr>
  );
}
