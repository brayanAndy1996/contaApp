import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSecuencia } from "./secuencia";

describe("useSecuencia", () => {
  it("la petición más reciente es la vigente", () => {
    const { result } = renderHook(() => useSecuencia());
    const primera = result.current.nueva();
    expect(result.current.vigente(primera)).toBe(true);
    const segunda = result.current.nueva();
    expect(result.current.vigente(segunda)).toBe(true);
  });

  it("una respuesta vieja o invalidada se descarta", () => {
    const { result } = renderHook(() => useSecuencia());
    const vieja = result.current.nueva();
    const nueva = result.current.nueva();
    expect(result.current.vigente(vieja)).toBe(false);
    result.current.invalidar();
    expect(result.current.vigente(nueva)).toBe(false);
  });
});
