/**
 * Arabic text utilities.
 *
 * Node-side normalization + tokenization that mirrors (closely enough) the
 * Java helper's Normalize so we can do two-stage post-filtering (phrase /
 * proximity) and query-side prefix expansion without touching the Lucene index.
 *
 * Both the query and the page text are passed through the SAME normalizer, so
 * matching is internally consistent regardless of small differences from the
 * Java side.
 */

// Tashkeel, tatweel, dagger-alef, Quranic annotation marks → removed.
const DIACRITICS_RE = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Normalize an Arabic string: strip diacritics/tatweel, fold alef/ya/ta/hamza. */
export function normalizeArabic(input: string): string {
    if (!input) return "";
    let s = input.normalize("NFC");
    s = s.replace(DIACRITICS_RE, "");
    // Fold orthographic variants.
    s = s
        .replace(/[آأإٱ]/g, "ا") // آأإٱ → ا
        .replace(/ى/g, "ي") // ى → ي
        .replace(/ة/g, "ه") // ة → ه
        .replace(/ؤ/g, "و") // ؤ → و
        .replace(/ئ/g, "ي") // ئ → ي
        .replace(/ء/g, ""); // standalone hamza removed
    return s;
}

/** Strip inline HTML tags (e.g. <span data-type='title'>) before tokenizing. */
function stripHtml(s: string): string {
    return s.replace(/<[^>]*>/g, " ");
}

/**
 * Tokenize Arabic text into normalized tokens (runs of Arabic letters).
 * Applies the same "ابن" → "بن" rule the helper uses so phrase matching lines up.
 */
export function tokenizeArabic(input: string): string[] {
    const normalized = normalizeArabic(stripHtml(input));
    const matches = normalized.match(/[؀-ۿ]+/g);
    if (!matches) return [];
    return matches.map((t) => (t === "ابن" ? "بن" : t)); // ابن → بن
}

/** True if `needle` token sequence appears contiguously inside `hay` tokens. */
export function containsPhrase(hay: string[], needle: string[]): boolean {
    if (needle.length === 0 || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
        let ok = true;
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) {
                ok = false;
                break;
            }
        }
        if (ok) return true;
    }
    return false;
}

/**
 * True if every needed token occurs within a window of `distance` tokens
 * (unordered). Minimum-window-cover over the positions of the needed tokens.
 */
export function withinProximity(hay: string[], needed: string[], distance: number): boolean {
    const need = new Set(needed);
    if (need.size === 0) return false;
    const events: Array<[number, string]> = [];
    hay.forEach((t, pos) => {
        if (need.has(t)) events.push([pos, t]);
    });
    if (events.length < need.size) return false;
    const count = new Map<string, number>();
    let have = 0;
    let left = 0;
    for (let right = 0; right < events.length; right++) {
        const t = events[right]![1];
        count.set(t, (count.get(t) ?? 0) + 1);
        if (count.get(t) === 1) have++;
        while (have === need.size) {
            const span = events[right]![0] - events[left]![0];
            if (span <= distance) return true;
            const lt = events[left]![1];
            count.set(lt, count.get(lt)! - 1);
            if (count.get(lt) === 0) have--;
            left++;
        }
    }
    return false;
}

const PROCLITICS = ["", "و", "ف", "ب", "ك", "ل"]; // "", و, ف, ب, ك, ل

/**
 * Expand a single normalized token into surface variants that differ only by a
 * leading proclitic / definite article — so a Quran search for "الصبر" also
 * matches the indexed token "بالصبر". The Quran Lucene index stores whole
 * words, so this is the cheapest way to get prefix-insensitive matching without
 * re-indexing.
 */
export function expandPrefixVariants(token: string): string[] {
    const t = normalizeArabic(token);
    if (t.length < 2) return [t];
    const core = t.startsWith("ال") ? t.slice(2) : t; // strip leading ال
    const withAl = t.startsWith("ال") ? t : "ال" + t;
    const bases = Array.from(new Set([t, withAl, core]));
    const out = new Set<string>();
    for (const b of bases) {
        for (const p of PROCLITICS) {
            // ل + ال contracts to لل in Arabic orthography — the raw
            // concatenation (e.g. «لالصبر») never occurs in written text.
            if (p === "ل" && b.startsWith("ال")) continue;
            out.add(p + b);
        }
    }
    out.add("لل" + core); // لل + core (the contracted form)
    return Array.from(out).filter((s) => s.length >= 2);
}
