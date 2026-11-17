"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { PlanDto } from "@contapp/shared";
import { MENSAJES } from "../../../lib/acceso";
import { api } from "../../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  EncabezadoPagina,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui";
import {
  MENSAJES_PLATAFORMA,
  mensajeDeAsignacion,
  mensajeGeneral,
  rucsExtraDe,
  useAccesoPlataforma,
  type EstudioPlataforma,
} from "../../../lib/plataforma";

// Estudios de la plataforma (spec 006, D5, D13, D14, CA-10): plan y RUCs adicionales por estudio. Sin
// acceso (403 de /plataforma/yo) solo se muestra el aviso: ni datos ni acciones. El servidor valida
// cada asignación. Un estudio sin suscripción (plan y estado nulos, D14) figura como "Sin plan" y admite
// asignarle uno.

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

  if (acceso === undefined) return <main className="p-4 text-tinta-suave sm:p-6">Cargando…</main>;
  if (acceso !== "admin") {
    return (
      <main className="p-4 sm:p-6">
        <p className="m-0 text-tinta-media">
          {acceso === "sin_permiso"
            ? MENSAJES.sinPermiso
            : MENSAJES.errorGeneral}
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <EncabezadoPagina
        titulo="Administración de plataforma"
        acciones={
          <nav>
            <Button asChild variant="secundario" className="max-lg:h-11">
              <Link href="/admin/planes">Planes</Link>
            </Button>
          </nav>
        }
      />
      {error && (
        <Alert tono="error" role="alert">
          <CircleAlert aria-hidden="true" />
          <p className="m-0">{error}</p>
        </Alert>
      )}
      {aviso && (
        <Alert tono="ok" role="status">
          <CircleCheck aria-hidden="true" />
          <p className="m-0">{aviso}</p>
        </Alert>
      )}
      <Card className="p-4 sm:p-6">
        <CardTitle>Estudios</CardTitle>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Estudio</TableHead>
              <TableHead>Plan actual</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Nuevo plan</TableHead>
              <TableHead>RUCs adicionales</TableHead>
              <TableHead>Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {estudios.map((e) => (
              <FilaEstudio
                key={`${e.id}:${e.plan?.codigo ?? ""}`}
                estudio={e}
                planes={planes}
                ocupado={ocupado}
                onAsignar={asignar}
              />
            ))}
          </TableBody>
        </Table>
      </Card>
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
    activos.find((p) => p.codigo === estudio.plan?.codigo)?.id ?? "";
  // Lo que elige el super-admin gana al plan actual, así la fila se completa aunque los planes lleguen después.
  const [elegido, setElegido] = useState<string | null>(null);
  const [rucsExtra, setRucsExtra] = useState("0");
  const planId = elegido ?? actual;

  return (
    <TableRow>
      <TableHead scope="row" className="border-b-0 px-3 py-3 text-sm font-normal text-tinta">
        {estudio.nombre}
      </TableHead>
      <TableCell>{estudio.plan?.nombre ?? "Sin plan"}</TableCell>
      <TableCell>{estudio.estado ? <Badge>{estudio.estado}</Badge> : "—"}</TableCell>
      <TableCell>
        <Select
          aria-label="Plan"
          value={planId}
          disabled={ocupado}
          onChange={(e) => setElegido(e.target.value)}
          className="w-auto min-w-40 max-lg:h-11"
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
        </Select>
      </TableCell>
      <TableCell>
        <Input
          aria-label="RUCs adicionales"
          inputMode="numeric"
          value={rucsExtra}
          disabled={ocupado}
          onChange={(e) => setRucsExtra(e.target.value)}
          className="w-24 max-lg:h-11"
        />
      </TableCell>
      <TableCell>
        <Button
          variant="secundario"
          size="sm"
          disabled={ocupado || planId === ""}
          onClick={() => void onAsignar(estudio, planId, rucsExtra)}
          className="max-lg:h-11"
        >
          Asignar plan
        </Button>
      </TableCell>
    </TableRow>
  );
}
