# Cómo se escribe

Fuente única de las reglas de redacción para todo texto que vaya a leer otra
persona: páginas y notas de inkwell, lo que se publica en Confluence, y las
descripciones, comentarios y worklogs de Jira que escriben tally o atl.

Ese texto lo va a leer gente que no estuvo aquí, meses después. Tiene que leerse
como el trabajo de quien tiene asignada la tarea. **Nada en el texto puede
delatar que hubo una conversación, ni quién pidió qué, ni que lo escribió un
asistente.**

## Frases prohibidas

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

## Tono

- Voz impersonal en pasado ("se migró") o sujeto técnico ("el worker reintenta
  cinco veces").
- Una afirmación es un hecho comprobable: si no se comprobó, no se atenúa ni se
  escribe; va al backlog (`inkwell backlog add`).
- Las decisiones se justifican por su razón técnica, no por su origen.
- El resultado, no el camino.
- Nombres reales: archivos, recursos, comandos, ramas, MRs, tickets.

## Así no / así sí

| Así no | Así sí |
|---|---|
| Por decisión del usuario se fijó el tope en 8 horas. | El tope por tarea es de 8 horas: Jira rechaza worklogs mayores en una sola entrada. |
| Se procedió a la migración de la tabla de pagos. | La tabla de pagos se migró a `payments_v2`. |
| Creo que el problema era el token expirado. | El SDK devuelve 200 con cuerpo vacío cuando el token expiró; ese era el fallo. |
| Como se comentó en la sesión, se agregó el índice. | Se agregó el índice `idx_orders_created_at`: la consulta del reporte bajó de 4 s a 80 ms. |
| Te dejo lista la rama para que la mezcles. | La rama `feature/waf-admin` está lista para revisión (MR !42). |

## Antes de guardar

Lee cada párrafo y pregunta:

1. ¿Lo escribiría alguien en su bitácora técnica sin haber estado en la
   conversación?
2. ¿Queda alguna palabra de la lista?
3. ¿Alguna frase le habla a alguien?
