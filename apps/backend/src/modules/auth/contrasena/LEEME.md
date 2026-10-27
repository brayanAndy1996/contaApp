# Lista de contraseñas comunes

`comunes.txt` es la lista que usa la política de contraseñas (spec 004, P5) para rechazar contraseñas muy comunes. El backend la carga al arrancar en un `Set` y compara sin distinguir mayúsculas.

- **Origen**: lista propia, armada a mano por el equipo. No se descargó nada de internet ni de otras listas (SecLists u otras).
- **Fecha**: 2026-10-26.
- **Formato**: UTF-8, una entrada por línea, fin de línea LF, minúsculas, forma NFC, sin espacios y sin duplicados.
- **Criterio de filtro**: solo entradas de 12 a 128 puntos de código, que son los límites de la política. Se incluyen patrones muy comunes: secuencias de teclado y de dígitos, palabras y frases comunes en español e inglés con años o dígitos, nombres de marcas, equipos y personajes populares, y contraseñas por defecto de cuentas y pruebas. No contiene contraseñas de usuarios reales, datos personales ni credenciales de la aplicación.
- **Ampliación**: se amplía después (P12) con el mismo origen y criterio.
