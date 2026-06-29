'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function CustomerSignupQr({ url }: { url: string }) {
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 160, errorCorrectionLevel: 'M' })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/10 p-4 text-center backdrop-blur">
      <p className="mb-2 text-sm font-bold text-white">Save your sizes for next time</p>
      {qrDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- QR data URL generated client-side.
        <img src={qrDataUrl} alt="Customer signup QR code" className="mx-auto h-36 w-36 rounded-xl bg-white p-2" />
      ) : (
        <div className="mx-auto flex h-36 w-36 items-center justify-center rounded-xl bg-white/20 text-xs text-white">QR loading</div>
      )}
      <a href={url} className="mt-2 block break-all text-xs text-teal-100 underline">
        Open signup form
      </a>
    </div>
  );
}
