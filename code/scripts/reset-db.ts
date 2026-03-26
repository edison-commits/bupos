import pool from '../src/lib/db/index';
async function run(){
  const client = await pool.connect();
  try {
    console.log('Resetting database...');
    await client.query('DROP SCHEMA public CASCADE;');
    await client.query('CREATE SCHEMA public;');
    console.log('Reset complete.');
  } finally { client.release(); }
}
run().catch(e=>{console.error(e); process.exit(1)});
