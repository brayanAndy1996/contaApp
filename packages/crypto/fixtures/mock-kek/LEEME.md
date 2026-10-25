# Par de PRUEBA del proveedor mock (KEK)

**Par de PRUEBA, público a propósito.** Sirve solo para pruebas y desarrollo local.

- `SOLO-PRUEBAS-kek-mock-public.pem`: llave pública (SPKI, RSA 4096 bits).
- `SOLO-PRUEBAS-kek-mock-private.pem`: llave privada (PKCS#8). Va versionada a propósito: es el único fixture de llave privada permitido en el repo.

Reglas:

- **Prohibido en producción.** Con `NODE_ENV=production` el proveedor `mock` no arranca.
- Como la privada está en el repo, cualquiera puede descifrar lo cifrado con `mock`. Por eso nunca debe haber datos reales con `kek_id = mock`.
- `kek_id = mock` está reservado: el proveedor `local` no lo acepta y rechaza esta llave por huella SHA-256 del SPKI.
- No usar este par para `kek:generar` ni en ningún entorno real.
- El código lo lee por ruta desde esta carpeta (decisión mock en `docs/specs/003-cifrado/plan.md`).
