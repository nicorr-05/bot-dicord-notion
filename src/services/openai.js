import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Analyzes a Discord thread and extracts structured bug ticket data.
 * @param {string} threadTitle - The name of the Discord thread.
 * @param {Array<{author: string, content: string}>} messages - Thread messages.
 * @returns {Promise<{title: string, description: string, priority: string, stepsToReproduce: string}>}
 */
export async function analyzeThread(threadTitle, messages) {
  const conversation = messages
    .map((m) => `[${m.author}]: ${m.content}`)
    .join("\n");

  const prompt = `
You are a QA engineer. Analyze the following Discord bug-report thread and extract structured information to create a Notion ticket.

Thread title: "${threadTitle}"

Messages:
${conversation}

Return a JSON object with exactly these fields:
- "title": A concise, clear bug title (max 80 chars). Keep it in the same language as the thread.
- "description": A clear summary of the bug, what happens vs what should happen (2-4 sentences). Same language as the thread.
- "priority": One of exactly: "High", "Low", "Urgent" — based on the severity discussed.
- "stepsToReproduce": A numbered list of steps to reproduce the bug, extracted from the discussion. If not clear, write "Not specified". Same language as thread.

Respond ONLY with valid JSON, no markdown, no extra text.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content);
  return result;
}
