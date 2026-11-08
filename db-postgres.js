require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5
});

pool.on('error', (err) => {
  console.error('Kesalahan koneksi Supabase:', err);
});

module.exports = pool;