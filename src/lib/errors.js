import { APIErrorCode, ClientErrorCode, isNotionClientError } from "@notionhq/client";

/** Raised when the AI call fails or answers something that isn't usable JSON. */
export class AIError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AIError";
  }
}

/**
 * Turns an error into something a person in Discord can act on. `target` names the
 * Notion database or page involved so the "not shared" hint points at the right one.
 */
export function describeError(error, { target = "la base de Notion" } = {}) {
  if (error instanceof AIError) return `🤖 ${error.message}`;

  if (isNotionClientError(error)) {
    switch (error.code) {
      case APIErrorCode.ObjectNotFound:
        return `🔒 Notion no encuentra ${target}. Comparte esa base con la integración del bot (··· → Conexiones).`;
      case APIErrorCode.RestrictedResource:
        return `🔒 La integración de Notion no tiene permiso para esta acción en ${target}. Revisa sus capacidades (leer, insertar contenido y comentarios).`;
      case APIErrorCode.Unauthorized:
        return "🔑 Notion rechazó la clave del bot. Revisa `NOTION_API_KEY`.";
      case APIErrorCode.ValidationError:
        return `⚠️ Notion rechazó los datos: ${error.message}\nProbablemente cambió el nombre de una propiedad u opción en ${target}.`;
      case APIErrorCode.RateLimited:
        return "⏳ Notion está limitando las peticiones. Intenta de nuevo en un minuto.";
      case APIErrorCode.ServiceUnavailable:
      case APIErrorCode.InternalServerError:
      case ClientErrorCode.RequestTimeout:
        return "🌩️ Notion no respondió a tiempo. Intenta de nuevo en unos minutos.";
      default:
        return `❌ Error de Notion (${error.code}): ${error.message}`;
    }
  }

  return `❌ Algo salió mal: ${error?.message ?? error}\n\nRevisa los logs del bot para más detalles.`;
}
