export const REVIEW_KEYS = ['company', 'title', 'type', 'number', 'deadline', 'url'];

export function parseFlags(json) {
  try {
    const obj = JSON.parse(json || '{}');
    const out = {};
    for (const k of REVIEW_KEYS) if (obj && typeof obj[k] === 'string' && obj[k]) out[k] = obj[k];
    return out;
  } catch {
    return {};
  }
}

const PROGRESS_SQL = `
  SELECT tender_id,
         COUNT(*)                                                    AS total_items,
         SUM(required = 'yes')                                       AS required_total,
         SUM(required = 'yes' AND status = 'done')                   AS required_done,
         SUM(required = 'unclear')                                   AS unclear
  FROM checklist_items`;

function progressFrom(row) {
  return {
    required_total: Number(row?.required_total || 0),
    required_done: Number(row?.required_done || 0),
    unclear: Number(row?.unclear || 0),
    total_items: Number(row?.total_items || 0),
  };
}

function baseFields(row) {
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    type: row.type,
    number: row.number,
    deadline_date: row.deadline_date,
    deadline_time: row.deadline_time,
    deadline_tz: row.deadline_tz,
    deadline_raw: row.deadline_raw,
    url: row.url,
    url_status: row.url_status,
    url_note: row.url_note,
    review_flags: parseFlags(row.review_flags),
    is_draft: !!row.is_draft,
    needs_requirements: !!row.needs_requirements,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listTenders(db) {
  const rows = db.prepare('SELECT * FROM tenders ORDER BY id DESC').all();
  const progress = new Map(
    db
      .prepare(`${PROGRESS_SQL} GROUP BY tender_id`)
      .all()
      .map((r) => [r.tender_id, r]),
  );
  return rows.map((row) => ({ ...baseFields(row), progress: progressFrom(progress.get(row.id)) }));
}

export function findTender(db, id) {
  return db.prepare('SELECT * FROM tenders WHERE id = ?').get(id) || null;
}

export function serializeItem(row) {
  return {
    id: row.id,
    tender_id: row.tender_id,
    position: row.position,
    title: row.title,
    required: row.required,
    source_type: row.source_type,
    source_file_id: row.source_file_id,
    source_ordinal: row.source_ordinal ?? null,
    excerpt: row.excerpt,
    status: row.status,
    assignee: row.assignee,
    comment: row.comment,
  };
}

export function serializeTender(db, row) {
  const files = db
    .prepare('SELECT id, ordinal, filename, mime FROM tender_files WHERE tender_id = ? ORDER BY ordinal')
    .all(row.id)
    .map((f) => ({ ...f }));
  const items = db
    .prepare(
      `SELECT i.*, f.ordinal AS source_ordinal
       FROM checklist_items i LEFT JOIN tender_files f ON f.id = i.source_file_id
       WHERE i.tender_id = ? ORDER BY i.position, i.id`,
    )
    .all(row.id)
    .map(serializeItem);
  const progress = progressFrom(db.prepare(`${PROGRESS_SQL} WHERE tender_id = ?`).get(row.id));
  return { ...baseFields(row), files, items, progress };
}

export function touchTender(db, id) {
  db.prepare("UPDATE tenders SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
}
