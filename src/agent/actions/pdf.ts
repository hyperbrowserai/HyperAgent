import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { config } from "dotenv";
import { GoogleGenAI } from "@google/genai";

config();

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
    const goog = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const { pdfUrl, prompt } = action;
    let pdfBuffer: Buffer | null = null;
    try {
      // Try direct request first (works for direct PDF links)
      const response = await ctx.page.request.get(pdfUrl);
      if (
        response.ok() &&
        response.headers()["content-type"]?.includes("pdf")
      ) {
        pdfBuffer = Buffer.from(await response.body());
      } else {
        // Fallback: navigate and intercept response

        const [resp] = await Promise.all([
          ctx.page.waitForResponse(
            (r) =>
              r.url() === pdfUrl &&
              r.headers()["content-type"]?.includes("pdf"),
          ),
          ctx.page.goto(pdfUrl, { waitUntil: "networkidle" }),
        ]);
        pdfBuffer = Buffer.from(await resp.body());
      }
    } catch (err) {
      return {
        success: false,
        message: `Failed to download PDF: ${err}`,
      };
    }
    if (!pdfBuffer) {
      return {
        success: false,
        message: "Could not retrieve PDF file.",
      };
    }
    const geminiResponse = await goog.models.generateContent({
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
    return {
      success: true,
      message: geminiResponse.text || "No response text returned.",
    };
  },

  pprintAction: function (params: PDFActionType): string {
    return `Analyze PDF at URL: ${params.pdfUrl} with prompt: ${params.prompt}`;
  },
};
