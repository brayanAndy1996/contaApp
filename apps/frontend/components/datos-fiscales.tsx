import { MONEDAS, REGIMENES, ZONAS, type PerfilFiscal } from "@contapp/shared";
import { Label, Select } from "./ui";

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
      <Label>
        Régimen
        <Select
          value={perfil.regimen ?? ""}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({
              ...perfil,
              regimen: REGIMENES.find((r) => r === e.target.value) ?? null,
            })
          }
          className="max-lg:h-11"
        >
          <option value="">Sin definir</option>
          {REGIMENES.map((r) => (
            <option key={r} value={r}>
              {TEXTO_REGIMEN[r]}
            </option>
          ))}
        </Select>
      </Label>

      <Label>
        Zona
        <Select
          value={perfil.zona}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({
              ...perfil,
              zona: ZONAS.find((z) => z === e.target.value) ?? perfil.zona,
            })
          }
          className="max-lg:h-11"
        >
          {ZONAS.map((z) => (
            <option key={z} value={z}>
              {TEXTO_ZONA[z]}
            </option>
          ))}
        </Select>
      </Label>

      <Label className="min-h-10 flex-row items-center gap-2 font-normal text-tinta max-lg:min-h-11">
        <input
          type="checkbox"
          checked={perfil.ventasExoneradas}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({ ...perfil, ventasExoneradas: e.target.checked })
          }
          className="size-5 cursor-pointer accent-primario max-lg:size-6"
        />
        Ventas exoneradas
      </Label>

      <Label className="min-h-10 flex-row items-center gap-2 font-normal text-tinta max-lg:min-h-11">
        <input
          type="checkbox"
          checked={perfil.ventasMixtas}
          disabled={deshabilitado}
          onChange={(e) =>
            onChange({ ...perfil, ventasMixtas: e.target.checked })
          }
          className="size-5 cursor-pointer accent-primario max-lg:size-6"
        />
        Ventas mixtas
      </Label>

      <Label>
        Moneda habitual
        <Select
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
          className="max-lg:h-11"
        >
          {MONEDAS.map((m) => (
            <option key={m} value={m}>
              {TEXTO_MONEDA[m]}
            </option>
          ))}
        </Select>
      </Label>
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
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {filas.map(([etiqueta, valor]) => (
        <div key={etiqueta} className="contents">
          <dt className="text-tinta-suave">{etiqueta}</dt>
          <dd className="m-0 text-tinta">{valor}</dd>
        </div>
      ))}
    </dl>
  );
}
