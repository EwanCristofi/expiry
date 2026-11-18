import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { listExpiryChecks } from '../services/productService.js'

const MONTH_LABELS = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
]

/**
 * @param {number} count
 * @param {Date} [from]
 * @returns {Array<{ year: number, month: number }>}
 */
export function monthsFromNow(count, from = new Date()) {
  const months = []
  let year = from.getFullYear()
  let month = from.getMonth() + 1
  for (let i = 0; i < count; i += 1) {
    months.push({ year, month })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}

/**
 * @param {{
 *   horizon: 'current' | '3' | '6' | 'specific',
 *   specificYear?: number,
 *   specificMonth?: number,
 * }} options
 */
export function resolveExportMonths(options) {
  const { horizon, specificYear, specificMonth } = options
  if (horizon === 'current') return monthsFromNow(1)
  if (horizon === '3') return monthsFromNow(3)
  if (horizon === '6') return monthsFromNow(6)
  if (
    horizon === 'specific' &&
    specificYear &&
    specificMonth >= 1 &&
    specificMonth <= 12
  ) {
    return [{ year: specificYear, month: specificMonth }]
  }
  return monthsFromNow(6)
}

/**
 * @param {{
 *   horizon: 'current' | '3' | '6' | 'specific',
 *   specificYear?: number,
 *   specificMonth?: number,
 * }} options
 */
export function horizonReportTitle(options) {
  const { horizon, specificYear, specificMonth } = options
  if (horizon === 'current') return 'Liste des péremptions — Mois en cours'
  if (horizon === '3') return 'Liste des péremptions — Horizon 3 mois'
  if (horizon === '6') return 'Liste des péremptions — Horizon 6 mois'
  if (horizon === 'specific' && specificYear && specificMonth) {
    const label = MONTH_LABELS[specificMonth - 1] || String(specificMonth)
    return `Liste des péremptions — ${label} ${specificYear}`
  }
  return 'Liste des péremptions'
}

function formatExpiryMonthYear(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate ?? '')) return isoDate || '—'
  const year = isoDate.slice(0, 4)
  const month = isoDate.slice(5, 7)
  return `${month}/${year}`
}

function formatEditionDate(date = new Date()) {
  return date.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function formatFileDate(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Charge les scans pour les mois demandés, filtre et trie.
 * @param {{
 *   months: Array<{ year: number, month: number }>,
 *   excludeVerified: boolean,
 * }} options
 */
export async function fetchExportItems({ months, excludeVerified }) {
  const status = excludeVerified ? 'unverified' : 'all'
  const batches = await Promise.all(
    months.map(({ year, month }) =>
      listExpiryChecks({ year, month, zoneId: null, status, sort: 'date' }),
    ),
  )

  const items = batches.flat()
  items.sort((a, b) => {
    const byDate = String(a.date_peremption).localeCompare(
      String(b.date_peremption),
    )
    if (byDate !== 0) return byDate
    return String(a.nom_zone || '').localeCompare(String(b.nom_zone || ''), 'fr')
  })
  return items
}

/**
 * @param {{
 *   pharmacyName: string,
 *   items: Array<{
 *     date_peremption: string,
 *     nom_zone: string | null,
 *     nom_produit: string,
 *     code_gtin: string,
 *   }>,
 *   reportTitle: string,
 * }} options
 */
export function generateExpiryPdf({ pharmacyName, items, reportTitle }) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const marginX = 14
  const now = new Date()

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(15, 118, 110)
  doc.text('EXPIRY', marginX, 18)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(30, 41, 59)
  const pharmacyLabel = String(pharmacyName || 'Pharmacie')
    .trim()
    .toUpperCase()
  doc.text(pharmacyLabel, marginX, 25)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(15, 23, 42)
  doc.text(reportTitle, marginX, 36)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(71, 85, 105)
  doc.text(`Édité le ${formatEditionDate(now)}`, marginX, 42)
  doc.text(
    `${items.length} référence${items.length === 1 ? '' : 's'}`,
    pageWidth - marginX,
    42,
    { align: 'right' },
  )

  const tableBody = items.map((item) => [
    formatExpiryMonthYear(item.date_peremption),
    item.nom_zone || '—',
    item.nom_produit || '—',
    item.code_gtin || '—',
    '',
  ])

  autoTable(doc, {
    startY: 48,
    margin: { left: marginX, right: marginX },
    head: [
      [
        'Péremption',
        'Zone',
        'Désignation',
        'Code CIP/EAN',
        'Contrôle',
      ],
    ],
    body: tableBody.length
      ? tableBody
      : [['—', '—', 'Aucun produit pour cet horizon', '—', '']],
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: { top: 3, bottom: 3, left: 2, right: 2 },
      textColor: [30, 41, 59],
      lineColor: [203, 213, 225],
      lineWidth: 0.2,
      valign: 'middle',
    },
    headStyles: {
      fillColor: [15, 118, 110],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { cellWidth: 24, halign: 'center' },
      1: { cellWidth: 28 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 32, font: 'courier', fontSize: 7 },
      4: { cellWidth: 18, halign: 'center' },
    },
    didDrawCell(data) {
      if (data.section !== 'body' || data.column.index !== 4) return
      if (!tableBody.length) return
      const size = 4
      const x = data.cell.x + (data.cell.width - size) / 2
      const y = data.cell.y + (data.cell.height - size) / 2
      doc.setDrawColor(100, 116, 139)
      doc.setLineWidth(0.35)
      doc.rect(x, y, size, size)
    },
  })

  const pageCount = doc.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(148, 163, 184)
    doc.text(
      `Page ${page} / ${pageCount}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 8,
      { align: 'center' },
    )
  }

  const filename = `Expiry_Peremptions_${formatFileDate(now)}.pdf`
  doc.save(filename)
  return { filename, count: items.length }
}

/**
 * PDF de la liste filtrée issue de la recherche globale.
 * @param {{
 *   pharmacyName: string,
 *   items: Array<{
 *     nom_produit: string,
 *     laboratoire?: string | null,
 *     nom_zone: string | null,
 *     date_peremption: string,
 *     code_gtin?: string,
 *   }>,
 *   filtersSummary?: string,
 * }} options
 */
export function generateSearchPdf({
  pharmacyName,
  items,
  filtersSummary = '',
}) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const marginX = 14
  const now = new Date()

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(15, 118, 110)
  doc.text('EXPIRY', marginX, 18)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(30, 41, 59)
  const pharmacyLabel = String(pharmacyName || 'Pharmacie')
    .trim()
    .toUpperCase()
  doc.text(pharmacyLabel, marginX, 25)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(15, 23, 42)
  doc.text('Recherche — liste filtrée', marginX, 36)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(71, 85, 105)
  let metaY = 42
  doc.text(`Édité le ${formatEditionDate(now)}`, marginX, metaY)
  doc.text(
    `${items.length} référence${items.length === 1 ? '' : 's'}`,
    pageWidth - marginX,
    metaY,
    { align: 'right' },
  )

  if (filtersSummary) {
    metaY += 5
    doc.text(filtersSummary, marginX, metaY)
  }

  const tableBody = items.map((item) => [
    item.nom_produit || '—',
    item.laboratoire || '—',
    item.nom_zone || '—',
    formatExpiryMonthYear(item.date_peremption),
  ])

  autoTable(doc, {
    startY: metaY + 6,
    margin: { left: marginX, right: marginX },
    head: [['Nom', 'Laboratoire', 'Zone', 'Péremption']],
    body: tableBody.length
      ? tableBody
      : [['Aucun résultat pour ces filtres', '—', '—', '—']],
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: { top: 3, bottom: 3, left: 2, right: 2 },
      textColor: [30, 41, 59],
      lineColor: [203, 213, 225],
      lineWidth: 0.2,
      valign: 'middle',
    },
    headStyles: {
      fillColor: [15, 118, 110],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 42 },
      2: { cellWidth: 32 },
      3: { cellWidth: 24, halign: 'center' },
    },
  })

  const pageCount = doc.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(148, 163, 184)
    doc.text(
      `Page ${page} / ${pageCount}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 8,
      { align: 'center' },
    )
  }

  const filename = `Expiry_Recherche_${formatFileDate(now)}.pdf`
  doc.save(filename)
  return { filename, count: items.length }
}
