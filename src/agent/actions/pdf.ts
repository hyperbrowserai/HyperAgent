import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { config } from "dotenv";
import { GoogleGenAI } from "@google/genai";
import {
  buildActionFailureMessage,
  getPageMethod,
  normalizeActionText,
} from "./shared/action-runtime";

config();

const MAX_PDF_URL_CHARS = 4_000;
const MAX_PDF_PROMPT_CHARS = 8_000;
const MAX_PDF_FILE_BYTES = 20 * 1024 * 1024;

function isPdfContentType(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().includes("pdf");
}

function safeReadRecordField(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeReadContentTypeHeader(response: unknown): string {
  if (!response || (typeof response !== "object" && typeof response !== "function")) {
    return "";
  }
  const headers = (response as { headers?: () => Record<string, string> }).headers;
  if (typeof headers !== "function") {
    return "";
  }
  try {
    const rawHeaders = headers();
    return typeof rawHeaders?.["content-type"] === "string"
      ? rawHeaders["content-type"]
      : "";
  } catch {
    return "";
  }
}

function normalizePdfUrl(value: unknown): string {
  return normalizeActionText(value, "", MAX_PDF_URL_CHARS);
}

function normalizePdfPrompt(value: unknown): string {
  return normalizeActionText(value, "", MAX_PDF_PROMPT_CHARS);
}

async function readResponseBodyAsBuffer(response: unknown): Promise<Buffer | null> {
  if (!response || (typeof response !== "object" && typeof response !== "function")) {
    return null;
  }
  const body = (response as { body?: () => Promise<Buffer | Uint8Array | ArrayBuffer> })
    .body;
  if (typeof body !== "function") {
    return null;
  }
  const payload = await body.call(response);
  if (payload instanceof Buffer) {
    return payload;
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  return null;
}

export const PDFAction = z
  .object({
    pdfUrl: z.string().describe("The URL of the PDF to analyze."),
    prompt: z.string().describe("The prompt/question to ask about the PDF."),
  })
  .describe("Analyze a PDF using Gemini and a prompt");

export type PDFActionType = z.infer<typeof PDFAction>;

export const PDFActionDefinition: AgentActionDefinition = {
  type: "analyzePdf" as const,
  actionParams: PDFAction,
  run: async (ctx: ActionContext, action: PDFActionType) => {
    const apiKey = normalizeActionText(process.env.GEMINI_API_KEY, "", 256);
    if (apiKey.length === 0) {
      return {
        success: false,
        message: "Failed to analyze PDF: GEMINI_API_KEY is not configured.",
      };
    }

    const pdfUrl = normalizePdfUrl(action?.pdfUrl);
    const prompt = normalizePdfPrompt(action?.prompt);
    if (pdfUrl.length === 0) {
      return {
        success: false,
        message: "Failed to analyze PDF: pdfUrl must be a non-empty string.",
      };
    }
    if (prompt.length === 0) {
      return {
        success: false,
        message: "Failed to analyze PDF: prompt must be a non-empty string.",
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(pdfUrl);
    } catch {
      return {
        success: false,
        message: "Failed to analyze PDF: pdfUrl must be a valid URL.",
      };
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return {
        success: false,
        message: `Failed to analyze PDF: unsupported URL protocol "${parsedUrl.protocol}".`,
      };
    }

    const request = (ctx.page as unknown as { request?: { get?: (url: string) => Promise<unknown> } })
      .request;
    if (!request || typeof request.get !== "function") {
      return {
        success: false,
        message: "Failed to analyze PDF: page.request.get is unavailable.",
      };
    }

    const goog = new GoogleGenAI({ apiKey });
    let pdfBuffer: Buffer | null = null;
    try {
      // Try direct request first (works for direct PDF links)
      const response = await request.get(pdfUrl);
      const contentType = safeReadContentTypeHeader(response);
      const isOk =
        typeof (response as { ok?: () => boolean }).ok === "function"
          ? (response as { ok: () => boolean }).ok()
          : false;
      if (isOk && isPdfContentType(contentType)) {
        pdfBuffer = await readResponseBodyAsBuffer(response);
      } else {
        // Fallback: navigate and intercept response
        const waitForResponse = getPageMethod(ctx, "waitForResponse");
        const goto = getPageMethod(ctx, "goto");
        if (!waitForResponse || !goto) {
          return {
            success: false,
            message:
              "Failed to analyze PDF: page.waitForResponse/page.goto are unavailable for fallback download.",
          };
        }
        const [resp] = await Promise.all([
          waitForResponse(
            (r: unknown) => {
              const urlFn = safeReadRecordField(r, "url");
              if (typeof urlFn !== "function") {
                return false;
              }
              try {
                return (
                  (urlFn as () => string)() === pdfUrl &&
                  isPdfContentType(safeReadContentTypeHeader(r))
                );
              } catch {
                return false;
              }
            }
          ),
          goto(pdfUrl, { waitUntil: "networkidle" }),
        ]);
        pdfBuffer = await readResponseBodyAsBuffer(resp);
      }
    } catch (err) {
      return {
        success: false,
        message: buildActionFailureMessage("download PDF", err),
      };
    }
    if (!pdfBuffer) {
      return {
        success: false,
        message: "Could not retrieve PDF file.",
      };
    }
    if (pdfBuffer.length > MAX_PDF_FILE_BYTES) {
      return {
        success: false,
        message: `Failed to analyze PDF: file exceeds ${MAX_PDF_FILE_BYTES} bytes.`,
      };
    }

    let geminiResponse: unknown;
    try {
      geminiResponse = await goog.models.generateContent({
        model: "gemini-2.5-pro-preview-03-25",
        contents: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "application/pdf",
              data: pdfBuffer.toString("base64"),
            },
          },
        ],
      });
    } catch (error) {
      return {
        success: false,
        message: buildActionFailureMessage("analyze PDF with Gemini", error),
      };
    }

    const text = (geminiResponse as { text?: unknown })?.text;
    return {
      success: true,
      message: typeof text === "string" && text.trim().length > 0
        ? text.trim()
        : "No response text returned.",
    };
  },
  pprintAction: function (params: PDFActionType): string {
    return `Analyze PDF at URL: ${params.pdfUrl} with prompt: ${params.prompt}`;
  },
};
