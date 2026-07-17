import { z } from "zod";

import { renderResponse, type RenderedResponse } from "../format.js";
import {
    buildGuideSectionText,
    GUIDE_SECTION_NAMES,
    type GuideSectionName,
} from "../guide.js";
import { ResponseFormatInput } from "../schemas.js";

export const guideInputShape = {
    section: z
        .string()
        .default("الكل")
        .describe(
            "Which part of the user guide to return: 'الكل' (default — the full guide), 'الأدوات' (the tools with natural-request examples), 'القوالب' (the slash templates), or 'النصائح' (researcher tips). An unrecognized value falls back to the full guide with a note.",
        ),
    ...ResponseFormatInput,
};
export const guideInput = z.object(guideInputShape).strict();

export interface GuideOutput {
    /** The section actually returned (falls back to «الكل» on unknown input). */
    section: GuideSectionName;
    available_sections: string[];
    /** User-facing Arabic markdown — present it faithfully, do not summarize. */
    text: string;
    notes: string[];
}

/**
 * shamela_guide — the built-in user guide as a model-callable tool. Pure text
 * (no backend): MCP resources cannot be fetched by the model itself, so the
 * shamela://guide resource only helps when the USER attaches it manually;
 * this tool is the reliable in-conversation path.
 */
export function runGuide(args: z.infer<typeof guideInput>): RenderedResponse<GuideOutput> {
    const requested = args.section.trim();
    const notes: string[] = [];
    let section: GuideSectionName = "الكل";
    if ((GUIDE_SECTION_NAMES as readonly string[]).includes(requested)) {
        section = requested as GuideSectionName;
    } else {
        notes.push(
            `القسم المطلوب «${requested}» غير معروف؛ الأقسام المتاحة: ${GUIDE_SECTION_NAMES.join("، ")} — وقد عُرض الدليل كاملًا.`,
        );
    }
    const out: GuideOutput = {
        section,
        available_sections: [...GUIDE_SECTION_NAMES],
        text: buildGuideSectionText(section),
        notes,
    };
    return renderResponse(out, args.response_format, (data) =>
        data.notes.length
            ? `${data.notes.map((n) => `> ${n}`).join("\n")}\n\n${data.text}`
            : data.text,
    );
}
