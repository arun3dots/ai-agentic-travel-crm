// Module 1: Quotation Engine API — capture, compare side-by-side, add margin, calculate price (Slide 6)
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { bus } from '../lib/events.mjs';

export const quotesRouter = () => {
  const r = express.Router();

  /** List supplier quotes for a lead or across the office */
  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const leadId = req.query.leadId ? text(req.query.leadId) : null;
    const where = ['q."organizationId" = $1'];
    const params = [organizationId];

    if (leadId) {
      params.push(leadId);
      where.push(`q."leadId" = $${params.length}`);
    }

    const quotes = await db.many(`
      SELECT q.*, s.name AS "supplierName", s.email AS "supplierEmail", s.category AS "supplierCategory",
             l.title AS "leadTitle", l.destination AS "leadDestination"
      FROM supplier_quotes q
      LEFT JOIN suppliers s ON s.id = q."supplierId"
      LEFT JOIN leads l ON l.id = q."leadId"
      WHERE ${where.join(' AND ')}
      ORDER BY q."quoteAmount" ASC, q."createdAt" DESC
    `, params);

    // Compute side-by-side comparison summary
    const lowest = quotes.length ? quotes[0] : null;

    res.json({
      quotes,
      comparison: {
        totalQuotes: quotes.length,
        lowestQuoteAmount: lowest ? Number(lowest.quoteAmount) : 0,
        lowestSupplierName: lowest ? lowest.supplierName : null,
      },
    });
  }));

  /** Ingest or record a supplier quote */
  r.post('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const leadId = requireId(body.leadId, 'leadId');
    const supplierId = requireId(body.supplierId, 'supplierId');
    const quoteAmount = Number(body.quoteAmount);
    if (!quoteAmount || quoteAmount <= 0) throw fail(400, 'quoteAmount must be a positive number');

    const currency = text(body.currency, { max: 10 }) || 'INR';
    const marginPercent = Number(body.staffMarginPercent ?? body.marginPercent ?? 10.0);
    const finalPrice = Math.round(quoteAmount + (quoteAmount * marginPercent / 100));
    const notes = text(body.notes, { max: 4000 });
    const source = text(body.source, { max: 40 }) || 'email';

    const id = newId();
    const quote = await db.one(`
      INSERT INTO supplier_quotes (
        id, "organizationId", "leadId", "supplierId", "quoteAmount", currency,
        "staffMarginPercent", "finalSellingPrice", notes, source, status, "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'received', now(), now())
      RETURNING *
    `, [id, organizationId, leadId, supplierId, quoteAmount, currency, marginPercent, finalPrice, notes, source]);

    await logAudit({
      action: 'quote.create',
      targetType: 'SupplierQuote',
      targetId: quote.id,
      metadata: { leadId, supplierId, quoteAmount, marginPercent, finalPrice },
    });

    bus.broadcast('quote.received', { organizationId, quoteId: quote.id, leadId, supplierId, quoteAmount, finalPrice });

    res.status(201).json({ quote });
  }));

  /** Select this quote as winning supplier quote for the lead */
  r.post('/:id/select', wrap(async (req, res) => {
    const organizationId = await orgId();
    const quoteId = requireId(req.params.id, 'quote id');

    const quote = await db.one('SELECT * FROM supplier_quotes WHERE id = $1 AND "organizationId" = $2', [quoteId, organizationId]);
    if (!quote) throw fail(404, 'no such supplier quote');

    // Mark this quote as accepted and others as received
    await db.query('UPDATE supplier_quotes SET status = \'received\' WHERE "leadId" = $1', [quote.leadId]);
    const updatedQuote = await db.one('UPDATE supplier_quotes SET status = \'accepted\', "updatedAt" = now() WHERE id = $1 RETURNING *', [quote.id]);

    // Update lead with selected supplier and pricing
    const pricingObj = {
      supplierCost: Number(quote.quoteAmount),
      staffMarginPercent: Number(quote.staffMarginPercent),
      finalSellingPrice: Number(quote.finalSellingPrice),
      currency: quote.currency,
      selectedQuoteId: quote.id,
    };

    await db.query(`
      UPDATE leads 
      SET "selectedSupplierId" = $1, pricing = $2, "updatedAt" = now()
      WHERE id = $3 AND "organizationId" = $4
    `, [quote.supplierId, JSON.stringify(pricingObj), quote.leadId, organizationId]);

    await logAudit({
      action: 'quote.select',
      targetType: 'Lead',
      targetId: quote.leadId,
      metadata: { quoteId: quote.id, supplierId: quote.supplierId, finalPrice: quote.finalSellingPrice },
    });

    bus.broadcast('quote.selected', { organizationId, leadId: quote.leadId, quoteId: quote.id, supplierId: quote.supplierId, pricing: pricingObj });

    res.json({ ok: true, quote: updatedQuote, pricing: pricingObj });
  }));

  return r;
};

