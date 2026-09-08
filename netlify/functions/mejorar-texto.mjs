import Anthropic from "@anthropic-ai/sdk";

/**
 * Redacta con Claude el texto que el técnico dictó en campo.
 *
 * El generador de informes llama a esta función desde el botón "Mejorar".
 * Si no está publicada, o si falta la clave, la aplicación se da cuenta sola
 * y usa su corrector local, así que nunca se queda sin la función.
 *
 * Para activarla:
 *   1. Define la variable de entorno ANTHROPIC_API_KEY en Netlify
 *      (Site configuration -> Environment variables).
 *   2. Publica el sitio desde Git: Netlify instala las dependencias del
 *      package.json de la raíz y despliega esta función automáticamente.
 *
 * Queda publicada en /.netlify/functions/mejorar-texto
 */

const MODELO = "claude-opus-5";
const LIMITE_CARACTERES = 6000;

const INSTRUCCIONES = `Eres el redactor técnico de SmartEnergy, una empresa de instalación y
mantenimiento de plantas solares fotovoltaicas en Colombia.

Recibes un texto que un técnico dictó por voz mientras trabajaba en sitio, para
un informe de operación y mantenimiento (O&M). Viene desordenado: sin puntuación,
con muletillas, en primera persona y con lenguaje coloquial de obra.

Reescríbelo para el informe siguiendo estas reglas:
- Español de Colombia, registro técnico y formal.
- Impersonal: "se revisó", "se encontró", nunca "revisé" ni "revisamos".
- Quita muletillas y repeticiones; ordena las ideas en frases completas.
- Usa el vocabulario del sector: módulos fotovoltaicos, inversores, strings,
  interruptores termomagnéticos, puesta a tierra, tablero de protecciones.
- Normaliza las unidades: V, A, kW, kWh, Ω, °C, %.
- NO inventes datos, mediciones, marcas ni conclusiones que no estén en el texto.
  Si algo quedó ambiguo, mantenlo igual de general.
- Conserva todas las cifras exactamente como las dictó el técnico.
- Extensión parecida a la del original; no lo resumas ni lo infles.

Responde ÚNICAMENTE con el texto corregido, sin comillas, sin encabezados y sin
comentarios sobre lo que cambiaste.`;

export default async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Usa POST" }, { status: 405 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // La aplicación interpreta cualquier error como "no disponible" y pasa al
    // corrector local, así que basta con avisar.
    return Response.json(
      { error: "Falta la variable de entorno ANTHROPIC_API_KEY" },
      { status: 503 },
    );
  }

  let cuerpo;
  try {
    cuerpo = await request.json();
  } catch {
    return Response.json({ error: "El cuerpo debe ser JSON" }, { status: 400 });
  }

  const texto = typeof cuerpo?.texto === "string" ? cuerpo.texto.trim() : "";
  const contexto =
    typeof cuerpo?.contexto === "string" ? cuerpo.contexto.trim() : "";

  if (!texto) {
    return Response.json({ error: "No llegó ningún texto" }, { status: 400 });
  }
  if (texto.length > LIMITE_CARACTERES) {
    return Response.json(
      { error: `El texto supera los ${LIMITE_CARACTERES} caracteres` },
      { status: 413 },
    );
  }

  const client = new Anthropic();

  try {
    const respuesta = await client.messages.create({
      model: MODELO,
      max_tokens: 4000,
      system: INSTRUCCIONES,
      // Tarea corta y acotada: no necesita razonamiento profundo.
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content:
            (contexto ? `Sección del informe: ${contexto}\n\n` : "") +
            `Texto dictado:\n${texto}`,
        },
      ],
    });

    if (respuesta.stop_reason === "refusal") {
      return Response.json(
        { error: "El modelo no pudo procesar este texto" },
        { status: 422 },
      );
    }

    const mejorado = respuesta.content
      .filter((bloque) => bloque.type === "text")
      .map((bloque) => bloque.text)
      .join("")
      .trim();

    if (!mejorado) {
      return Response.json({ error: "Respuesta vacía" }, { status: 502 });
    }

    return Response.json({ texto: mejorado });
  } catch (error) {
    console.error("Error llamando a la API de Claude:", error);
    const status = typeof error?.status === "number" ? error.status : 502;
    return Response.json(
      { error: error?.message || "No se pudo contactar al servicio" },
      { status },
    );
  }
};
