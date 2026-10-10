# inkwell

Documentación técnica viva desde la terminal: árboles de páginas en markdown con
historia en git, un backlog de pendientes y hallazgos, diagramas (mermaid y
draw.io), exportación a PDF y sincronización con Confluence.

Es una de las herramientas `@kikedealba`. No depende de ninguna otra: se
encuentra con ellas en tiempo de ejecución por medio de
[`@kikedealba/kit`](https://github.com/KikeDeAlba/kit) cuando están instaladas
juntas.

| Si también está… | inkwell… |
|---|---|
| **bita** | ata las páginas a las entradas de tiempo (`page link --entry`), toma el cronómetro que corre para ubicar un ítem del backlog y escucha los eventos `delete`, `merge`, `cancel`, `stop` y `amend` para que los enlaces apunten siempre a entradas que existen. |
| **atl** | publica y sincroniza páginas con Confluence (`confluence sync`, `publish-diagrams`). |
| **recap** | exporta a PDF la minuta de una reunión (`export meeting`). |

Sin ellas, todo lo demás funciona igual; lo que depende de una herramienta
ausente falla con un error claro (`BITA_MISSING`, `ATL_MISSING`,
`RECAP_MISSING`) y la pista para instalarla.

## Requisitos

- Node 24 o superior. macOS, Windows y Linux.
- git, para la historia de las páginas (sin git se escribe igual, sin commits).
- Opcional: Chrome o cualquier Chromium para el PDF (`INKWELL_CHROME` apunta a
  otro binario) y draw.io Desktop para los diagramas `.drawio`
  (`INKWELL_DRAWIO`).

## Instalación

```sh
npm install -g @kikedealba/inkwell
inkwell setup                          # registro de kit + skill para los agentes detectados
inkwell setup --agents codex,gemini    # o solo algunos: claude, opencode, codex, gemini
```

`setup` deja el manifiesto en el registro de kit (con la suscripción a los
eventos de bita), instala la skill de documentación en Claude Code, opencode,
Codex y Gemini CLI, y agrega el MCP de draw.io (`--no-drawio` lo omite).
`inkwell uninstall` lo revierte sin tocar las páginas.

## Datos

| Sistema | Base de datos y repositorio |
|---|---|
| macOS / Linux | `${XDG_DATA_HOME:-~/.local/share}/inkwell/inkwell.db` y `…/inkwell/docs` |
| Windows | `%LOCALAPPDATA%\inkwell\inkwell.db` y `%LOCALAPPDATA%\inkwell\docs` |

`INKWELL_DB_PATH` e `INKWELL_DOCS_DIR` cambian las rutas (si solo se cambia la
base, el repositorio va junto a ella).

## Uso

```sh
inkwell space add "Apartados" --key APT --confluence https://acme.atlassian.net/wiki/spaces/VB --pull on
inkwell page new "Arquitectura" --project APT
inkwell page write 1 --md arquitectura.md
inkwell page show 1
inkwell tree
inkwell search "waf" --project APT

inkwell backlog add --kind pending --title "Rotar las llaves del bucket" --page 1
inkwell backlog resolve APT-1 --resolution "Rotadas con KMS"

inkwell page history 1
inkwell git propose 1 --branch reunion/7 --reason "Acuerdos de la reunión" --md cambios.md
inkwell branch apply reunion/7 --commit <sha>

inkwell diagrams render 1
inkwell export page 1 --out arquitectura.pdf
inkwell confluence sync APT --dry-run
```

`inkwell help` lista todos los comandos. Todos aceptan `--json` y responden con
el sobre de kit (`{ schemaVersion, ok, command, generatedAt, data | error }`).
`--project` (alias `--space`) acepta el nombre, la clave, el id del espacio o el
id del proyecto de bita del que se migró.

## Venir desde bita

Hasta la versión 0.17, bita guardaba la documentación junto con el tiempo.
inkwell se queda con las páginas, el backlog, los enlaces y la sincronización
con Confluence; las notas por entrada siguen en bita.

```sh
inkwell migrate --from-bita --dry-run   # cuenta lo que traería, sin escribir
inkwell migrate --from-bita             # lo trae
inkwell migrate status --json           # { migrated, bitaDatabase, migratedAt }
```

La migración:

- convierte los proyectos de bita en espacios (`external_ref` =
  `bita:project:<id>`), con su clave y su configuración de Confluence;
- copia las páginas con sus ids, los enlaces a entradas e issues como
  referencias opacas (`bita:entry:<id>`, `jira:<KEY>`) con la duración ya
  medida, los enlaces externos, el backlog con sus claves y el mapa de
  Confluence;
- clona el repositorio de documentación de bita para conservar toda la historia
  y las ramas de propuestas, trae las ediciones sin commitear de las páginas y
  retira las notas por entrada en un solo commit;
- es idempotente: una segunda corrida no hace nada. Se niega a mezclar si
  inkwell ya tiene páginas o backlog.

Lee la base de bita de `BITA_DB_PATH` (o `~/.local/share/bita/bita.db`) y el
repositorio de `BITA_DOCS_DIR` (o `docs` junto a la base); `--bita-db` y
`--bita-docs` las cambian.

## Desarrollo

```sh
pnpm install
pnpm typecheck
pnpm test
node src/bin/inkwell.ts help
```

## Licencia

MIT
