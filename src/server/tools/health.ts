import { z } from "zod";

import type { Catalog } from "../catalog.js";
import { VERSION } from "../constants.js";
import type { PageStore } from "../pages.js";
import { ResponseFormatInput } from "../schemas.js";
import { renderResponse, type RenderedResponse, header, arabize } from "../format.js";

export const healthInputShape = { ...ResponseFormatInput };
export const healthInput = z.object(healthInputShape).strict();

export interface HealthOutput {
    server_version: string;
    status: "ok" | "degraded";
    catalog_books: number;
    catalog_authors: number;
    categories: number;
    downloaded_books: number;
    /** Spot-check over a small sample of downloaded books: how many are actually readable? */
    readable_spot_check: { sampled: number; readable: number; unreadable_book_ids: number[] } | null;
    notes: string[];
}

const SPOT_SAMPLE = 5;

/**
 * (#14): a cheap
 * self-diagnostic. Reaching this handler at all proves the backend booted
 * (catalog loaded); the spot-check distinguishes "server fine" from
 * "library path / content problems" when users report missing/empty tools.
 */
export async function runHealth(
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof healthInput>,
): Promise<RenderedResponse<HealthOutput>> {
    const downloaded = catalog.downloadedBookIds();
    const notes: string[] = [];
    let spot: HealthOutput["readable_spot_check"] = null;

    // Evenly-spread sample across the whole downloaded set — the low-id head of
    // master.db clusters unreadable placeholder rows, so a head-only sample lies.
    const all = Array.from(downloaded).sort((a, b) => a - b);
    const sampleIds = all.length <= SPOT_SAMPLE
        ? all
        : Array.from({ length: SPOT_SAMPLE }, (_, i) => all[Math.floor((i * (all.length - 1)) / (SPOT_SAMPLE - 1))]!)
              .filter((v, i, arr) => arr.indexOf(v) === i);
    if (sampleIds.length) {
        const unreadable: number[] = [];
        for (const id of sampleIds) {
            if (!(await pages.bookHasContent(id))) unreadable.push(id);
        }
        spot = { sampled: sampleIds.length, readable: sampleIds.length - unreadable.length, unreadable_book_ids: unreadable };
        if (spot.readable === 0)
            notes.push(
                "NONE of the sampled downloaded books have readable pages — the Shamela database path may be wrong, or downloads are incomplete",
            );
        else if (unreadable.length)
            notes.push(
                `some downloaded books have no readable pages (ids: ${unreadable.join(", ")}) — individual content issue (electronic/image books), not a server problem; do not quote from them`,
            );
    } else {
        notes.push("no downloaded books found — page searches will return nothing until books are downloaded in Shamela");
    }
    notes.push("the Java search engine warms up lazily; run a small search to exercise it end-to-end");

    const status: HealthOutput["status"] =
        catalog.bookCount() > 0 && (spot ? spot.readable > 0 : true) ? "ok" : "degraded";

    const out: HealthOutput = {
        server_version: VERSION,
        status,
        catalog_books: catalog.bookCount(),
        catalog_authors: catalog.authorCount(),
        categories: catalog.categoryCount(),
        downloaded_books: downloaded.size,
        readable_spot_check: spot,
        notes,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [
            header(1, `فحص خادم الشاملة — ${data.status === "ok" ? "سليم ✅" : "متعثر ⚠️"}`),
            `- **نسخة الخادم**: ${data.server_version}`,
            `- **كتب الفهرس**: ${arabize(data.catalog_books)} — **المؤلفون**: ${arabize(data.catalog_authors)} — **التصنيفات**: ${arabize(data.categories)}`,
            `- **الكتب المنزَّلة**: ${arabize(data.downloaded_books)}`,
        ];
        if (data.readable_spot_check)
            lines.push(
                `- **عيّنة قابلية القراءة**: ${arabize(data.readable_spot_check.readable)} من ${arabize(data.readable_spot_check.sampled)} مقروءة${data.readable_spot_check.unreadable_book_ids.length ? ` (غير المقروءة: ${data.readable_spot_check.unreadable_book_ids.join("، ")})` : ""}`,
            );
        if (data.notes.length) {
            lines.push("", "**ملاحظات**:");
            for (const n of data.notes) lines.push(`- ${n}`);
        }
        return lines.join("\n");
    });
}
