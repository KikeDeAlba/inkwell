# Diagramas

| Qué | Con qué |
|---|---|
| Flowchart, estados, un flujo de pocos pasos | **mermaid**, en un bloque ```` ```mermaid ```` dentro de la página |
| **Diagrama de secuencia, siempre** | **mermaid** (`sequenceDiagram`), sin excepción |
| Arquitectura, red, infraestructura, muchos grupos o iconos | **draw.io**, con el MCP de draw.io |

## draw.io

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

Para publicarlos en Confluence, ver [confluence.md](confluence.md).
