import { Alert, Button } from "../ui";

interface Props {
  codigos: readonly string[];
  alGuardar: () => void;
}

/** Los códigos de recuperación se muestran una sola vez (spec 029): viven solo en el estado de la pantalla. */
export function CodigosRecuperacion({ codigos, alGuardar }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <Alert tono="aviso">
        Guarda estos códigos de recuperación en un lugar seguro. Cada uno sirve
        una sola vez y no volverás a verlos.
      </Alert>
      <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
        {codigos.map((c) => (
          <li key={c}>
            <code className="block rounded-control bg-neutro-fondo px-3 py-2 font-mono text-sm tracking-wider text-tinta">
              {c}
            </code>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        onClick={alGuardar}
        className="self-start max-lg:h-11"
      >
        Ya guardé mis códigos
      </Button>
    </div>
  );
}
