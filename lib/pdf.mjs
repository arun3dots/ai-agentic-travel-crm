// The document desk — turns an itinerary + flights + pricing into the final PDF.
//
// The standard PDF fonts are WinAnsi only, so any character outside Latin-1 (Tamil, Hindi, emoji)
// would make pdf-lib throw mid-document and lose the whole mail. Every string is therefore stripped
// to what the fonts can actually draw before it is written.
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 50;

/** Keep only what Helvetica can render; keep newlines out of a single draw call. */
function drawable(text) {
  return String(text ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '*')
    .replace(/\u20b9/g, 'INR ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
    .replace(/\s+/g, ' ');
}

function wrapText(text, maxWidth, font, size) {
  const clean = drawable(text.replace(/\*\*/g, ''));
  const words = clean.split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [clean];
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.recipientName
 * @param {string} [o.recipientEmail]
 * @param {'customer'|'supplier'} o.recipientType
 * @param {string} o.itineraryText  Markdown
 * @param {Array} [o.flights]
 * @param {object} [o.pricing]
 * @param {string} [o.organizationName]
 * @returns {Promise<Uint8Array>}
 */
export async function generateItineraryPDF(o) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const contentWidth = A4.width - MARGIN * 2;
  const accent = o.recipientType === 'customer' ? rgb(0.15, 0.55, 0.48) : rgb(0.39, 0.4, 0.95);

  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  const rule = () => {
    page.drawRectangle({ x: MARGIN, y: y - 2, width: contentWidth, height: 3, color: accent });
    y -= 15;
  };
  const pageBreak = needed => {
    if (y - needed < MARGIN) { page = doc.addPage([A4.width, A4.height]); y = A4.height - MARGIN; rule(); }
  };

  page.drawText(drawable(o.organizationName || '3DOTS TRAVEL'), { x: MARGIN, y, size: 9, font: bold, color: rgb(0.4, 0.45, 0.5) });
  const tag = drawable(o.recipientType === 'customer' ? 'CONFIDENTIAL ITINERARY & QUOTATION' : 'REQUEST FOR QUOTATION (RFQ)');
  page.drawText(tag, { x: A4.width - MARGIN - bold.widthOfTextAtSize(tag, 9), y, size: 9, font: bold, color: accent });
  y -= 25;
  rule();

  page.drawText(drawable(o.title).slice(0, 70), { x: MARGIN, y, size: 16, font: bold, color: rgb(0.1, 0.12, 0.15) });
  y -= 22;

  page.drawRectangle({ x: MARGIN, y: y - 35, width: contentWidth, height: 45, color: rgb(0.96, 0.97, 0.98) });
  page.drawText(drawable(`Prepared For: ${o.recipientName}`), { x: MARGIN + 12, y: y - 2, size: 10, font: bold, color: rgb(0.15, 0.2, 0.25) });
  if (o.recipientEmail) page.drawText(drawable(`Email: ${o.recipientEmail}`), { x: MARGIN + 12, y: y - 16, size: 9, font: regular, color: rgb(0.35, 0.4, 0.45) });
  page.drawText(drawable(`Date: ${new Date().toLocaleDateString('en-IN')}`), { x: MARGIN + 320, y: y - 2, size: 9, font: regular, color: rgb(0.35, 0.4, 0.45) });
  page.drawText('Status: Approved by the travel desk', { x: MARGIN + 320, y: y - 16, size: 9, font: bold, color: rgb(0.1, 0.55, 0.35) });
  y -= 55;

  if (o.recipientType === 'supplier') {
    page.drawRectangle({ x: MARGIN, y: y - 35, width: contentWidth, height: 40, color: rgb(0.93, 0.95, 1.0) });
    page.drawText('SUPPLIER QUOTATION REQUEST:', { x: MARGIN + 10, y: y - 12, size: 9, font: bold, color: rgb(0.2, 0.25, 0.7) });
    page.drawText('Please review the scope below and send your best net rate quotation and availability.', { x: MARGIN + 10, y: y - 26, size: 8.5, font: regular, color: rgb(0.2, 0.25, 0.4) });
    y -= 50;
  }

  // --- MODULE 2: FLIGHTS BLOCK (Slide 7) ---
  if (Array.isArray(o.flights) && o.flights.length > 0) {
    pageBreak(65);
    page.drawRectangle({ x: MARGIN, y: y - 40, width: contentWidth, height: 44, color: rgb(0.94, 0.97, 0.96) });
    page.drawText('CONFIRMED / RECOMMENDED FLIGHTS:', { x: MARGIN + 10, y: y - 12, size: 9.5, font: bold, color: rgb(0.1, 0.45, 0.38) });
    
    let fLine = '';
    for (const f of o.flights) {
      const seg = `${f.airline || ''} ${f.flightNumber || ''}: ${f.departureAirport || ''} -> ${f.arrivalAirport || ''} (${f.departureTime || ''} - ${f.arrivalTime || ''})${f.pnr ? ` [PNR: ${f.pnr}]` : ''}`;
      fLine = fLine ? `${fLine} | ${seg}` : seg;
    }
    const wrappedFlights = wrapText(fLine, contentWidth - 24, regular, 8.5);
    wrappedFlights.forEach((fl, idx) => {
      page.drawText(drawable(fl), { x: MARGIN + 10, y: y - 25 - (idx * 11), size: 8.5, font: regular, color: rgb(0.15, 0.2, 0.25) });
    });
    y -= 55;
  }

  // --- MODULE 1 & 2: PRICING BREAKDOWN (Slide 6, 7) ---
  if (o.pricing && o.recipientType === 'customer' && (o.pricing.finalSellingPrice || o.pricing.totalPrice)) {
    pageBreak(55);
    const amount = Number(o.pricing.finalSellingPrice || o.pricing.totalPrice).toLocaleString('en-IN');
    const curr = o.pricing.currency || 'INR';
    page.drawRectangle({ x: MARGIN, y: y - 36, width: contentWidth, height: 40, color: rgb(0.98, 0.95, 0.9) });
    page.drawText('TOTAL PACKAGE INVESTMENT:', { x: MARGIN + 12, y: y - 12, size: 9, font: bold, color: rgb(0.65, 0.4, 0.1) });
    page.drawText(`${curr} ${amount}`, { x: MARGIN + 12, y: y - 26, size: 12, font: bold, color: rgb(0.15, 0.2, 0.25) });
    page.drawText('*Includes accommodation, indicated excursions, and all applicable taxes.', { x: MARGIN + 150, y: y - 24, size: 8, font: regular, color: rgb(0.45, 0.45, 0.5) });
    y -= 50;
  }

  // --- ITINERARY BODY ---
  for (const raw of String(o.itineraryText || '').split('\n')) {
    const line = raw.trim();
    if (!line) { y -= 8; continue; }

    if (line.startsWith('# ')) {
      pageBreak(30); y -= 10;
      page.drawText(drawable(line.slice(2)), { x: MARGIN, y, size: 14, font: bold, color: rgb(0.1, 0.15, 0.2) });
      y -= 18;
    } else if (line.startsWith('## ')) {
      pageBreak(25); y -= 8;
      page.drawText(drawable(line.slice(3)), { x: MARGIN, y, size: 12, font: bold, color: rgb(0.15, 0.2, 0.3) });
      y -= 16;
    } else if (line.startsWith('### ')) {
      pageBreak(20); y -= 5;
      page.drawText(drawable(line.slice(4)), { x: MARGIN, y, size: 10.5, font: bold, color: rgb(0.2, 0.25, 0.35) });
      y -= 14;
    } else if (/^[*\-]\s+/.test(line)) {
      const wrapped = wrapText(line.replace(/^[*\-]\s+/, ''), contentWidth - 16, regular, 9);
      wrapped.forEach((l, i) => {
        pageBreak(12);
        if (i === 0) page.drawText('*', { x: MARGIN + 4, y, size: 9, font: bold, color: rgb(0.3, 0.35, 0.4) });
        page.drawText(l, { x: MARGIN + 16, y, size: 9, font: regular, color: rgb(0.2, 0.22, 0.25) });
        y -= 12;
      });
    } else {
      for (const l of wrapText(line, contentWidth, regular, 9)) {
        pageBreak(12);
        page.drawText(l, { x: MARGIN, y, size: 9, font: regular, color: rgb(0.25, 0.28, 0.3) });
        y -= 12;
      }
    }
  }

  const pages = doc.getPageCount();
  for (let i = 0; i < pages; i++) {
    doc.getPage(i).drawText(`Page ${i + 1} of ${pages} - 3dots Travel`, { x: MARGIN, y: 25, size: 7.5, font: regular, color: rgb(0.55, 0.6, 0.65) });
  }

  return doc.save();
}
