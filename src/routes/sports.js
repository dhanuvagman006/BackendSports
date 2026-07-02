const express = require('express');
const db = require('../config/db');
const { ok, asyncH } = require('../utils/http');

const router = express.Router();

// GET /sports — powers the select-sport screens for both roles
router.get('/', asyncH(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT id, slug, name, emoji, icon_url AS "iconUrl"
     FROM sports WHERE is_active ORDER BY sort_order, name`,
  );
  ok(res, rows);
}));

module.exports = router;
