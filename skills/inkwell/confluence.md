# Publicar en Confluence

Todo pasa por atl, el único camino a Confluence. Si falla con `ATL_MISSING`,
pide instalar atl (`npm install -g @kikedealba/atl && atl setup`) y agregar el
sitio con `atl site add`; el token no lo escribes tú.

Se publica **el estado actual**, como documento formal, con las reglas de
[writing.md](writing.md). Nada de pendientes, hallazgos, bitácora ni próximos
pasos.

- **El árbol se refleja.** Una página con hijas es una página de Confluence con
  subpáginas, en el mismo orden. Si la página todavía es monolítica, pártela
  primero.
- **La página raíz es un índice con contexto**: qué es el sistema, para quién y
  un párrafo por subpágina. No repite lo que dicen las hijas.
- **Cada subpágina se lee sola.**

## Diagramas: siempre como imagen, nunca como código

1. Crea o actualiza la página con el texto, dejando en cada diagrama un párrafo
   marcador (`DIAGRAMA-1`, `DIAGRAMA-2`…) en el orden de la página.
2. `inkwell confluence publish-diagrams <pageId> --to <id de Confluence> --json`
   renderiza lo que haga falta y sube cada diagrama como PNG 2x más su fuente.
   Devuelve los diagramas en orden, cada uno con su fragmento `adf` y `storage`
   listo.
3. Sustituye cada marcador por el fragmento con el mismo `index` y vuelve a leer
   la página para confirmar que no quedó ninguno.

## Sincronizar un espacio entero

```
inkwell confluence sync <espacio> [--dry-run]
inkwell confluence status <espacio>
inkwell confluence conflict ls | resolve <pageId> --keep local|remote|both
```
