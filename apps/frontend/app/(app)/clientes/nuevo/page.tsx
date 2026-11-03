"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  clienteCrearSchema,
  validarRuc,
  type PerfilFiscal,
} from "@contapp/shared";
import {
  DatosFiscales,
  PERFIL_INICIAL,
} from "../../../../components/datos-fiscales";
import { UsoPlan } from "../../../../components/uso-plan";
import { api } from "../../../../lib/api";
import {
  MENSAJES,
  mensajeDeError,
  usePuede,
  type Miembro,
} from "../../../../lib/acceso";
import { crearCliente } from "../../../../lib/clientes";
import { MENSAJES_PLAN } from "../../../../lib/planes";
import { MENSAJES_REGISTRO } from "../../../../lib/registro";

// Alta de cliente (spec 007a, D2, D3, D4; CA-1, CA-2, CA-9). Pide `clientes.crear`. El RUC se recorta y se
// valida en línea con `validarRuc` de shared; antes de enviar se valida el cuerpo completo con
// `clienteCrearSchema` (el backend vuelve a validar). Razón social, responsable y datos fiscales son
// opcionales: `perfil` solo viaja si el usuario tocó sus controles, y el responsable se elige con
// `clientes.asignar`, igual que la asignación de 005.

const MENSAJES_ALTA = {
  rucVacio: "Ingresa el RUC.",
  rucInvalido: "El RUC no es válido.",
  rucDuplicado: "Ya existe un cliente con ese RUC.",
  solicitudInvalida: "Revisa los datos ingresados.",
} as const;

const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null)?.codigo;

export default function NuevoCliente() {
  const router = useRouter();
  const puedeCrear = usePuede("clientes.crear");
  const puedeAsignar = usePuede("clientes.asignar");
  const [ruc, setRuc] = useState("");
  const [errorRuc, setErrorRuc] = useState<string | null>(null);
  const [razonSocial, setRazonSocial] = useState("");
  const [responsableId, setResponsableId] = useState("");
  const [perfil, setPerfil] = useState<PerfilFiscal | null>(null);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cupoLleno, setCupoLleno] = useState(false);

  useEffect(() => {
    if (puedeAsignar !== true) return;
    let vigente = true;
    api<Miembro[]>("/usuarios")
      .then((r) => {
        if (vigente && r.ok && r.datos) setMiembros(r.datos);
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [puedeAsignar]);

  if (puedeCrear === undefined) return <main className="p-6">Cargando…</main>;

  if (puedeCrear === false) {
    return (
      <main className="p-6">
        <p role="alert" className="text-sm text-red-600">
          {MENSAJES.sinPermiso}
        </p>
      </main>
    );
  }

  function alCambiarRuc(valor: string) {
    setRuc(valor);
    setErrorRuc(null);
  }

  function alSalirRuc() {
    const limpio = ruc.trim();
    if (limpio !== "" && !validarRuc(limpio)) {
      setErrorRuc(MENSAJES_ALTA.rucInvalido);
    }
  }

  async function crear(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const rucLimpio = ruc.trim();
    const razon = razonSocial.trim();
    const valido = clienteCrearSchema.safeParse({
      ruc: rucLimpio,
      ...(razon !== "" ? { razonSocial: razon } : {}),
      ...(responsableId !== "" ? { responsableId } : {}),
      ...(perfil ? { perfil } : {}),
    });
    if (!valido.success) {
      if (valido.error.issues.some((i) => i.path[0] === "ruc")) {
        setErrorRuc(
          rucLimpio === "" ? MENSAJES_ALTA.rucVacio : MENSAJES_ALTA.rucInvalido,
        );
      } else {
        setError(MENSAJES_ALTA.solicitudInvalida);
      }
      return;
    }

    setOcupado(true);
    setError(null);
    setCupoLleno(false);
    try {
      const r = await crearCliente(valido.data);
      if (r.ok && r.datos) {
        router.push(`/clientes/${r.datos.id}`);
        return;
      }
      const codigo = codigoDe(r.datos);
      if (r.status === 409 && codigo === "cupo_rucs") {
        setError(MENSAJES_PLAN.limiteRucs);
        setCupoLleno(true);
      } else if (r.status === 409 && codigo === "ruc_duplicado") {
        setErrorRuc(MENSAJES_ALTA.rucDuplicado);
      } else if (r.status === 409 && codigo === "sin_plan") {
        setError(MENSAJES_REGISTRO.sinPlan);
      } else if (r.status === 400) {
        setError(MENSAJES_ALTA.solicitudInvalida);
      } else if (r.status !== 401) {
        setError(mensajeDeError(r.status, r.datos));
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Nuevo cliente</h1>

      <form
        onSubmit={crear}
        noValidate
        className="flex w-full max-w-xl flex-col gap-5"
      >
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-sm">
            RUC
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={ruc}
              disabled={ocupado}
              aria-invalid={errorRuc ? true : undefined}
              aria-describedby={errorRuc ? "ayuda-ruc error-ruc" : "ayuda-ruc"}
              onChange={(e) => alCambiarRuc(e.target.value)}
              onBlur={alSalirRuc}
              className="rounded border px-3 py-2"
            />
          </label>
          <p id="ayuda-ruc" className="text-xs text-neutral-600">
            11 dígitos. Empieza con 10, 15, 16, 17 o 20.
          </p>
          {errorRuc && (
            <p id="error-ruc" role="alert" className="text-sm text-red-600">
              {errorRuc}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-sm">
            Razón social
            <input
              type="text"
              value={razonSocial}
              disabled={ocupado}
              aria-describedby="ayuda-razon"
              onChange={(e) => setRazonSocial(e.target.value)}
              className="rounded border px-3 py-2"
            />
          </label>
          <p id="ayuda-razon" className="text-xs text-neutral-600">
            {"Opcional. Si la dejas vacía, se guarda «RUC <número>» hasta completarla."}
          </p>
        </div>

        {puedeAsignar === true && (
          <label className="flex flex-col gap-1 text-sm">
            Responsable
            <select
              value={responsableId}
              disabled={ocupado}
              onChange={(e) => setResponsableId(e.target.value)}
              className="rounded border px-3 py-2"
            >
              <option value="">{MENSAJES.sinResponsable}</option>
              {miembros
                .filter((m) => m.activo)
                .map((m) => (
                  <option key={m.usuarioId} value={m.usuarioId}>
                    {m.nombre}
                  </option>
                ))}
            </select>
          </label>
        )}

        <fieldset className="flex flex-col gap-4 rounded border p-4">
          <legend className="px-1 text-sm font-medium">
            Datos fiscales (opcional)
          </legend>
          <DatosFiscales
            perfil={perfil ?? PERFIL_INICIAL}
            onChange={setPerfil}
            deshabilitado={ocupado}
          />
        </fieldset>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {cupoLleno && <UsoPlan />}

        <button
          type="submit"
          disabled={ocupado}
          className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          Crear cliente
        </button>
      </form>
    </main>
  );
}
