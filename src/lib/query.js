function pageNumber(value) {
  const page = Number(value || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function pageLimit(value, fallback = 15) {
  const limit = Number(value || fallback);
  if (!Number.isInteger(limit) || limit < 1) return fallback;
  return Math.min(limit, 25);
}

function paginationMeta(req, total, fallbackLimit = 15) {
  const page = pageNumber(req.query.page);
  const limit = pageLimit(req.query.limit, fallbackLimit);
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    offset: (page - 1) * limit,
  };
}

function appendWhere(where, values, clause, value) {
  if (value === undefined || value === null || value === '') return;
  where.push(clause);
  values.push(value);
}

module.exports = {
  paginationMeta,
  appendWhere,
};
