# Notas de entrada (mientras corre el cronómetro)

Cada entrada de tiempo de bita tiene una **nota**: un markdown en el repositorio
de inkwell, en `<espacio>/<aaaa>/<mm>/<dd>-<id>-<título>.md`. La nota cuenta qué
pasó en ese bloque de trabajo; lo que debe sobrevivir al bloque va a una página.

inkwell la mantiene sola a partir de los eventos de bita: al arrancar crea el
esqueleto (Contexto, Qué se hizo, Pendiente), al corregir el título o el
proyecto la renombra o la mueve, al parar anota el fin y la duración, al unir
entradas junta sus notas, y al cancelar o borrar la entrada la borra. Tú solo
escribes el contenido, con las reglas de [writing.md](writing.md).

## En qué entrada escribir

`bita ls --json` lista los cronómetros que corren; toma el `id` del que
corresponde al trabajo en curso (si solo hay uno, ese).

## Escribir

Sección por sección, con el texto por stdin:

```
inkwell note save <entryId> --section "Contexto" --md - <<'MD'
Por qué se abrió este trabajo: el WAF bloquea /admin desde la VPN (VB-12).
MD
```

`--section` reemplaza esa sección entera; las demás quedan como están. Escribe
antes de parar el cronómetro.

- **Contexto**: por qué se hace, qué se pidió, el ticket de origen y el estado
  del sistema al empezar.
- **Qué se hizo**: los cambios concretos, en pasado y con nombres reales. Se
  actualiza en cada avance significativo reescribiendo la sección completa, no
  agregando renglones sueltos.
- **Pendiente**: lo que quedó abierto. Si alguien más debe retomarlo, además va
  al backlog (`inkwell backlog add`).
- Opcionales, si hay material: **Decisiones**, **Hallazgos**, **Verificación** y
  **Tocado** (lo llenan `--file`, `--command` y `--resource`).

## Leer

```
inkwell note show <entryId> --brief --json                 # markdown y secciones, sin metadatos
inkwell note show <entryId> --section "Qué se hizo" --json # una sola sección
inkwell note ls today                                      # también week, month, --from/--to, --project
inkwell note search "waf" [--project APT]
inkwell note path <entryId> [--create]
```

`note show` sin `--brief` trae además el front matter, el estado del archivo y
los anexos; úsalo solo si los necesitas. `--entry <id>` sirve en lugar del id
posicional. Las notas que bita escribió antes se traen con
`inkwell migrate notes --from-bita` (se puede repetir).
