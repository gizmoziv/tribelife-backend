import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getLinkPreview } from '../services/linkPreview';

const router = Router();
router.use(requireAuth);

// `url` must be a syntactically-valid http/https URL within a sane length. The
// SSRF guard does the real network-level vetting at fetch time; this is just
// input hygiene so a malformed/missing param is the ONLY 400 path.
const querySchema = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (raw) => {
        try {
          const u = new URL(raw);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'url must be a valid http(s) URL' },
    ),
});

// GET /api/link-preview?url=<encoded-url>
// Returns { preview: Preview | null }. A failed/blocked/non-HTML/metadata-less
// fetch is NOT an error — it returns 200 { preview: null }. Only a malformed or
// missing `url` param yields 400.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = querySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const preview = await getLinkPreview(parse.data.url);
  res.json({ preview });
});

export default router;
