import pool from '../src/lib/db/index';
import fs from 'fs';
import path from 'path';
async function run(){
  const client = await pool.connect();
  try {
    const migrationPath = path.resolve(__dirname, '../docs/schema/001_initial_foundations.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await client.query(sql);
    console.log('Migration applied');
  } finally { client.release(); }
}
run().catch(e=>{console.error(e); process.exit(1)});
