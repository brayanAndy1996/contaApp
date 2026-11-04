import { MONEDAS, REGIMENES, ZONAS, type PerfilFiscal } from "@contapp/shared";

// Datos fiscales de un cliente (spec 007a, D1; CA-4, CA-9). Solo presentación: el catálogo sale de
// `@contapp/shared` y el backend valida los valores (400). La pantalla decide si los muestra como
// controles (con `clientes.editar` y cliente activo) o como texto (solo lectura, D5).

type Regimen = (typeof REGIMENES)[number];
type Zona = (typeof ZONAS)[number];
type Moneda = (typeof MONEDAS)[number];

const TEXTO_REGIMEN: Record<Regimen, string> = {
  rg: "Régimen General (RG)",
  rmt: "Régimen MYPE Tributario (RMT)",
  rer: "Régimen Especial de Renta (RER)",
  nrus: "Nuevo RUS (NRUS)",
};

const TEXTO_ZONA: Record<Zona, string> = {
  general: "General",
  amazonia: "Amazonía",
};

const TEXTO_MONEDA: Record<Moneda, string> = {
  PEN: "Soles (PEN)",
  USD: "Dólares (USD)",
};

/** Valores iniciales del formulario: los mismos que D1 deja por defecto en la BD. */
export const PERFIL_INICIAL: PerfilFiscal = {
  regimen: null,
  zona: "general",
  ventasExoneradas: false,
  ventasMixtas: false,
  monedaHabitual: "PEN",
};

const textoRegimen = (regimen: Regimen | null): string =>
  regimen === null ? "Sin definir" : TEXTO_REGIMEN[regimen];

const si = (valor: boolean): string => (valor ? "Sí" : "No");

interface PropsControles {
  perfil: PerfilFiscal;
  onChange: (perfil: PerfilFiscal) => void;
  deshabilitado?: boolean;
}

/** Controles del perfil fiscal. Cada cambio entrega el perfil completo. */
export function DatosFiscales({
  perfil,
  onChange,
  deshabilitado = false,
}: PropsControles) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        Régimen
        <select
          value={perfil.regimen ?? ""}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({
              ...perfil,
              regimen: REGIMENES.find((r) => r === e.target.value) ?? null,
            })
          }
          className="rounded border px-3 py-2"
        >
          <option value="">Sin definir</option>
          {REGIMENES.map((r) => (
            <option key={r} value={r}>
              {TEXTO_REGIMEN[r]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Zona
        <select
          value={perfil.zona}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({
              ...perfil,
              zona: ZONAS.find((z) => z === e.target.value) ?? perfil.zona,
            })
          }
          className="rounded border px-3 py-2"
        >
          {ZONAS.map((z) => (
            <option key={z} value={z}>
              {TEXTO_ZONA[z]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={perfil.ventasExoneradas}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({ ...perfil, ventasExoneradas: e.target.checked })
          }
        />
        Ventas exoneradas
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={perfil.ventasMixtas}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({ ...perfil, ventasMixtas: e.target.checked })
          }
        />
        Ventas mixtas
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Moneda habitual
        <select
          value={perfil.monedaHabitual}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({
              ...perfil,
              monedaHabitual:
                MONEDAS.find((m) => m === e.target.value) ??
                perfil.monedaHabitual,
            })
          }
          className="rounded border px-3 py-2"
        >
          {MONEDAS.map((m) => (
            <option key={m} value={m}>
              {TEXTO_MONEDA[m]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Perfil fiscal en texto, para la pantalla de solo lectura (cliente archivado o sin permiso). */
export function DatosFiscalesLectura({ perfil }: { perfil: PerfilFiscal }) {
  const filas: [etiqueta: string, valor: string][] = [
    ["Régimen", textoRegimen(perfil.regimen)],
    ["Zona", TEXTO_ZONA[perfil.zona]],
    ["Ventas exoneradas", si(perfil.ventasExoneradas)],
    ["Ventas mixtas", si(perfil.ventasMixtas)],
    ["Moneda habitual", TEXTO_MONEDA[perfil.monedaHabitual]],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {filas.map(([etiqueta, valor]) => (
        <div key={etiqueta} className="contents">
          <dt className="text-neutral-600">{etiqueta}</dt>
          <dd>{valor}</dd>
        </div>
      ))}
    </dl>
  );
}
