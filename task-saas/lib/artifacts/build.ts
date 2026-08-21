import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { validateArtifactPath } from "./paths";
import type { NormalizedArtifact } from "./types";

/**
 * Packaging for validated artifacts.
 *
 * Every path is re-validated here even though validateArtifact() already checked it.
 * This module is the last point before bytes are written into an archive, and it is
 * also reachable from the legacy /api/export routes, so it does not assume its input
 * came from a trusted caller.
 */

export async function buildZipBuffer(artifact: NormalizedArtifact): Promise<Buffer> {
  const zip = new JSZip();

  for (const file of artifact.files) {
    const check = validateArtifactPath(file.path);
    if (!check.ok) {
      throw new Error(`refusing to package unsafe path: ${check.reason}`);
    }
    zip.file(check.value, file.content);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export function buildFileBody(artifact: NormalizedArtifact): string {
  const file = artifact.files[0];
  if (!file) throw new Error("artifact has no file to export");
  return file.content;
}

/**
 * Render lightweight Markdown to a PDF.
 *
 * Supports headings, bullets and fenced code blocks — the subset the model is asked
 * to produce. Extracted from the original /api/export/pdf handler so both the new
 * artifact pipeline and the legacy export route render identically.
 */
export function buildPdfBuffer(markdown: string, title = "CodeMind AI Report"): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.font("Helvetica-Bold").fontSize(18).text(title, { align: "center" });
      doc.moveDown(2);

      let inCodeBlock = false;

      for (const line of markdown.split("\n")) {
        if (line.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          doc.moveDown(0.5);
          continue;
        }

        if (inCodeBlock) {
          doc.font("Courier").fontSize(10).fillColor("#333333").text(line, { lineGap: 2 });
          continue;
        }

        doc.fillColor("#000000");
        if (line.startsWith("# ")) {
          doc.font("Helvetica-Bold").fontSize(16).text(line.substring(2), { lineGap: 4 });
          doc.moveDown(0.5);
        } else if (line.startsWith("## ")) {
          doc.font("Helvetica-Bold").fontSize(14).text(line.substring(3), { lineGap: 4 });
          doc.moveDown(0.5);
        } else if (line.startsWith("### ")) {
          doc.font("Helvetica-Bold").fontSize(12).text(line.substring(4), { lineGap: 4 });
          doc.moveDown(0.5);
        } else if (line.startsWith("- ") || line.startsWith("* ")) {
          doc.font("Helvetica").fontSize(11).text(`• ${line.substring(2)}`, { indent: 15, lineGap: 4 });
        } else {
          doc.font("Helvetica").fontSize(11).text(line, { lineGap: 4 });
        }
      }

      const dateStr = new Date().toISOString().split("T")[0];
      doc.moveDown(3);
      doc.fontSize(10).fillColor("gray").text(`Generated on ${dateStr}`, { align: "center" });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** Build the downloadable bytes for any artifact type. */
export async function buildArtifactBytes(
  artifact: NormalizedArtifact
): Promise<{ body: Buffer; contentType: string }> {
  switch (artifact.type) {
    case "zip":
      return { body: await buildZipBuffer(artifact), contentType: "application/zip" };
    case "pdf":
      return {
        body: await buildPdfBuffer(artifact.markdown ?? ""),
        contentType: "application/pdf",
      };
    case "file":
      return {
        body: Buffer.from(buildFileBody(artifact), "utf8"),
        contentType: "text/plain; charset=utf-8",
      };
  }
}
