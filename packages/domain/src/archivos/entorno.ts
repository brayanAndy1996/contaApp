// D2 (spec 012b): el formato provisional solo se genera fuera de producción. Única función para backend y
// worker: ninguno toma `permitirProvisional` de la petición.
export function permiteProvisional(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
