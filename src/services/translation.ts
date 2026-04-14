import OpenAI from 'openai';
import logger from '../lib/logger';

const log = logger.child({ module: 'translation' });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function translateMessage(content: string, targetLanguage: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
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
