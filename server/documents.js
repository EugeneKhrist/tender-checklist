// Извлечение текста из документов закупки: PDF, Word (.docx, .doc), Excel (.xlsx).
import path from 'node:path';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import ExcelJS from 'exceljs';
import { extractText as htmlToText } from './fetchPage.js';

export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const MAX_DOC_TEXT = 400_000;
const MIN_TEXT = 30;

export const DOC_TYPES = {
  pdf: { exts: ['.pdf'], mime: 'application/pdf', label: 'PDF' },
  docx: {
    exts: ['.docx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word',
  },
  doc: { exts: ['.doc'], mime: 'application/msword', label: 'Word' },
  xlsx: {
    exts: ['.xlsx'],
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel',
  },
};

export const DOC_ACCEPT = Object.values(DOC_TYPES).flatMap((t) => t.exts).join(',');

const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const isPdf = (b) => b.length > 5 && b.subarray(0, 1024).toString('latin1').includes('%PDF-');

/** Определяет тип документа по расширению И по содержимому (имени файла доверять нельзя). */
export function detectDocument(filename, buffer) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.pdf' && isPdf(buffer)) return { kind: 'pdf', ext, mime: DOC_TYPES.pdf.mime };
  if (ext === '.docx' && isZip(buffer)) return { kind: 'docx', ext, mime: DOC_TYPES.docx.mime };
  if (ext === '.xlsx' && isZip(buffer)) return { kind: 'xlsx', ext, mime: DOC_TYPES.xlsx.mime };
  if (ext === '.doc' && isOle(buffer)) return { kind: 'doc', ext, mime: DOC_TYPES.doc.mime };
  return null;
}

export const isKnownDocExt = (filename) =>
  Object.values(DOC_TYPES).some((t) => t.exts.includes(path.extname(String(filename || '')).toLowerCase()));

const tidy = (text) =>
  String(text)
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

async function pdfText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await pdfExtractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((t, i) => `[страница ${i + 1}]\n${t}`).join('\n');
}

async function docxText(buffer) {
  const { value } = await mammoth.convertToHtml({ buffer });
  return htmlToText(`<html><body>${value}</body></html>`).text;
}

async function docText(buffer) {
  const doc = await new WordExtractor().extract(buffer);
  return doc.getBody();
}

async function xlsxText(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  for (const sheet of wb.worksheets) {
    out.push(`[лист «${sheet.name}»]`);
    let rows = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows >= 3000) return;
      rows += 1;
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        let t = '';
        try {
          t = String(cell.text ?? '').trim();
        } catch {
          t = '';
        }
        if (t) cells.push(t);
      });
      if (cells.length) out.push(cells.join(' | '));
    });
  }
  return out.join('\n');
}

const EXTRACTORS = { pdf: pdfText, docx: docxText, doc: docText, xlsx: xlsxText };

/**
 * Достаёт текст из документа. Бросает Error с понятным русским сообщением,
 * если файл повреждён или в нём нет текста (например, PDF-скан).
 */
export async function extractDocumentText(kind, buffer, filename = 'документ') {
  let raw;
  try {
    raw = await EXTRACTORS[kind](buffer);
  } catch (err) {
    const why = err?.message ? ` (${String(err.message).slice(0, 120)})` : '';
    throw new Error(`Не удалось прочитать файл «${filename}»: он повреждён или защищён паролем${why}`);
  }
  let text = tidy(raw);
  if (text.replace(/\[[^\]]*\]/g, '').trim().length < MIN_TEXT) {
    throw new Error(
      kind === 'pdf'
        ? `В файле «${filename}» нет текста — похоже, это скан. Загрузите страницы как скриншоты.`
        : `В файле «${filename}» не найдено текста.`,
    );
  }
  if (text.length > MAX_DOC_TEXT) text = `${text.slice(0, MAX_DOC_TEXT)}\n[…текст обрезан…]`;
  return text;
}
