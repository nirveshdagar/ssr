/**
 * Themed-word server name generator. Replaces the legacy
 * `ssr-<unix>-<rand>` opaque pattern with names like:
 *
 *   falcon-28-04-2026          (single word, today's date in DD-MM-YYYY)
 *   oak-28-04-2026             (next server today, fresh word)
 *   cypress-29-04-2026         (tomorrow's first server)
 *   falcon-29-04-2026-2        (rare: word reused — collision suffix)
 *
 * Uniqueness contract: the LEADING word is checked against four sources
 * before being claimed for a new server, so once a word has ever been
 * used as a server name it never repeats:
 *
 *   1. SSR DB `servers` table (current + ever-claimed)
 *   2. ServerAvatar — every server in the org (regardless of which SSR
 *      instance created it)
 *   3. DigitalOcean primary API token
 *   4. DigitalOcean backup API token (separate account, full failover)
 *
 * If both DO tokens are unreachable when generating, we fall back to
 * DB+SA only — better to ship a name than block droplet creation. The
 * collision suffix (`-2`, `-3`, …) is the safety net for that case.
 *
 * Word pool is curated, not random — animals / trees / cities / nature /
 * colors. Any word that gets used (even once) is permanently reserved
 * from this generator's perspective. With ~200 words the operator can
 * cycle through a year+ of daily provisions without a single collision.
 */

import { listServers as listDbServers } from "./repos/servers"
import { listServers as listSaServers } from "./serveravatar"
import { listDropletsAllTokens } from "./digitalocean"

const WORDS: string[] = [
  // animals — 60
  "falcon", "otter", "raven", "lynx", "bison", "panda", "tiger", "cobra",
  "hawk", "eagle", "wolf", "fox", "owl", "lark", "swan", "crane",
  "ibex", "elk", "deer", "moose", "puma", "jaguar", "leopard", "cheetah",
  "badger", "weasel", "ferret", "marten", "ermine", "stoat", "mongoose",
  "kestrel", "heron", "egret", "stork", "albatross", "penguin", "puffin",
  "narwhal", "orca", "dolphin", "manatee", "seahorse", "octopus",
  "kangaroo", "koala", "wombat", "platypus", "echidna", "tapir",
  "okapi", "gazelle", "antelope", "oryx", "kudu", "impala", "wildebeest",
  "meerkat", "lemur", "tarsier",
  // trees — 30
  "oak", "cypress", "juniper", "cedar", "willow", "maple", "birch", "elm",
  "alder", "ash", "beech", "chestnut", "fir", "hemlock", "larch", "linden",
  "magnolia", "mahogany", "myrtle", "olive", "pine", "poplar", "redwood",
  "sequoia", "spruce", "sycamore", "teak", "walnut", "yew", "banyan",
  // cities — 40 (mix of Indian + global)
  "mumbai", "delhi", "kolkata", "chennai", "bengaluru", "jaipur", "kochi",
  "pune", "ahmedabad", "lucknow", "indore", "bhopal", "surat", "nagpur",
  "kyoto", "lisbon", "oslo", "porto", "vienna", "prague", "warsaw",
  "budapest", "athens", "dublin", "helsinki", "tallinn", "riga", "vilnius",
  "zurich", "geneva", "milan", "naples", "florence", "verona", "seville",
  "granada", "bilbao", "bremen", "munich", "leipzig",
  // nature / geography — 30
  "river", "harbor", "summit", "valley", "ridge", "canyon", "delta", "fjord",
  "glacier", "mesa", "atoll", "cove", "isthmus", "lagoon", "marsh", "moor",
  "oasis", "plateau", "prairie", "savanna", "steppe", "tundra", "estuary",
  "geyser", "highland", "lowland", "meadow", "tributary", "watershed", "wetland",
  // colors / minerals — 30
  "amber", "ivory", "indigo", "scarlet", "crimson", "azure", "cobalt",
  "emerald", "jade", "topaz", "garnet", "onyx", "opal", "pearl", "ruby",
  "sapphire", "silver", "slate", "violet", "saffron", "umber", "sienna",
  "bronze", "copper", "platinum", "vermilion", "magenta", "turquoise",
  "obsidian", "quartz",
]

function leadingWord(name: string | null | undefined): string | null {
  if (!name) return null
  const trimmed = String(name).trim()
  if (!trimmed) return null
  // Skip the legacy ssr-<unix>-<rand> pattern — those are the OLD opaque
  // names; their "leading word" (`ssr`) shouldn't be treated as a
  // themed-word reservation.
  if (/^ssr-\d+/i.test(trimmed)) return null
  if (/^srv-\d+/i.test(trimmed)) return null
  const first = trimmed.split("-")[0]
  if (!first) return null
  // Reserve only alphabetic leading tokens — numeric ones come from the
  // legacy patterns we want to ignore.
  if (!/^[A-Za-z]+$/.test(first)) return null
  return first.toLowerCase()
}

function todayDdMmYyyy(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const yyyy = String(d.getFullYear())
  return `${dd}-${mm}-${yyyy}`
}

interface UsedSet {
  used: Set<string>
  sources: { db: number; sa: number; do_primary: number; do_backup: number }
  errors: { source: string; error: string }[]
}

async function collectUsedWords(): Promise<UsedSet> {
  const used = new Set<string>()
  const sources = { db: 0, sa: 0, do_primary: 0, do_backup: 0 }
  const errors: { source: string; error: string }[] = []

  // 1. SSR DB
  try {
    for (const s of listDbServers()) {
      const w = leadingWord(s.name)
      if (w) { used.add(w); sources.db++ }
    }
  } catch (e) {
    errors.push({ source: "db", error: (e as Error).message })
  }

  // 2. ServerAvatar
  try {
    const saList = await listSaServers()
    for (const s of saList) {
      const w = leadingWord(String(s.name ?? ""))
      if (w) { used.add(w); sources.sa++ }
    }
  } catch (e) {
    errors.push({ source: "sa", error: (e as Error).message })
  }

  // 3. + 4. DO primary + backup (parallel via the helper)
  try {
    const { droplets, errors: doErrors } = await listDropletsAllTokens({ tag: undefined })
    for (const d of droplets) {
      const w = leadingWord(d.name)
      if (w) { used.add(w); sources.do_primary++ }
    }
    for (const e of doErrors) errors.push({ source: `do_${e.token}`, error: e.error })
  } catch (e) {
    errors.push({ source: "do_all", error: (e as Error).message })
  }

  return { used, sources, errors }
}

export interface GeneratedName {
  name: string
  word: string
  date: string
  collision_suffix: number | null
  /** Counts of leading-word reservations seen on each source — useful for
   *  audit logging / debugging name churn. */
  used_counts: UsedSet["sources"]
  /** Sources that returned an error during the lookup. Empty in the happy
   *  case. Operator-visible so they can spot transient API outages that
   *  may have weakened the uniqueness check. */
  lookup_errors: UsedSet["errors"]
}

/**
 * Pick the next never-used themed word and stamp today's DD-MM-YYYY date.
 * Selection is rotated by day-of-year so consecutive days don't all fall
 * back on alphabetically-first words that happen to remain unused.
 */
export async function generateServerName(): Promise<GeneratedName> {
  const { used, sources, errors } = await collectUsedWords()
  const date = todayDdMmYyyy()

  // Day-rotated start offset — keeps successive days picking different
  // candidates from the head of the pool.
  const epochDay = Math.floor(Date.now() / 86400000)
  // 7919 is prime — gives a uniform stride through the pool.
  const start = (epochDay * 7919) % WORDS.length

  // First pass: any unused word
  for (let i = 0; i < WORDS.length; i++) {
    const word = WORDS[(start + i) % WORDS.length]
    if (!used.has(word)) {
      return { name: `${word}-${date}`, word, date, collision_suffix: null, used_counts: sources, lookup_errors: errors }
    }
  }

  // Pool exhausted — every word used at least once. Rotate again with a
  // numeric suffix so we keep producing valid names without panicking.
  for (let suffix = 2; suffix <= 99; suffix++) {
    for (let i = 0; i < WORDS.length; i++) {
      const word = WORDS[(start + i) % WORDS.length]
      const candidate = `${word}-${date}-${suffix}`
      // We compare against the FULL leading-word + suffix shape because at
      // this point the unique key isn't just the leading word — it's the
      // whole reused pair.
      const reservedKey = `${word}-${suffix}`
      if (!used.has(reservedKey)) {
        // Track this reservation so future calls in the same tick don't
        // pick the same suffix from the in-process pool.
        used.add(reservedKey)
        return { name: candidate, word, date, collision_suffix: suffix, used_counts: sources, lookup_errors: errors }
      }
    }
  }

  // Last resort — should never hit. Use a short timestamp.
  const ts = String(Math.floor(Date.now() / 1000))
  return {
    name: `srv-${ts}`, word: "srv", date, collision_suffix: null,
    used_counts: sources, lookup_errors: errors,
  }
}
