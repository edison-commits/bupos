/**
 * useBarcodeScanner Hook
 *
 * Integrates a USB barcode scanner into your POS terminal component.
 *
 * INTEGRATION GUIDE for pos-terminal.tsx:
 *
 * 1. Import the hook:
 *    import { useBarcodeScanner } from '@/hooks/use-barcode-scanner'
 *
 * 2. Call it with an onScan handler. The handler should:
 *    - Fetch the product via: fetch(`/api/barcode-lookup?code=${barcode}`)
 *    - Parse the response to extract product and variant details
 *    - Call the existing addItem(product, variant, quantity) function to add to cart
 *    - Handle 404 errors (product not found) with a toast notification
 *
 * 3. Control when the scanner is active:
 *    - Pass enabled={!isModalOpen && !isOverlayOpen} to disable during modals
 *    - This prevents barcode scans from interfering with form inputs
 *
 * Example usage:
 *    useBarcodeScanner({
 *      enabled: !isCheckoutOpen,
 *      onScan: async (barcode) => {
 *        const res = await fetch(`/api/barcode-lookup?code=${barcode}`)
 *        if (!res.ok) {
 *          toast.error('Product not found')
 *          return
 *        }
 *        const { product, variant } = await res.json()
 *        addItem(product, variant, 1)
 *      }
 *    })
 */

import { useEffect, useRef } from 'react'

interface BarcodeScannerOptions {
  onScan: (barcode: string) => void | Promise<void>
  enabled?: boolean
}

export function useBarcodeScanner({
  onScan,
  enabled = true,
}: BarcodeScannerOptions) {
  const bufferRef = useRef<string>('')
  const lastKeystrokeRef = useRef<number>(0)
  const bufferStartTimeRef = useRef<number>(0)

  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const now = Date.now()
      const timeSinceLastKeystroke = now - lastKeystrokeRef.current
      const timeSinceScanStart = now - bufferStartTimeRef.current

      // Initialize scan start time on first keystroke
      if (bufferRef.current === '') {
        bufferStartTimeRef.current = now
      }

      // Reset buffer if more than 300ms has passed since scan started
      if (bufferRef.current !== '' && timeSinceScanStart > 300) {
        bufferRef.current = ''
        bufferStartTimeRef.current = now
      }

      // Handle Enter key - potential end of barcode
      if (event.key === 'Enter') {
        event.preventDefault()

        // Valid barcode: 4+ characters accumulated within 300ms
        if (bufferRef.current.length >= 4) {
          const barcode = bufferRef.current
          bufferRef.current = ''
          onScan(barcode)
        }
        return
      }

      // Accumulate characters that arrive within 50ms of each other
      // and are printable (single character, not special keys)
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        timeSinceLastKeystroke < 50
      ) {
        event.preventDefault()
        bufferRef.current += event.key
      }

      lastKeystrokeRef.current = now
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [enabled, onScan])
}
