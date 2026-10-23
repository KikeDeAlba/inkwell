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
inkwell setup --agents codex,gemini    # o solo algunos: claude, opencode, codex, gemini, antigravity, claude-desktop
```

`setup` deja el manifiesto en el registro de kit (con la suscripción a los
eventos de bita) y prepara a cada agente:

| Agente | Qué recibe |
|---|---|
| **Claude Code** | El plugin `inkwell` de este mismo repositorio, que es su propio marketplace (`claude plugin marketplace add KikeDeAlba/inkwell` + `claude plugin install inkwell@inkwell`); si ya existía, se actualiza. Trae la skill. Con el plugin instalado se quita la skill suelta que versiones anteriores enlazaron en `~/.claude/skills`, y se mantienen en `~/.claude/settings.json` los permisos de solo lectura de `inkwell` y el MCP de draw.io a nivel de usuario (`--no-drawio` lo omite; si otra herramienta, como bita, ya lo registró, no se quita). |
| **opencode** | La skill con sus archivos de apoyo y el MCP de draw.io (`--no-drawio` lo omite). |
| **Codex y Gemini CLI** | Lo mismo, más los hooks del autodoc: `PreCompact` y `SessionEnd` en Codex (`~/.codex/hooks.json`), `PreCompress` y `SessionEnd` en la extensión de Gemini; ambos corren `inkwell hook session-end --harness <agente>`. Codex puede pedir que apruebes los hooks nuevos la primera vez. |
| **Antigravity CLI** (`agy`) | Un plugin con la skill y una regla `always_on` de dos líneas que manda a la skill; el MCP de draw.io va en `~/.gemini/config/mcp_config.json`. `agy` no tiene hooks, así que no hay autodoc. |
| **Claude Desktop** | Nada: no carga skills ni corre la CLI, así que el paso sale `skipped`. |

Si `claude` no está en el PATH, `setup` lo avisa con los comandos para
instalar el plugin a mano y deja la instalación anterior como estaba.
`inkwell uninstall` desinstala el plugin y revierte lo demás sin tocar las
páginas (el marketplace `inkwell` queda agregado; se quita con
`claude plugin marketplace remove inkwell`).

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

### Borrar páginas

`inkwell page rm <id>` borra el registro, el `.md` y la carpeta `.assets` de la
página, y deja el borrado en un commit. Con `--recursive` hace lo mismo con
cada página hija que la base tenga registrada; sin él, una página con hijas
falla con un error de uso. Solo se borran archivos de las páginas condenadas:
después se quitan las carpetas de las hijas que quedaron vacías, de la más
honda a la más alta, y cualquier otro archivo que viva ahí (por ejemplo, las
notas de entrada de `proj/2026/` cuando la página se llama «2026») se queda.

Si alguno de esos archivos tiene cambios sin commitear, el comando falla con
`PAGE_FILES_DIRTY` (código de salida 9) y no toca nada; `--force` los borra de
todos modos. Si no hay un historial de git utilizable (git no está instalado o
el repositorio no se pudo iniciar), falla con `DOCS_REPO_UNAVAILABLE` y no toca
nada; con `--force` borra los archivos sin commit. Si el borrado no se pudo
commitear, avisa por stderr y lo deja pendiente para `inkwell git commit`.

Un archivo registrado como nota de entrada nunca se borra, aunque la ruta de
una página coincida con la suya: se omite y se avisa por stderr.

Con `--json`, `data` trae `removed` (`pageId`, `title`, `relPath` de cada página),
`sha` (el commit, o `null` si no hubo nada que commitear, como cuando el
archivo ya no existía) y `skipped` (las rutas omitidas por ser notas de
entrada). `meta` ya no trae `keptDocuments`.

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

## Eventos

Cada commit que inkwell hace en la rama principal del repositorio de
documentos emite `docs.changed` por kit, para que otra herramienta (un
índice, un buscador) se entere sin vigilar el repositorio. Lo emiten
`page new`, `write`, `rename`, `rm` y `restore`, las notas por entrada (también
las que escriben los eventos de bita), `inkwell git commit`, `normalize`,
`branch apply`, `confluence sync` y la migración desde bita. Una propuesta
(`git propose`) vive en su rama y no emite nada hasta que se aplica. Un commit
sin cambios en markdown (solo assets o `.gitignore`) tampoco emite.

El documento del evento:

```json
{
  "docsRoot": "/home/ana/.local/share/inkwell/docs",
  "commit": "9f1c…",
  "changes": [
    { "action": "written", "relPath": "apartados/arquitectura.md" },
    { "action": "moved", "relPath": "apartados/red.md", "from": "apartados/infra.md" },
    { "action": "deleted", "relPath": "apartados/2026/10/09-41-revisar-el-waf.md" }
  ]
}
```

- `changes` lista solo archivos `.md` fuera de las carpetas `.assets`, con rutas
  relativas a `docsRoot`, tal como las guarda git (espacios y acentos incluidos).
- `action` es `written` (creado o modificado), `deleted` o `moved`; `moved`
  trae `from` y sale de la detección de renombres de git (similitud de 30 %).
- `commit` es el último commit que cubre el evento.
- El atributo `kind` vale `page`, `entry` (notas por entrada) o `mixed`, y sirve
  para filtrar la suscripción (`filter: { kind: ["entry"] }`).

Un comando que hace varios commits (`confluence sync`, la resolución de un
conflicto, `normalize`, la migración desde bita) emite un solo evento al
terminar, aunque falle a medias, con los cambios fusionados por ruta: lo último
que le pasó a cada archivo, un `moved` encadenado se reduce a su origen, un
archivo creado y borrado dentro del mismo comando no aparece, y uno creado y
luego movido aparece como `written` en su destino. Si el evento no se puede
emitir, el commit se queda y inkwell avisa por stderr; `KIT_NO_EVENTS=1` los
apaga.

## Autodoc

Al cerrar (o compactar) una sesión de Claude Code, Codex o Gemini CLI, su hook
corre `inkwell hook session-end`, que lanza en segundo plano una revisión de la
conversación con un agente sin interfaz (Claude con `haiku` por omisión) y sale
de inmediato. Dentro de un agente lanzado sin interfaz (`KIT_HEADLESS=1`, que
kit pone a todo agente headless) el hook no hace nada.
Esa revisión:

- Ubica el espacio de la sesión por el repositorio donde se trabajó: primero
  `bita repo which` (el proyecto de bita enlazado al espacio) y, si no, el
  repositorio de las páginas que ya existen. Si no hay espacio, no hace nada:
  nunca crea espacios.
- Toma solo lo nuevo desde la última revisión de esa sesión (los turnos de
  texto del usuario y del asistente) y se queda con el conocimiento durable del
  sistema; lo efímero se descarta.
- Un cambio a una página existente **nunca toca la página**: queda como
  propuesta en una rama `autodoc/<sesión>-<página>`.
- Una página nueva se crea directamente, colgada del padre que le corresponde
  en el árbol del espacio (en la raíz solo si el espacio está vacío), sin
  títulos repetidos ni secciones de backlog. Queda **pendiente de aprobar**: no
  sube a Confluence hasta `inkwell autodoc approve <pageId>` o hasta que una
  persona la reescriba completa con `page write` (una escritura por
  `--section` no basta).
- Antes de llamar al modelo reemplaza por `[REDACTED]` lo que parezca un
  secreto (llaves, tokens, contraseñas, credenciales en URLs, tarjetas), y
  descarta toda acción que todavía traiga uno, o que traiga imágenes, HTML o
  enlaces que no sean `http(s)`, relativos o `#ancla`.
- El agente corre con `runHeadless` de kit en modo de solo lectura (no
  necesita escribir: inkwell aplica las acciones que devuelve), en una carpeta
  temporal vacía y con un entorno mínimo. Claude, además, corre sin
  herramientas (`--disallowedTools Read,Grep,Glob`), sin MCP, sin los ajustes
  del usuario y con `CLAUDE_CODE_SAFE_MODE=1`. Recibe el árbol del
  espacio y el contenido (recortado) de las páginas que tienen que ver con la
  sesión. Un cambio a una página puede reescribir una sección, agregar una
  nueva después de otra, o reescribir la página completa.

No escribe nada en bita ni en las notas por entrada. Cada revisión deja una
línea, solo con metadatos y códigos, en `${XDG_DATA_HOME:-~/.local/share}/inkwell/autodoc.log`
(`%LOCALAPPDATA%\inkwell\autodoc.log` en Windows).

Las propuestas se revisan y se aceptan así:

```sh
inkwell autodoc ls                                  # ramas autodoc/* pendientes y páginas nuevas por aprobar
inkwell autodoc approve 12                          # la página nueva 12 ya puede subir a Confluence
inkwell branch diff autodoc/abcdef12-4              # qué cambiaría
inkwell branch apply autodoc/abcdef12-4 --commit <sha>
inkwell branch drop autodoc/abcdef12-4              # descartarla
```

Se configura en `~/.config/inkwell/config.json` (`%APPDATA%\inkwell\config.json`
en Windows); estos son los valores por omisión:

```json
{
  "autodoc": {
    "enabled": true,
    "agent": "claude",
    "model": null,
    "maxChars": 40000,
    "minChars": 600,
    "maxActions": 5,
    "timeoutSeconds": 240
  }
}
```

`agent` es uno de `claude`, `codex`, `gemini`, `antigravity` u `opencode`. Si
no está instalado se usa el primero que sí (Claude primero) y el log deja una
línea `warn:agent-fallback-<pedido>-to-<usado>`. `model` vacío deja `haiku` en
Claude y el modelo por omisión en los demás; un `model` propio no se pasa
cuando hubo fallback.

Para apagarlo, `"enabled": false`, o `INKWELL_NO_AUTODOC=1` en el entorno del
agente. `INKWELL_<AGENTE>_BIN` (`INKWELL_CLAUDE_BIN`, `INKWELL_CODEX_BIN`…)
cambia el binario de ese agente.

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
