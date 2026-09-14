# Canal de releases

Cuando un ticket llega a **Done** en Notion pasan dos cosas independientes:

1. El bot avisa **en el hilo original** de `#bug-reports` a quien lo reportó
   (esto ya existía).
2. El bot publica el cambio **en `#releases`**, con un resumen en lenguaje de
   usuario y el video, si el ticket tiene uno.

Los viernes a las **3:30 PM (hora de Venezuela)** sale además un resumen semanal
en el mismo canal con todo lo que se cerró.

---

## Lo único que pones a mano es el video

Todo lo demás lo escribe la IA a partir del ticket: el titular, el resumen y los
detalles. No hay ningún campo de texto que tengas que rellenar.

## Cómo poner el video de un release

En la base *Tasks Tracker Especialistas*, la columna **`Video release`**. Pese al
nombre, **también acepta imágenes**: una captura sirve perfectamente cuando el
cambio se ve de un vistazo y no hace falta grabar nada.

| Qué pones ahí | Qué sale en Discord |
|---|---|
| Video subido a Notion (`.mp4`, `.mov`, `.webm`, `.m4v`) | Se re-sube a Discord y se reproduce dentro del mensaje |
| Imagen subida a Notion (`.png`, `.jpg`, `.gif`, `.webp`) | Se muestra **dentro de la tarjeta** del release |
| Link de Loom, YouTube, Vimeo, Drive o Streamable | Previsualización con botón de play |
| Link directo a una imagen | Se muestra dentro de la tarjeta, sin descargarla |

El tipo se detecta por el `content-type` que devuelve el servidor y, si no lo
dice, por la extensión del nombre. Un archivo subido a Notion llega por una URL
firmada sin extensión, así que el `content-type` es lo que salva el caso.

**Ojo con el peso.** Discord limita lo que se puede subir según el nivel de boost
del servidor: 10 MB sin boost (el caso de DocGuía hoy), 50 MB en nivel 2, 100 MB
en nivel 3. Si el archivo que subiste a Notion pasa del límite, el release sale
igual pero **sin él**, y queda un aviso en los logs. Para clips largos usa Loom y
pega el link: no pesa nada y siempre funciona. Las capturas nunca dan problema.

Un link de Notion no sirve como alternativa: Notion firma las URLs de los
archivos que aloja y expiran en una hora, así que el bot nunca las publica.

## No importa en qué orden lo hagas

El bot no anuncia un ticket hasta que lleve **10 minutos sin tocarse**. Da igual
si marcas Done y subes el video después, o al revés: el anuncio recoge lo que
haya cuando el ticket se queda quieto.

Eso también te da margen para corregir un título o una descripción antes de que
salga publicado a todo el servidor. El reloj se reinicia con cada edición.

Se ajusta con `RELEASES_QUIET_MINUTES` (0 = anunciar en la siguiente pasada).

---

## Qué se publica y qué no

Se publica todo lo que llegue a Done **menos los `🔧 Chore`** — trabajo interno
que a nadie fuera del equipo le dice nada.

| Task type | ¿Sale en `#releases`? | Cómo se anuncia |
|---|---|---|
| `💬 Feature request` | Sí | «Nuevo: …» |
| `🐞 Bug` | Sí | «Arreglado: …» |
| `💅 Polish` | Sí | «Mejorado: …» |
| `🔧 Chore` | No | — |

Cada mensaje etiqueta a **quién lo reportó** (el Reporter de Notion) y a **quién
lo resolvió** (el Assignee). Son etiquetas de verdad, clicables, pero **no
notifican a nadie**: una mención dentro de un embed se ve como tag y no dispara
ping. Quien reportó ya recibe su aviso en su propio hilo de `#bug-reports`, y no
tiene por qué recibir un segundo desde un canal de difusión.

Para que la etiqueta salga hay que tener a esa persona en
`src/config/user-links.js`, que es la tabla Discord ↔ Notion. Si no está, el bot
la busca por nombre en el servidor y, si tampoco la encuentra, muestra el nombre
en texto plano en vez de arriesgarse a etiquetar a otra persona.

El resumen lo escribe la IA a partir del título, la descripción y el contenido de
la página del ticket. Tiene instrucción explícita de **no nombrar personas,
consultorios ni pacientes**, porque `#releases` es público y los reportes de bugs
suelen traer nombres. Si la IA falla, el bot publica igual usando el texto de
«Task description» del ticket.

Si un resumen no te gusta, edita el ticket en Notion, desmarca **`Release
publicado`** y en la siguiente pasada (máximo 5 minutos) se vuelve a publicar.

---

## Columnas que crea el bot

Las crea solo, la primera vez que arranca con esta versión:

- **`Video release`** (archivos) — el video, subido o como link.
- **`Release publicado`** (casilla) — control interno, para no anunciar dos veces.
- **`Release Discord`** (URL) — link al mensaje que se publicó, y lo que usa el
  resumen semanal para que cada entrada lleve a su video.
- **`Release resumen`** (texto) — **la escribe el bot, no tú.** Es la copia que
  la IA generó y que se publicó: primera línea el titular, el resto el resumen.
  El resumen semanal la reutiliza, así que el viernes no se vuelve a pagar por lo
  mismo y la redacción coincide con la del mensaje de release.

> **La primera vez**, todos los tickets que ya estaban en Done se marcan como
> publicados automáticamente. Si no fuera así, encender esto vaciaría meses de
> historial en el canal de una sola vez.

---

## Resumen semanal

Sale los viernes a las 3:30 PM y cubre los **7 días que terminan ese viernes**
(sábado a viernes), así que no queda ningún día fuera entre un resumen y el
siguiente.

Cada ticket aparece con su nombre, un resumen corto, la etiqueta de quién lo hizo
(el **Assignee** de Notion) y un enlace a su mensaje de release — con 🎥 cuando trae
video. Va agrupado por tipo: primero las novedades, luego los arreglos y las
mejoras. Si la semana estuvo vacía lo dice, en vez de no publicar nada.

El nombre que se muestra es el titular en lenguaje de usuario, el mismo del
mensaje de release, no el título interno del ticket: «Iniciar sesión en DocGuía
ahora funciona correctamente» en vez de «Bug iniciar sesión».

Si una semana cierra muchos tickets, el resumen muestra los primeros 20 y remata
con «…y N cambios más», para no pasarse de los límites de Discord.

Si el bot estaba caído el viernes a esa hora, al arrancar publica el resumen
pendiente — siempre que hayan pasado menos de 24 horas y no lo haya publicado ya.
Para saberlo mira el propio canal, así que no hay forma de que salga dos veces.

---

## Configuración

Todo es opcional excepto el canal, y el canal solo si no se llama `releases`:

```bash
DISCORD_RELEASES_CHANNEL_ID=        # vacío -> busca el canal llamado "releases"
DISCORD_RELEASES_CHANNEL_NAME=releases

WEEKLY_DIGEST_ENABLED=true
WEEKLY_DIGEST_WEEKDAY=Fri           # acepta "viernes", "Fri" o "5"
WEEKLY_DIGEST_TIME=15:30
WEEKLY_DIGEST_TIMEZONE=America/Caracas

RELEASES_MAX_PER_POLL=20            # válvula de seguridad, ver abajo
NOTION_POLL_INTERVAL_MINUTES=5      # compartido con el watcher de #bug-reports
```

**`RELEASES_MAX_PER_POLL`**: si una pasada encuentra más tickets sin anunciar que
este número, el bot no publica nada y lo dice en los logs. Es para el caso en que
alguien arrastra medio backlog a Done de golpe, o el back-fill inicial se quedó a
medias: en vez de soltar 60 mensajes seguidos, se detiene y te deja decidir.

---

## Permisos que necesita el bot en `#releases`

- Ver el canal
- Enviar mensajes
- Insertar enlaces
- Adjuntar archivos ← sin esto los videos no se suben
- Leer el historial ← sin esto no sabe si ya publicó el resumen de la semana
