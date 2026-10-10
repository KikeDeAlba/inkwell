---
name: inkwell
description: >-
  Documenta el estado actual de un sistema con inkwell: páginas en markdown
  organizadas por espacio y con historia en git, backlog de pendientes y
  hallazgos, diagramas (mermaid y draw.io), exportación a PDF y sincronización
  con Confluence. Úsala cuando haya que crear, leer o actualizar documentación
  técnica, registrar algo que falta o que se descubrió, dibujar un diagrama,
  publicar en Confluence o sacar un PDF. Frases que la disparan: "documenta
  esto", "actualiza la página de", "crea una página para", "anota este
  pendiente", "registra el hallazgo", "cierra APT-14", "haz un diagrama de",
  "publícalo en Confluence", "sincroniza con Confluence", "exporta la página a
  PDF", "qué dice la documentación de". También lleva la nota de cada entrada
  de tiempo de bita mientras corre el cronómetro: "documenta lo que llevo",
  "anota esto en la nota de la entrada", "qué dice la nota de la entrada 42".
---

# inkwell

`inkwell` guarda la documentación técnica como **páginas** en markdown, una por
archivo, dentro de un repositorio git propio. Cada página cuelga de un
**espacio** (un sistema, un cliente, un producto) y puede tener subpáginas.
Todo comando acepta `--json` y responde con un sobre `{ ok, data, error }`.

Si bita está instalado, las páginas se atan a sus entradas de tiempo y cada
entrada tiene su **nota** (ver "Documentar mientras corre el cronómetro"); si
atl está instalado, inkwell publica y sincroniza con Confluence a través de él.

## Documentar mientras corre el cronómetro

Cada entrada de tiempo de bita tiene una **nota**: un markdown en el repositorio
de inkwell, en `<espacio>/<aaaa>/<mm>/<dd>-<id>-<título>.md`. La nota cuenta qué
pasó en ese bloque de trabajo; lo que debe sobrevivir al bloque va a una página.

inkwell la mantiene sola a partir de los eventos de bita: al arrancar el
cronómetro crea el esqueleto (Contexto, Qué se hizo, Pendiente), al corregir el
título o el proyecto la renombra o la mueve, al parar anota el fin y la
duración, al unir entradas junta sus notas en la que sobrevive, y al cancelar o
borrar la entrada la borra. Tú solo escribes el contenido.

Para saber en qué entrada escribir, corre `bita ls --json`: lista los
cronómetros que están corriendo; toma el `id` del que corresponde al trabajo
que estás haciendo (si solo hay uno, ese). Luego escribe sección por sección,
mandando el texto por stdin:

```
inkwell note save <entryId> --section "Contexto" --md - <<'MD'
Por qué se abrió este trabajo: el WAF bloquea /admin desde la VPN (VB-12).
MD
```

Qué va en cada sección:

- **Contexto**: por qué se hace, qué se pidió, el ticket o la conversación de
  origen y el estado en que estaba el sistema al empezar.
- **Qué se hizo**: los cambios concretos, en pasado y con nombres reales
  (archivos, recursos, comandos, ramas, MRs). Se actualiza en cada avance
  significativo reescribiendo la sección completa, no agregando renglones
  sueltos.
- **Pendiente**: lo que quedó abierto al cerrar el bloque. Si es trabajo que
  alguien más debe retomar, además va al backlog (`inkwell backlog add`).
- Opcionales, si hay material: **Decisiones** (qué se eligió y por qué),
  **Hallazgos** (lo que se descubrió), **Verificación** (cómo se comprobó) y
  **Tocado** (lo llenan `--file`, `--command` y `--resource`).

`--section` reemplaza esa sección entera; las demás quedan como están. Escribe
antes de parar el cronómetro, para que la nota quede completa cuando se cierre.

```
inkwell note show <entryId> --json          # la nota con sus secciones y su front matter
inkwell note get <entryId> --raw            # solo el markdown
inkwell note path <entryId> [--create]      # dónde vive (o dónde viviría)
inkwell note ls today                       # las notas de hoy (también week, month, --from/--to, --project)
inkwell note search "waf" [--project APT]   # buscar en las notas
```

`--entry <id>` sirve en lugar del id posicional. Las notas que bita escribió
antes se traen con `inkwell migrate notes --from-bita` (se puede repetir).

## Espacios

```
inkwell space ls
inkwell space add "<nombre>" [--key APT] [--confluence <url|CLAVE>] [--site <url>] [--pull on] [--push on]
inkwell space show <espacio>
inkwell space set <espacio> [--confluence <url|CLAVE>|none] [--site <url>|none] [--pull on|off] [--push on|off]
```

`--project` (o `--space`) acepta el nombre, la clave, el id del espacio o el id
del proyecto de bita del que se migró.

## La página

La unidad de documentación es la **página**, no el bloque de tiempo. Una página
cuenta **cómo está algo hoy**, en presente.

```
inkwell page new "<título>" --project <X> [--parent <id>]
inkwell page show <id>
inkwell page write <id> --md <archivo> [--section "<H2>"]
inkwell page link <id> --issue <KEY> --summary "…" --status "…" --status-category <cat>
inkwell page link <id> --entry <idDeBita>
inkwell tree
inkwell search "<texto>" [--project X]
```

**La ruta la da el CLI, nunca la inventes.** Pueden correr varias sesiones a la
vez sobre el mismo repositorio de documentación.

**No hay secciones obligatorias ni un orden fijo.** Los encabezados los pide el
contenido: si la página habla de credenciales, un encabezado será «Dónde viven»
y otro «Cómo llegan al contenedor». Como orientación y no como lista a rellenar,
suelen aparecer: qué es, cómo funciona, qué se decidió y sigue vigente, qué
límites tiene, cómo se verifica. Una sección con «N/A» es ruido: si no hay nada
que decir, no existe el encabezado.

**Cuando algo deja de ser cierto se reescribe, no se añade una corrección
debajo.** Una página que acumula «actualización: ya no es así» deja de servir
para lo que existe. Nada de entradas fechadas en el cuerpo.

**Una página es un documento formal del estado actual, y nada más.** Ni
«Pendiente», ni «Hallazgos», ni «Lo que falta», ni «Próximos pasos», ni
bitácora. `inkwell page write` avisa con `BACKLOG_SECTION_IN_PAGE` si aparece
una. Un límite conocido que es parte de cómo funciona el sistema hoy («el NAT
vive en una sola AZ») sí se describe en la página, como hecho; lo que alguien
tiene que hacer, no.

GFM plano, más tablas, bloques ```mermaid``` y bloques ```drawio``` (ver
«Diagramas»). Sin macros ni HTML. El H1 igual al título.

## Cómo se escribe

La página y lo que se publica en Confluence lo va a leer gente que no estuvo
aquí, meses después. Tiene que leerse como el trabajo de quien tiene asignada la
tarea. **Nada en el texto puede delatar que hubo una conversación, ni quién
pidió qué, ni que lo escribió un asistente.**

Si una de estas aparece, la frase está mal y se reescribe entera:

- **Quién lo pidió**: "por decisión del usuario", "a petición de", "según lo
  solicitado", "el usuario pidió / indicó / prefirió".
- **La conversación**: "en esta sesión", "como se comentó", "se validó con".
- **Primera persona de charla**: "decidimos", "acordamos", "vimos que".
- **Relleno**: "se procedió a", "se llevó a cabo", "cabe destacar".
- **Hedging**: "creo que", "parece que", "aparentemente", "al parecer".
- **El asistente**: "asistente", "IA", "agente", "generado automáticamente".
- **Reparto del trabajo** y **cualquier segunda persona**: "te toca", "tienes
  que", "lo dejo listo para que lo apliques".

Voz impersonal en pasado ("se migró") o sujeto técnico ("el worker reintenta
cinco veces"). Una afirmación es un hecho comprobable: si no se comprobó, no se
atenúa ni se escribe; va al backlog. Las decisiones se justifican por su razón
técnica, no por su origen. El resultado, no el camino.

| Así no | Así sí |
|---|---|
| Por decisión del usuario se fijó el tope en 8 horas. | El tope por tarea es de 8 horas: Jira rechaza worklogs mayores en una sola entrada. |
| Se procedió a la migración de la tabla de pagos. | La tabla de pagos se migró a `payments_v2`. |
| Creo que el problema era el token expirado. | El SDK devuelve 200 con cuerpo vacío cuando el token expiró; ese era el fallo. |

Antes de guardar, lee cada párrafo y pregunta: ¿lo escribiría alguien en su
bitácora técnica sin haber estado en la conversación? ¿Queda alguna palabra de
la lista? ¿Alguna frase le habla a alguien?

## Pendientes y hallazgos: el backlog

Lo que queda por hacer y lo que se descubrió de paso se registra **aparte**, en
el backlog de inkwell, **nunca en Jira** ni en el cuerpo de la página.

```
inkwell backlog add --kind pending --title "<qué falta, en una línea>" [--md <archivo>]
inkwell backlog add --kind finding --title "<el hecho, en una línea>" [--md <archivo>]
inkwell backlog ls [--project X] [--page <id>]
inkwell backlog resolve <CLAVE> --resolution "<cómo quedó>"
```

Cada ítem tiene una **clave** corta: la clave del espacio y un correlativo, como
`APT-14`. Cuando se pide «cierra APT-14», es `inkwell backlog resolve APT-14
--resolution "<cómo quedó>"`. Esas claves **no son issues de Jira** aunque se
parezcan: nunca se buscan ni se cierran en Jira.

Sin `--page` ni `--project`, el ítem cuelga del cronómetro de bita que corre y de
su página. El título es una frase que se entiende sola en una lista con otros
espacios; el detalle, en `--md`.

- **Pendiente** es trabajo que falta y alguien tiene que hacer.
- **Hallazgo** es algo que se descubrió y merece atención aunque no sea parte
  del trabajo en curso.

Antes de proponer un ítem nuevo, mira `inkwell backlog ls --page <id>`: si ya
está, no se duplica. Las páginas viejas que todavía traen esas secciones se
limpian con `inkwell backlog extract --page <id>` (primero con `--dry-run`).

## Subpáginas

Cuando una página pasa de unas **seis secciones**, o una sección tiene su propio
árbol de `###`, o describe un subsistema que se entiende solo, **pártela**: el
padre queda como visión general con un párrafo por hija, y cada parte es una
página hija con `inkwell page new "<título>" --parent <id>`. `page write` avisa
con `PAGE_SHOULD_SPLIT`. Hasta cinco niveles de profundidad.

## Diagramas

| Qué | Con qué |
|---|---|
| Flowchart, estados, un flujo de pocos pasos | **mermaid**, en un bloque ```` ```mermaid ```` dentro de la página |
| **Diagrama de secuencia, siempre** | **mermaid** (`sequenceDiagram`), sin excepción |
| Arquitectura, red, infraestructura, muchos grupos o iconos | **draw.io**, con el MCP de draw.io |

Un diagrama de draw.io es un archivo `.drawio` junto a la página:

```
inkwell page asset path <pageId> <nombre>.drawio --create   la ruta donde va el XML
inkwell diagrams render <pageId>                          PNG 2x de cada diagrama
inkwell diagrams ls <pageId>                              qué hay y si su render está al día
```

1. Escribe el XML de draw.io en la ruta que dio el CLI.
2. Ábrelo con el MCP de draw.io para revisarlo; si se corrige ahí, guarda el
   resultado en el mismo archivo.
3. En la página, donde va el diagrama, un bloque con el nombre del archivo:

   ````
   ```drawio
   <nombre>.drawio
   ```
   ````

4. `inkwell diagrams render <pageId>`. Sin draw.io Desktop falla con
   `DRAWIO_MISSING` y trae la pista de instalación.

## Enlaces

Lo que se consultó fuera del repo —páginas de Confluence, issues de Jira, hojas
de cálculo— queda atado a la página:

```
inkwell page ref add <id> --url <URL> --title "<qué es>" [--kind confluence|jira|drive|link]
```

## Historia y propuestas

Cada escritura es un commit en el repositorio de documentación.

```
inkwell page history <id>
inkwell page diff <id> [sha]
inkwell page restore <id> <sha>
inkwell git status | git commit
inkwell git propose <id> --branch <rama> --reason "<por qué>" --md <archivo> [--section "<H2>"]
inkwell branch ls | diff <rama> | apply <rama> --commit <sha> | drop <rama>
```

Una propuesta (por ejemplo, lo que salió de una reunión) va a una rama sin tocar
la página; se aplica después con `branch apply`.

## Publicar en Confluence

Se publica **el estado actual**, como documento formal. Nada de pendientes,
hallazgos, bitácora ni próximos pasos.

- **El árbol se refleja.** Una página con hijas es una página de Confluence con
  subpáginas, en el mismo orden. Si la página todavía es monolítica, pártela
  primero.
- **La página raíz es un índice con contexto**: qué es el sistema, para quién y
  un párrafo por subpágina. No repite lo que dicen las hijas.
- **Cada subpágina se lee sola.**
- **Diagramas: siempre como imagen, nunca como código.**
  1. Crea o actualiza la página con el texto, dejando en cada diagrama un
     párrafo marcador (`DIAGRAMA-1`, `DIAGRAMA-2`…) en el orden de la página.
  2. `inkwell confluence publish-diagrams <pageId> --to <id de Confluence> --json`
     renderiza lo que haga falta y sube cada diagrama como PNG 2x más su fuente.
     Devuelve los diagramas en orden, cada uno con su fragmento `adf` y
     `storage` listo.
  3. Sustituye cada marcador por el fragmento del diagrama con el mismo `index`
     y vuelve a leer la página para confirmar que no quedó ninguno.

La sincronización de un espacio entero con Confluence:

```
inkwell confluence sync <espacio> [--dry-run]
inkwell confluence status <espacio>
inkwell confluence conflict ls | resolve <pageId> --keep local|remote|both
```

Todo pasa por atl. Si falla con `ATL_MISSING`, pide al usuario que instale atl
(`npm install -g @kikedealba/atl && atl setup`) y agregue su sitio con
`atl site add`; el token no lo escribes tú.

## PDF

```
inkwell export page <pageId> [--out archivo.pdf]
inkwell export meeting --bita-entry <id> [--out archivo.pdf]
```

Usa Chrome (o otro navegador Chromium) en modo headless. Sin él falla con
`CHROME_MISSING` y trae la pista de instalación.

## Manejo de fallos

- `PROJECT_NOT_FOUND`: el espacio no existe; `inkwell space ls` y, si hace
  falta, `inkwell space add`.
- `BITA_MISSING`: bita no está instalado; las páginas siguen funcionando, solo
  faltan los datos de las entradas.
- `DOCS_LOCKED` / `DOCS_GIT_LOCKED`: otra sesión escribe; reintenta en unos
  segundos.
- `MERGE_CONFLICT` al aplicar una propuesta: la página cambió después; propón de
  nuevo sobre la versión actual.
