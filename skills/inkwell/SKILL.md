---
name: inkwell
description: >-
  Documentación técnica con inkwell: páginas en git, backlog, diagramas,
  Confluence y notas de entradas de bita. Frases: "documenta esto", "anota este
  pendiente", "haz un diagrama de", "publícalo en Confluence".
---

# inkwell

`inkwell` guarda la documentación técnica como **páginas** en markdown, una por
archivo, dentro de un repositorio git propio. Cada página cuelga de un
**espacio** (un sistema, un cliente, un producto) y puede tener subpáginas.
Todo comando acepta `--json` y responde con un sobre `{ ok, data, error }`.

Quién hace qué: bita lleva el tiempo, inkwell documenta, tally vuelca las horas
a Jira, atl habla con Jira y Confluence, y recap graba reuniones.

## Guías de apoyo

Léelas solo cuando la tarea las pida:

| Archivo | Cuándo |
|---|---|
| [writing.md](writing.md) | **Antes de escribir** cualquier texto que vaya a leer otra persona: páginas, notas, Confluence, Jira. Es la fuente única de las reglas de redacción. |
| [entry-notes.md](entry-notes.md) | Para escribir o leer la nota de una entrada de bita. |
| [diagrams.md](diagrams.md) | Para dibujar un diagrama (mermaid o draw.io). |
| [confluence.md](confluence.md) | Para publicar o sincronizar con Confluence. |

Fuera de esta skill, el mismo texto sale con `inkwell guide <writing|entry-notes|diagrams|confluence>`.

## Leer sin gastar contexto

Para leer, pide siempre la forma corta:

```
inkwell page show <id> --brief --json             # el markdown y los identificadores, sin metadatos
inkwell page show <id> --section "<H2>" --json    # solo una sección
inkwell note show <entryId> --brief --json
inkwell note show <entryId> --section "Qué se hizo" --json
```

`--brief` devuelve `markdown` (sin front matter) y `sections` (los H2). Usa
`page show` completo (sin `--brief`) solo cuando necesites las entradas,
issues, enlaces o el backlog de la página.

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
inkwell page write <id> --md <archivo> [--section "<H2>"]
inkwell page link <id> --issue <KEY> --summary "…" --status "…" --status-category <cat>
inkwell page link <id> --entry <idDeBita>
inkwell page ref add <id> --url <URL> --title "<qué es>" [--kind confluence|jira|drive|link]
inkwell tree
inkwell search "<texto>" [--project X]
```

- **La ruta la da el CLI, nunca la inventes.** Pueden correr varias sesiones a
  la vez sobre el mismo repositorio de documentación.
- **No hay secciones obligatorias ni un orden fijo.** Los encabezados los pide
  el contenido. Suelen aparecer, como orientación y no como lista a rellenar:
  qué es, cómo funciona, qué se decidió y sigue vigente, qué límites tiene,
  cómo se verifica. Una sección con «N/A» es ruido: si no hay nada que decir,
  no existe el encabezado.
- **Cuando algo deja de ser cierto se reescribe**, no se añade una corrección
  debajo. Nada de entradas fechadas en el cuerpo.
- **Una página es un documento formal del estado actual, y nada más.** Ni
  «Pendiente», ni «Hallazgos», ni «Próximos pasos», ni bitácora: eso va al
  backlog. `page write` avisa con `BACKLOG_SECTION_IN_PAGE`. Un límite conocido
  que es parte de cómo funciona el sistema hoy sí se describe, como hecho.
- Lo que se consultó fuera del repo (Confluence, Jira, hojas de cálculo) queda
  atado con `page ref add`.
- GFM plano, más tablas, bloques ```` ```mermaid ```` y ```` ```drawio ````
  (ver [diagrams.md](diagrams.md)). Sin macros ni HTML. El H1 igual al título.

## Subpáginas

Cuando una página pasa de unas **seis secciones**, o una sección tiene su propio
árbol de `###`, o describe un subsistema que se entiende solo, **pártela**: el
padre queda como visión general con un párrafo por hija, y cada parte es una
página hija con `inkwell page new "<título>" --parent <id>`. `page write` avisa
con `PAGE_SHOULD_SPLIT`. Hasta cinco niveles de profundidad.

## Pendientes y hallazgos: el backlog

Lo que queda por hacer y lo que se descubrió de paso se registra **aparte**, en
el backlog de inkwell, **nunca en Jira** ni en el cuerpo de la página.

```
inkwell backlog add --kind pending --title "<qué falta, en una línea>" [--md <archivo>]
inkwell backlog add --kind finding --title "<el hecho, en una línea>" [--md <archivo>]
inkwell backlog ls [--project X] [--page <id>]
inkwell backlog resolve <CLAVE> --resolution "<cómo quedó>"
```

- Cada ítem tiene una **clave** corta, como `APT-14`. «Cierra APT-14» es
  `inkwell backlog resolve APT-14 --resolution "<cómo quedó>"`. Esas claves
  **no son issues de Jira**: nunca se buscan ni se cierran en Jira.
- Sin `--page` ni `--project`, el ítem cuelga del cronómetro de bita que corre y
  de su página. El título se entiende solo en una lista; el detalle, en `--md`.
- **Pendiente** es trabajo que alguien tiene que hacer. **Hallazgo** es algo que
  se descubrió y merece atención aunque no sea parte del trabajo en curso.
- Antes de agregar, mira `inkwell backlog ls --page <id>`: no se duplica. Las
  páginas viejas con esas secciones se limpian con
  `inkwell backlog extract --page <id>` (primero con `--dry-run`).

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
Las propuestas `autodoc/*` salen solas al cerrar una sesión de Claude Code: se
listan con `inkwell autodoc ls` y se revisan con `branch diff` y `branch apply`.
Las páginas nuevas del autodoc no suben a Confluence hasta
`inkwell autodoc approve <id>`.

## PDF

```
inkwell export page <pageId> [--out archivo.pdf]
inkwell export meeting --bita-entry <id> [--out archivo.pdf]
```

Usa Chrome (u otro Chromium) en modo headless. Sin él falla con
`CHROME_MISSING` y trae la pista de instalación.

## Manejo de fallos

- `PROJECT_NOT_FOUND`: el espacio no existe; `inkwell space ls` y, si hace
  falta, `inkwell space add`.
- `SECTION_NOT_FOUND`: la sección pedida con `--section` no existe; la pista
  trae las que hay.
- `DOC_MISSING`: el registro existe pero el archivo no; `page show <id>` (sin
  `--brief`) trae el estado del archivo.
- `BITA_MISSING`: bita no está instalado; las páginas siguen funcionando, solo
  faltan los datos de las entradas.
- `ATL_MISSING`: ver [confluence.md](confluence.md).
- `DOCS_LOCKED` / `DOCS_GIT_LOCKED`: otra sesión escribe; reintenta en unos
  segundos.
- `MERGE_CONFLICT` al aplicar una propuesta: la página cambió después; propón de
  nuevo sobre la versión actual.
