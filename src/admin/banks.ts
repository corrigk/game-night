/** Prompt banks editable from /admin. Each maps to a host-only content table. */
export interface BankField {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'select' | 'tags';
  options?: string[];
  required?: boolean;
  /** Hidden until "show answers" is toggled (the host plays too). */
  secret?: boolean;
  placeholder?: string;
}

export interface Bank {
  table: string;
  label: string;
  help: string;
  fields: BankField[];
}

export const BANKS: Bank[] = [
  {
    table: 'most_likely_prompts',
    label: 'Most Likely To',
    help: 'Write the full prompt, e.g. "Most likely to forget their own birthday".',
    fields: [{ key: 'text', label: 'Prompt', required: true, placeholder: 'Most likely to forget their own birthday' }],
  },
  {
    table: 'facts',
    label: 'Weird Facts',
    help: 'Write the fact with ___ (or ____) where the blank goes. "short" answers are ~30 chars, "phrase" ~80.',
    fields: [
      { key: 'prompt', label: 'Fact', type: 'textarea', required: true, placeholder: 'Sea otters hold ___ while they sleep.' },
      { key: 'answer', label: 'Real answer', required: true, secret: true, placeholder: 'hands' },
      { key: 'aliases', label: 'Also accept (comma separated)', type: 'tags', secret: true, placeholder: 'hand, their hands' },
      { key: 'blurb', label: 'Blurb', type: 'textarea', secret: true, placeholder: 'So they don’t drift apart.' },
      { key: 'kind', label: 'Kind', type: 'select', options: ['short', 'phrase'] },
    ],
  },
  {
    table: 'caption_cards',
    label: 'Caption cards',
    help: 'Pre-written captions dealt into players’ hands.',
    fields: [{ key: 'text', label: 'Caption', required: true, placeholder: 'When the group chat goes quiet' }],
  },
  {
    table: 'story_seeds',
    label: 'Story seeds',
    help: 'A genre plus an opening line. Each player starts one story.',
    fields: [
      { key: 'genre', label: 'Genre', required: true, placeholder: 'Space opera' },
      { key: 'opening_line', label: 'Opening line', type: 'textarea', required: true, placeholder: 'The captain had never seen a cow in orbit.' },
    ],
  },
  {
    table: 'zillow_prompts',
    label: 'Zillow prompts',
    help: 'wildcard: just a location. filter: location + a list of filters. weird: the challenge goes in Filters (e.g. "Most haunted-looking house").',
    fields: [
      { key: 'type', label: 'Type', type: 'select', options: ['wildcard', 'filter', 'weird'], required: true },
      { key: 'location', label: 'Location', required: true, placeholder: 'Boise, ID' },
      { key: 'prompt', label: 'Prompt', placeholder: 'coolest listing' },
      { key: 'filters', label: 'Filters (comma separated)', type: 'tags', placeholder: 'under $250k, has a pool' },
    ],
  },
];

/** Keep only known fields, coerce types, and check required ones. */
export function cleanRow(bank: Bank, raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of bank.fields) {
    let v = src[f.key];
    if (f.type === 'tags') {
      if (typeof v === 'string') v = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!Array.isArray(v)) v = [];
      out[f.key] = (v as unknown[]).map(String);
      continue;
    }
    if (v == null || v === '') {
      if (f.required) return null;
      if (f.type === 'select' && f.options) out[f.key] = f.options[0];
      continue;
    }
    v = String(v).trim();
    if (f.type === 'select' && f.options && !f.options.includes(v as string)) return null;
    out[f.key] = v;
  }
  return out;
}
