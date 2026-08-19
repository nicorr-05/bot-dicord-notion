# Mensajes de Discord — Cómo reportar bugs

Copia cada bloque **desde este archivo en el editor** (no desde la terminal: se
rompen los acentos y emojis). Van como **dos mensajes separados** en `#bug-reports`,
los dos fijados. Cada uno cabe en el límite de 2000 caracteres de Discord.

---

## Mensaje 1 — el flujo

```
# 🐞 Cómo reportar bugs

Ya tenemos bot: tú cuentas el bug en un hilo y él arma el ticket en Notion. **No abras tickets a mano.**

## 1️⃣ Abre un hilo en #bug-reports
El **nombre del hilo es el título del bug**. Sé concreto:
✅ `No se guardan los cambios en Historia clínica`
❌ `bug`, `no funciona`, `ayuda`

## 2️⃣ Cuenta qué pasó (dentro del hilo)
Con estos 3 puntos ya es suficiente:
> **Qué esperabas** que pasara
> **Qué pasó** en realidad
> **Pasos** para reproducirlo — 1, 2, 3...

Escribe normal, no hace falta formato. Pueden opinar varios en el hilo, el bot lee **todo**.

## 3️⃣ Suelta la evidencia en el hilo
Capturas, videos, logs. Se suben solos al ticket como **Evidence**. Un video de 10s vale más que tres párrafos.

## 4️⃣ Escribe `/ticket`
La IA lee el hilo completo y te muestra un resumen para revisar.

## 5️⃣ Revisa y dale a ✅ Create Ticket
Puedes ajustar antes de confirmar:
- **Priority** — la IA propone una, cámbiala si no cuadra
- **Sprint** — por defecto **Backlog**. Solo mételo a `Sprint 1 — Current` si es urgente y va ahora
- **Assignee** — por defecto **Nicolás**, que lo reparte

-# Tienes 2 min para confirmar. Si se pasa, no se pierde nada: vuelve a escribir `/ticket`.
```

---

## Mensaje 2 — las trampas

```
## ⚠️ 4 cosas que se nos van a olvidar

**1. Escribe todo ANTES de lanzar `/ticket`**
El bot solo lee lo que ya está en el hilo. Si añades info después, no entra en el ticket.

**2. `/ticket` solo funciona dentro de un hilo de #bug-reports**
En el canal suelto o en otro canal te va a rebotar.

**3. Los menús solo los toca quien lanzó el comando**
Si te equivocas, dale a ❌ Cancel y vuelve a empezar. No pasa nada.

**4. Esto es solo para bugs 🐞**
Todo lo que entra por aquí se marca como **Bug** en Notion. Ideas y mejoras (💬 Feature request) no van por este canal.

-# El ticket se crea en `Tasks Tracker Especialistas` con estado **Not started** y el link al hilo, así que siempre se puede volver a la conversación original.
```

---

## Si se vuelven a romper los acentos

Es un problema de copiado, no del texto. Opciones:

- Copia desde el editor (VS Code, etc.) con este archivo abierto — es UTF-8.
- O mándalo al portapapeles ya codificado:

  ```
  sed -n '/^## Mensaje 1/,/^---$/p' docs/mensaje-discord-bugs.md | sed -n '/^```$/,/^```$/p' | sed '1d;$d' | pbcopy
  ```

- Si tu terminal muestra `Ã­` en vez de `í`, revisa que tenga UTF-8:
  `export LANG=es_ES.UTF-8`
