import { NextRequest, NextResponse } from 'next/server';
import { orgQuery } from '@/lib/db';
import { withDualAuth, withAdminAuth } from '@/lib/api/with-auth';
import { validateBody, settingsUpdateSchema } from '@/lib/validation/schemas';

export const GET = withDualAuth("catalog.manage", async (req, ctx) => {
  const { orgId, locationId } = ctx;
  if (!locationId) {
    return NextResponse.json({ error: 'No location context' }, { status: 400 });
  }

  try {
    const [orgResult, locationResult] = await Promise.all([
      orgQuery(
        orgId,
        `SELECT id, name, legal_name, slug, phone, email, website, timezone, currency_code,
                receipt_header, receipt_footer,
                receipt_store_name, receipt_store_address, receipt_store_city,
                receipt_store_region, receipt_store_postal_code, receipt_store_phone
         FROM organizations WHERE id = $1`,
        [orgId]
      ),
      orgQuery(
        orgId,
        `SELECT id, name, code, address1, city, region, postal_code, phone, tax_rate, is_active
         FROM locations WHERE id = $1 AND organization_id = $2`,
        [locationId, orgId]
      ),
    ]);

    const org = orgResult.rows[0];
    if (!org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }

    const location = locationResult.rows[0];
    if (!location) {
      return NextResponse.json({ error: 'Location not found' }, { status: 404 });
    }

    return NextResponse.json({
      store: {
        name: org.name,
        legalName: org.legal_name,
        phone: org.phone,
        email: org.email,
        website: org.website,
        timezone: org.timezone,
        currencyCode: org.currency_code,
      },
      location: {
        name: location.name,
        code: location.code,
        address1: location.address1,
        city: location.city,
        region: location.region,
        postalCode: location.postal_code,
        phone: location.phone,
        taxRate: Number(location.tax_rate),
        isActive: location.is_active,
      },
      receipt: {
        header: org.receipt_header || '',
        footer: org.receipt_footer || '',
        storeName: org.receipt_store_name || '',
        storeAddress: org.receipt_store_address || '',
        storeCity: org.receipt_store_city || '',
        storeRegion: org.receipt_store_region || '',
        storePostalCode: org.receipt_store_postal_code || '',
        storePhone: org.receipt_store_phone || '',
      },
    });
  } catch (error) {
    console.error('Settings GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
});

export const PUT = withAdminAuth('catalog.manage', async (request, ctx) => {
  const { orgId } = ctx;
  const locationId = ctx.employee.locationIds?.[0];
  try {
    const raw = await request.json();
    const v = validateBody(settingsUpdateSchema, raw);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { section, data } = v.data;

    switch (section) {
      case 'store':
        await orgQuery(
          orgId,
          `UPDATE organizations
           SET name = $1, legal_name = $2, phone = $3, email = $4, website = $5,
               timezone = $6, currency_code = $7, updated_at = NOW()
           WHERE id = $8`,
          [data.name, data.legalName, data.phone, data.email, data.website,
           data.timezone, data.currencyCode, orgId]
        );
        return NextResponse.json({ success: true });

      case 'location':
        await orgQuery(
          orgId,
          `UPDATE locations
           SET name = $1, code = $2, address1 = $3, city = $4, region = $5,
               postal_code = $6, phone = $7, tax_rate = $8, updated_at = NOW()
           WHERE id = $9 AND organization_id = $10`,
          [data.name, data.code, data.address1, data.city, data.region,
           data.postalCode, data.phone, data.taxRate, locationId, orgId]
        );
        // Return full settings after update so client state stays valid
        const [updatedOrg, updatedLocation] = await Promise.all([
          orgQuery(
            orgId,
            `SELECT id, name, legal_name, slug, phone, email, website, timezone, currency_code,
                    receipt_header, receipt_footer,
                    receipt_store_name, receipt_store_address, receipt_store_city,
                    receipt_store_region, receipt_store_postal_code, receipt_store_phone
             FROM organizations WHERE id = $1`,
            [orgId]
          ),
          orgQuery(
            orgId,
            `SELECT id, name, code, address1, city, region, postal_code, phone, tax_rate, is_active
             FROM locations WHERE id = $1 AND organization_id = $2`,
            [locationId, orgId]
          ),
        ]);
        const org = updatedOrg.rows[0];
        const loc = updatedLocation.rows[0];
        return NextResponse.json({
          store: {
            name: org.name, legalName: org.legal_name, phone: org.phone,
            email: org.email, website: org.website, timezone: org.timezone,
            currencyCode: org.currency_code,
          },
          location: {
            name: loc.name, code: loc.code, address1: loc.address1,
            city: loc.city, region: loc.region, postalCode: loc.postal_code,
            phone: loc.phone, taxRate: Number(loc.tax_rate), isActive: loc.is_active,
          },
          receipt: {
            header: org.receipt_header || '', footer: org.receipt_footer || '',
            storeName: org.receipt_store_name || '', storeAddress: org.receipt_store_address || '',
            storeCity: org.receipt_store_city || '', storeRegion: org.receipt_store_region || '',
            storePostalCode: org.receipt_store_postal_code || '', storePhone: org.receipt_store_phone || '',
          },
        });

      case 'receipt':
        await orgQuery(
          orgId,
          `UPDATE organizations
           SET receipt_header = $1, receipt_footer = $2,
               receipt_store_name = $3, receipt_store_address = $4,
               receipt_store_city = $5, receipt_store_region = $6,
               receipt_store_postal_code = $7, receipt_store_phone = $8,
               updated_at = NOW()
           WHERE id = $9`,
          [
            data.header, data.footer,
            data.storeName ?? '', data.storeAddress ?? '',
            data.storeCity ?? '', data.storeRegion ?? '',
            data.storePostalCode ?? '', data.storePhone ?? '',
            orgId,
          ]
        );
        return NextResponse.json({ success: true });

      default:
        return NextResponse.json({ error: 'Unknown section' }, { status: 400 });
    }
  } catch (error) {
    console.error('Settings PUT error:', error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
});
