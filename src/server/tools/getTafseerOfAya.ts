import { z } from "zod";

import type { Catalog } from "../catalog.js";
import { ayaNotFound, badArg, serviceKeyNotFound } from "../errors.js";
import { ayaIdFromSurahAya, surahAyaFromId } from "../quran.js";
import { ResponseFormatInput } from "../schemas.js";
import type { ServiceStore } from "../services.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";

export const getTafseerOfAyaInputShape = {
    aya_id: z.number().int().min(1).max(6236).optional().describe("Aya id 1..6236."),
    surah: z.number().int().min(1).max(114).optional().describe("Surah number, paired with `aya`."),
    aya: z.number().int().min(1).optional().describe("Aya within surah."),
    downloaded_only: z.boolean().default(true).describe("If true (default), only return books the user has downloaded locally."),
    ...ResponseFormatInput,
};
export const getTafseerOfAyaInput = z.object(getTafseerOfAyaInputShape).strict();

export interface TafseerHit {
    book_id: number;
    book_name: string;
    author_name: string | null;
    page_id: number;
    downloaded: boolean;
}

export interface GetTafseerOfAyaOutput {
    aya_id: number;
    surah: number;
    surah_name: string;
    aya: number;
    total: number;
    returned: number;
    /** Honest coverage caveat: this index is curated and may omit downloaded tafsirs. */
    coverage_note: string;
    results: TafseerHit[];
}

const COVERAGE_NOTE =
    "هذه القائمة من فهرس الخدمة المنتقى (service/tafseer.db) وقد لا يشمل كل تفاسيرك المنزَّلة — كثير من التفاسير لا تحمل علامات آيات على صفحاتها فلا تظهر هنا. لاستيفاء تفاسيرك المنزَّلة، راجع تصنيفات التفسير عبر shamela_list_downloaded_books(category_id=3) و(category_id=4)، ثم تنقّل إليها بفهرسها (shamela_get_toc).";

export async function runGetTafseerOfAya(
    catalog: Catalog,
    services: ServiceStore,
    args: z.infer<typeof getTafseerOfAyaInput>,
): Promise<RenderedResponse<GetTafseerOfAyaOutput>> {
    let resolvedId: number;
    if (args.aya_id !== undefined) resolvedId = args.aya_id;
    else if (args.surah !== undefined && args.aya !== undefined) {
        const id = ayaIdFromSurahAya(args.surah, args.aya);
        if (id === null) throw ayaNotFound(`surah=${args.surah} aya=${args.aya}`);
        resolvedId = id;
    } else throw badArg("Provide either aya_id or both surah and aya.");
    const sa = surahAyaFromId(resolvedId);
    if (!sa) throw ayaNotFound(String(resolvedId));

    const hits = await services.getBooksForKey("tafseer", resolvedId);
    if (hits.length === 0) throw serviceKeyNotFound("tafseer", resolvedId);

    const filtered = args.downloaded_only ? hits.filter((h) => catalog.isDownloaded(h.book_id)) : hits;
    const results: TafseerHit[] = filtered.map((h) => {
        const rec = catalog.bookRecord(h.book_id);
        return {
            book_id: h.book_id,
            book_name: rec?.book_name ?? `(unknown ${h.book_id})`,
            author_name: rec ? catalog.mainAuthorName(rec) : null,
            page_id: h.page_id,
            downloaded: catalog.isDownloaded(h.book_id),
        };
    });
    const out: GetTafseerOfAyaOutput = {
        aya_id: resolvedId,
        surah: sa.surah,
        surah_name: sa.surah_name,
        aya: sa.aya,
        total: hits.length,
        returned: results.length,
        coverage_note: COVERAGE_NOTE,
        results,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [
            header(1, `تفاسير الآية ${data.surah_name} ${arabize(data.surah)}:${arabize(data.aya)}`),
            `**${arabize(data.total)}** كتاب يعلِّق على هذه الآية، منها ${arabize(data.returned)} في النطاق الحالي.`,
            "",
            `> *${data.coverage_note}*`,
            "",
        ];
        for (const r of data.results) {
            lines.push(
                `- **${r.book_name}**${r.author_name ? ` — ${r.author_name}` : ""} (page_id=${r.page_id}${r.downloaded ? ", منزَّل" : ""})`,
            );
        }
        return lines.join("\n");
    });
}
