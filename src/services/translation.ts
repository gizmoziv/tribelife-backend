import OpenAI from 'openai';
import logger from '../lib/logger';

const log = logger.child({ module: 'translation' });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function translateMessage(content: string, targetLanguage: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    // Messages can be up to 4000 chars (MESSAGE_MAX_LENGTH); some target languages need ~2-2.5k output tokens for that, so a lower cap would silently truncate and cache a cut translation.
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: `You are a translator. Translate the following message to ${targetLanguage}. Return ONLY the translated text, nothing else. If the text is already in ${targetLanguage}, return it unchanged.`,
      },
      { role: 'user', content },
    ],
  });

  const translated = response.choices[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error('Empty translation response');
  }

  log.info({ contentLength: content.length, targetLanguage }, 'Translated message');
  return translated;
}
