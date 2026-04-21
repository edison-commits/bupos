# Runbook: Migration 061 duplicate-data remediation

Migration 061 adds unique indexes on `(organization_id, slug)` for
products + categories, and on `(organization_id, return_number)` for
returns. R32-H12 reordered the migration to RAISE EXCEPTION when
pre-existing duplicates violate these constraints, forcing the
operator to resolve them offline.

## Identify duplicates

Before running 061, list the offending rows:

```sql
-- Duplicate product slugs within the same org
SELECT organization_id, slug, COUNT(*) AS n, array_agg(id) AS product_ids
  FROM products
  WHERE slug IS NOT NULL
  GROUP BY organization_id, slug
  HAVING COUNT(*) > 1
  ORDER BY n DESC;

-- Duplicate category slugs within the same org
SELECT organization_id, slug, COUNT(*) AS n, array_agg(id) AS category_ids
  FROM categories
  WHERE slug IS NOT NULL
  GROUP BY organization_id, slug
  HAVING COUNT(*) > 1
  ORDER BY n DESC;

-- Duplicate return numbers within the same org
SELECT organization_id, return_number, COUNT(*) AS n, array_agg(id) AS return_ids
  FROM returns
  GROUP BY organization_id, return_number
  HAVING COUNT(*) > 1
  ORDER BY n DESC;
```

## Remediate

### Product / category slug duplicates

For each duplicate group, keep the ORIGINAL row and suffix the
duplicates:

```sql
-- Example for one (org, slug) group. Replace values from the query above.
WITH dups AS (
  SELECT id, slug,
         ROW_NUMBER() OVER (PARTITION BY organization_id, slug ORDER BY created_at) AS rn
  FROM products
  WHERE organization_id = '<ORG>' AND slug = '<SLUG>'
)
UPDATE products p
  SET slug = p.slug || '-' || d.rn
  FROM dups d
  WHERE p.id = d.id AND d.rn > 1;
```

Same shape for `categories`.

### Return number duplicates

These are rarer — the RET-LOC-YYMMDD-NNN format generator (returns/
route.ts:336) retries on collision, so duplicates only appear if the
retry loop ever succeeded with a previously-committed but now-
orphaned row. Decide per case whether to delete the duplicate or
renumber:

```sql
-- Rename duplicates to RET-LOC-YYMMDD-NNN-dupN
WITH dups AS (
  SELECT id, return_number,
         ROW_NUMBER() OVER (PARTITION BY organization_id, return_number ORDER BY created_at) AS rn
  FROM returns
  WHERE organization_id = '<ORG>' AND return_number = '<RET-NUMBER>'
)
UPDATE returns r
  SET return_number = r.return_number || '-dup' || d.rn
  FROM dups d
  WHERE r.id = d.id AND d.rn > 1;
```

## Re-run the migration

Once the identify-queries return zero rows:

```bash
psql "$DATABASE_URL" -f supabase/migrations/061_r31_schema_hardening.sql -v ON_ERROR_STOP=1
```

The migration will succeed and the unique indexes will be created.
