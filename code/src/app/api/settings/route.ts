import { NextRequest, NextResponse } from 'next/server';
import { orgQuery } from '@/lib/db';
import { requireAdminPermission } from '@/lib/authz';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';

const ORG_ID = process.env.BUPOS_ORG_ID || '33262270-7100-4b46-b2fb-8b50ad872bbb';
const LOCATION_ID = process.env.BUPOS_LOCATION_ID || 'c57268b3-cb14-4c1a-bda6-55e49ddc6313';

export async function GET() {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [orgResult, locationResult] = await Promise.all([
      orgQuery(
        ORG_ID,
        `SELECT id, name, legal_name, slug, phone, email, website, timezone, currency_code,
                receipt_header, receipt_footer,
                receipt_store_name, receipt_store_address, receipt_store_city,
                receipt_store_region, receipt_store_postal_code, receipt_store_phone
         FROM organizations WHERE id = $1`,
        [ORG_ID]
      ),
      orgQuery(
        ORG_ID,
        `SELECT id, name, code, address1, city, region, postal_code, phone, tax_rate, is_active
         FROM locations WHERE id = $1 AND organization_id = $2`,
        [LOCATION_ID, ORG_ID]
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
}

export async function PUT(request: NextRequest) {
  await requireAdminPermission('catalog.manage');
  try {
    const { section, data } = await request.json();

    if (!section || !data) {
      return NextResponse.json({ error: 'Missing section or data' }, { status: 400 });
    }

    switch (section) {
      case 'store':
        await orgQuery(
          ORG_ID,
          `UPDATE organizations
           SET name = $1, legal_name = $2, phone = $3, email = $4, website = $5,
               timezone = $6, currency_code = $7, updated_at = NOW()
           WHERE id = $8`,
          [data.name, data.legalName, data.phone, data.email, data.website,
           data.timezone, data.currencyCode, ORG_ID]
        );
        return NextResponse.json({ success: true });

      case 'location':
        await orgQuery(
          ORG_ID,
          `UPDATE locations
           SET name = $1, code = $2, address1 = $3, city = $4, region = $5,
               postal_code = $6, phone = $7, tax_rate = $8, updated_at = NOW()
           WHERE id = $9 AND organization_id = $10`,
          [data.name, data.code, data.address1, data.city, data.region,
           data.postalCode, data.phone, data.taxRate, LOCATION_ID, ORG_ID]
        );
        // Return full settings after update so client state stays valid
        const [updatedOrg, updatedLocation] = await Promise.all([
          orgQuery(
            ORG_ID,
            `SELECT id, name, legal_name, slug, phone, email, website, timezone, currency_code,
                    receipt_header, receipt_footer,
                    receipt_store_name, receipt_store_address, receipt_store_city,
                    receipt_store_region, receipt_store_postal_code, receipt_store_phone
             FROM organizations WHERE id = $1`,
            [ORG_ID]
          ),
          orgQuery(
            ORG_ID,
            `SELECT id, name, code, address1, city, region, postal_code, phone, tax_rate, is_active
             FROM locations WHERE id = $1 AND organization_id = $2`,
            [LOCATION_ID, ORG_ID]
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
          ORG_ID,
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
            ORG_ID,
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
}
