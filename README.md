# inkwell

Documentación técnica viva desde la terminal: árboles de páginas en markdown con
historia en git, la nota de cada entrada de tiempo de bita, un backlog de pendientes y hallazgos, diagramas (mermaid y
draw.io), exportación a PDF y sincronización con Confluence.

Es una de las herramientas `@kikedealba`. No depende de ninguna otra: se
encuentra con ellas en tiempo de ejecución por medio de
[`@kikedealba/kit`](https://github.com/KikeDeAlba/kit) cuando están instaladas
juntas.

| Si también está… | inkwell… |
|---|---|
| **bita** | lleva una nota en markdown por entrada de tiempo (`note …`), ata las páginas a las entradas (`page link --entry`), toma el cronómetro que corre para ubicar un ítem del backlog y escucha los eventos `start`, `stop`, `amend`, `merge`, `cancel` y `delete` para crear, renombrar, sellar, juntar y borrar las notas, y para que los enlaces apunten siempre a entradas que existen. |
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
inkwell setup                          # registro de kit + plugin de Claude Code + skill para los demás agentes
inkwell setup --agents codex,gemini    # o solo algunos: claude, opencode, codex, gemini
```

`setup` deja el manifiesto en el registro de kit (con la suscripción a los
eventos de bita) y prepara a cada agente:

| Agente | Qué recibe |
|---|---|
| **Claude Code** | El plugin `inkwell` de este mismo repositorio, que es su propio marketplace (`claude plugin marketplace add KikeDeAlba/inkwell` + `claude plugin install inkwell@inkwell`). Trae la skill y el MCP de draw.io. Si ya existía, se actualiza. Después se quitan los archivos sueltos que versiones anteriores dejaron en `~/.claude` (la skill enlazada, los permisos y el MCP de draw.io a nivel de usuario). |
| **opencode, Codex y Gemini CLI** | La skill con sus archivos de apoyo y el MCP de draw.io (`--no-drawio` lo omite; en Claude Code el MCP viene con el plugin). |

Si `claude` no está en el PATH, `setup` lo avisa con los comandos para
instalar el plugin a mano y deja la instalación anterior como estaba.
`inkwell uninstall` desinstala el plugin y revierte lo demás sin tocar las
páginas.

### La skill

La skill (`skills/inkwell/SKILL.md`) se mantiene corta: solo se carga al
invocarla, y los detalles viven en archivos de apoyo que se leen cuando la tarea
los pide:

| Archivo | Contenido |
|---|---|
| `writing.md` | Las reglas de redacción (frases prohibidas, «así no / así sí», tono). Es la fuente única: tally y las demás herramientas la enlazan. |
| `entry-notes.md` | Cómo escribir y leer la nota de una entrada de bita. |
| `diagrams.md` | mermaid contra draw.io y el flujo del MCP de draw.io. |
| `confluence.md` | Cómo se publica y sincroniza con Confluence (siempre por atl). |

`inkwell guide <writing|entry-notes|diagrams|confluence>` imprime cualquiera de
ellos, para quien no tenga la skill a mano.

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
inkwell page show 1 --brief --json            # solo el markdown y los identificadores
inkwell page show 1 --section "Red" --json    # una sola sección
inkwell tree
inkwell search "waf" --project APT

inkwell backlog add --kind pending --title "Rotar las llaves del bucket" --page 1
inkwell backlog resolve APT-1 --resolution "Rotadas con KMS"

inkwell note save 42 --section "Qué se hizo" --md -   # el texto llega por stdin
inkwell note show 42
inkwell note ls today
inkwell note search "waf" --project APT

inkwell page history 1
inkwell git propose 1 --branch reunion/7 --reason "Acuerdos de la reunión" --md cambios.md
inkwell branch apply reunion/7 --commit <sha>

inkwell diagrams render 1
inkwell export page 1 --out arquitectura.pdf
inkwell confluence sync APT --dry-run
```

`page show` y `note show` aceptan `--brief` (el markdown sin front matter, la
lista de secciones y los identificadores mínimos, sin entradas, issues ni
metadatos) y `--section <H2>` (una sola sección, con la misma forma corta). Son
las formas que usan los agentes para no gastar contexto; una sección que no
existe falla con `SECTION_NOT_FOUND` y la pista trae las que hay.

`inkwell help` lista todos los comandos. Todos aceptan `--json` y responden con
el sobre de kit (`{ schemaVersion, ok, command, generatedAt, data | error }`).
`--project` (alias `--space`) acepta el nombre, la clave, el id del espacio o el
id del proyecto de bita del que se migró.

## Notas por entrada

Cada entrada de tiempo de bita tiene una nota en
`<espacio>/<aaaa>/<mm>/<dd>-<id>-<título>.md`, con front matter (`entryId`,
`title`, `project`, `startedAt`, `endedAt`, `duration`, `kind`…) y las
secciones Contexto, Qué se hizo y Pendiente (más Decisiones, Hallazgos,
Verificación, Tocado o las que agregue otra herramienta, como la Reunión de
recap). La tabla `entry_notes` las indexa con la referencia `bita:entry:<id>`.

| Comando | Qué hace |
|---|---|
| `note save <id> [--section H2] [--md FILE\|-]` | Crea la nota si falta y reemplaza la sección (por omisión, Qué se hizo). `--note-md` es sinónimo de `--md`; `--file`, `--command` y `--resource` llenan Tocado. |
| `note show <id> \| --path <rel> [--brief] [--section H2]` | La entrada y la nota con sus secciones, su front matter y su markdown; `--brief` y `--section`, la forma corta. |
| `note get <id> [--raw]` o `note <id>` | La fila de la nota con su markdown. |
| `note path <id> [--create]` | Dónde vive o viviría la nota. |
| `note ls <id>` | Los archivos de esa entrada. |
| `note ls [preset] [--from --to] [--project X]` | Las notas de un periodo (`today`, `yesterday`, `week`, `last-week`, `month`, `last-month`). |
| `note search "<texto>" [--project X] [--section H2]` | Busca en las notas. |

`--entry <id>` sirve en lugar del id posicional, y `--draft` toma el único
cronómetro sin título. Los datos de la entrada salen de `bita entries get` (por
kit) y, si bita no está, de la última copia guardada con la nota.

Los eventos de bita las mantienen al día: `start` crea el esqueleto, `amend`
la renombra o la mueve cuando cambia el título o el proyecto, `stop` sella el
fin y la duración, `merge` pasa las secciones de las entradas absorbidas a la
que sobrevive y borra las suyas, y `cancel` y `delete` la borran. Cada cambio es
un commit.

## Venir desde bita

Hasta la versión 0.18, bita guardaba la documentación junto con el tiempo.
inkwell se queda con las páginas, el backlog, los enlaces, la sincronización
con Confluence y, desde la 0.2.0, las notas por entrada.

```sh
inkwell migrate --from-bita --dry-run   # cuenta lo que traería, sin escribir
inkwell migrate --from-bita             # lo trae
inkwell migrate status --json           # { migrated, bitaDatabase, migratedAt }
inkwell migrate notes --from-bita [--dry-run]   # solo las notas por entrada
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
  de las notas, e indexa las notas por entrada;
- es idempotente: una segunda corrida no hace nada. Se niega a mezclar si
  inkwell ya tiene páginas o backlog.

Quien migró con inkwell 0.1.x trajo las páginas pero no las notas por entrada.
`inkwell migrate notes --from-bita` las copia ahora: lee la tabla `entry_docs`
y los archivos del repositorio de bita, los escribe con la misma ruta en el de
inkwell, los indexa y hace un solo commit. Se puede repetir (cuenta las que ya
están como `already`), no pisa un archivo distinto que ya esté en la misma ruta
(lo reporta como `conflict`) y no borra nada de bita.

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
