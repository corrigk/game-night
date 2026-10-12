/** Prompt banks editable from /admin. Each maps to a host-only content table. */
export interface BankField {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'select' | 'tags' | 'json';
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
  /** Rename/reshape an imported row before it is cleaned (e.g. the file's `id` becomes `slug`). */
  map?: (raw: Record<string, unknown>) => Record<string, unknown>;
  /** Returns a human-readable problem with a cleaned row, or null. Runs on import and on "Add one". */
  validate?: (row: Record<string, unknown>) => string | null;
}

/**
 * Mad Libs script checks, so a bad file fails loudly on import instead of mid-performance:
 * every {{placeholder}} needs a blank, every line's role must exist, directions can't hold blanks.
 */
export function validateMadlib(row: Record<string, unknown>): string | null {
  const title = String(row.title ?? row.slug ?? 'Untitled');
  const where = `Script "${title}"`;
  const roles = row.roles as { name?: unknown; color?: unknown }[] | undefined;
  const blanks = row.blanks as { id?: unknown; prompt?: unknown; kind?: unknown }[] | undefined;
  const lines = row.lines as { role?: unknown; text?: unknown; direction?: unknown }[] | undefined;
  if (!Array.isArray(roles) || roles.length < 1) return `${where}: needs at least one role ({name, color}).`;
  if (!Array.isArray(blanks)) return `${where}: "blanks" must be an array.`;
  if (!Array.isArray(lines) || lines.length < 1) return `${where}: needs at least one line.`;

  const roleNames = new Set<string>();
  for (const r of roles) {
    if (typeof r.name !== 'string' || !r.name.trim()) return `${where}: every role needs a name.`;
    if (roleNames.has(r.name)) return `${where}: role "${r.name}" is listed twice.`;
    roleNames.add(r.name);
  }
  const blankIds = new Set<string>();
  for (const b of blanks) {
    if (typeof b.id !== 'string' || !b.id) return `${where}: every blank needs an id.`;
    if (blankIds.has(b.id)) return `${where}: blank id "${b.id}" is used twice.`;
    if (b.kind !== 'free' && b.kind !== 'roster') return `${where}: blank "${b.id}" has kind "${String(b.kind)}" (must be "free" or "roster").`;
    if (b.kind === 'free' && (typeof b.prompt !== 'string' || !b.prompt.trim())) return `${where}: free blank "${b.id}" needs a prompt.`;
    blankIds.add(b.id);
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    if (typeof l.role !== 'string' || !roleNames.has(l.role)) return `${where}: line ${n} uses role "${String(l.role)}", which is not in "roles".`;
    if (typeof l.text !== 'string' || !l.text.trim()) return `${where}: line ${n} has no text.`;
    for (const m of l.text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
      if (!blankIds.has(m[1])) return `${where}: line ${n} uses {{${m[1]}}} but no blank has that id.`;
    }
    if (typeof l.direction === 'string' && l.direction.includes('{{')) return `${where}: line ${n}'s stage direction contains a blank (directions can't).`;
  }
  return null;
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
    table: 'emoji_titles',
    label: 'Emoji titles',
    help: 'Titles players turn into emoji clues. Decoys are drawn from the same category, so keep 6+ per category. Categories used so far: movies, bible, saints, songs, foods, tv.',
    fields: [
      { key: 'title', label: 'Title', required: true, placeholder: 'Jonah and the Whale' },
      { key: 'category', label: 'Category', required: true, placeholder: 'bible' },
    ],
  },
  {
    table: 'dolphin_tasks',
    label: 'Dolphin tasks',
    help: 'Physical, safe, family-friendly tasks the group secretly assigns to the Dolphin. No touching people, stunts, leaving the room, or eating.',
    fields: [
      { key: 'text', label: 'Task', type: 'textarea', required: true, placeholder: 'Put a sock on a lamp' },
      { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['easy', 'medium', 'hard'] },
    ],
  },
  {
    table: 'hot_seat_words',
    label: 'Hot Seat words',
    help: 'A target word plus exactly 3 forbidden words (comma separated). Forbidden words never appear on the guesser\'s phone.',
    fields: [
      { key: 'word', label: 'Word', required: true, placeholder: 'Pizza' },
      { key: 'forbidden', label: 'Forbidden (3, comma separated)', type: 'tags', required: true, placeholder: 'cheese, pepperoni, slice' },
      { key: 'category', label: 'Category', placeholder: 'food' },
    ],
  },
  {
    table: 'acronym_themes',
    label: 'Acronym themes',
    help: 'An optional theme line shown above the letters in Acronym Attack, e.g. "A very suspicious casserole".',
    fields: [{ key: 'text', label: 'Theme', required: true, placeholder: 'A terrible slogan for a pizza place' }],
  },
  {
    table: 'plot_twist_setups',
    label: 'Plot Twist setups',
    help: 'A 2-3 sentence story setup that players finish with a twist ending. Genre is an optional tag.',
    fields: [
      { key: 'setup', label: 'Setup', type: 'textarea', required: true, placeholder: 'Sister Agnes found a locked door in the basement…' },
      { key: 'genre', label: 'Genre', placeholder: 'Mystery' },
    ],
  },
  {
    table: 'madlibs_templates',
    label: 'Mad Libs scripts',
    help: 'Import scripts as JSON: [{ id, title, mode: "script", description, roles: [{name, color}], blanks: [{id, prompt, kind: "free"|"roster"}], lines: [{role, text, direction?}] }]. Use {{blank_id}} in line text. Scripts are checked on import.',
    fields: [
      { key: 'slug', label: 'Id', required: true, placeholder: 'smoky-mountains' },
      { key: 'title', label: 'Title', required: true },
      { key: 'mode', label: 'Mode', type: 'select', options: ['script', 'story'] },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'roles', label: 'Roles (JSON)', type: 'json', required: true },
      { key: 'blanks', label: 'Blanks (JSON)', type: 'json', required: true },
      { key: 'lines', label: 'Lines (JSON)', type: 'json', required: true },
    ],
    map: (raw) => ({ ...raw, slug: raw.slug ?? raw.id }),
    validate: validateMadlib,
  },
  {
    table: 'talents',
    label: 'Talents',
    help: 'Absurd talents handed out at random in Talent Show. Phrase them as a command: "Juggle three socks".',
    fields: [{ key: 'text', label: 'Talent', required: true, placeholder: 'Perform an interpretive dance of a tax audit' }],
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
    if (f.type === 'json') {
      if (typeof v === 'string') {
        try {
          v = v.trim() ? JSON.parse(v) : null;
        } catch {
          return null;
        }
      }
      if (v == null) {
        if (f.required) return null;
        continue;
      }
      out[f.key] = v;
      continue;
    }
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
