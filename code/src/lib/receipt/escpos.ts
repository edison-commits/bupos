/**
 * ESC/POS command builder for 80mm thermal receipt printers.
 * Generates a Uint8Array of commands that can be sent via Web Serial API or USB.
 */

const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

export class ESCPOSBuilder {
  private commands: number[] = [];
  private width = 48; // characters per line for 80mm paper

  /** Initialize printer */
  init(): this {
    this.commands.push(ESC, 0x40); // ESC @ - Initialize
    return this;
  }

  /** Set text alignment: left, center, right */
  align(mode: "left" | "center" | "right"): this {
    const n = mode === "left" ? 0 : mode === "center" ? 1 : 2;
    this.commands.push(ESC, 0x61, n);
    return this;
  }

  /** Bold on/off */
  bold(on: boolean): this {
    this.commands.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  /** Double height on/off */
  doubleHeight(on: boolean): this {
    this.commands.push(ESC, 0x21, on ? 0x10 : 0x00);
    return this;
  }

  /** Print text. Uses CP437 (ESC/POS default) for safe character handling.
   *  Non-ASCII characters are transliterated to ASCII approximations where
   *  possible (é→e, á→a, etc) and dropped otherwise — never truncated to
   *  arbitrary bytes which could inject ESC/POS control commands. */
  text(str: string): this {
    // Strip any ASCII control characters that could be interpreted as ESC/POS
    // commands (ESC=0x1B, GS=0x1D, DC=0x10-0x14, etc). Keep \t \n \r harmless.
    const sanitized = str.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "");
    // Transliterate non-ASCII to ASCII (handles accents, smart quotes, em-dash)
    const ascii = sanitized
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // strip combining marks (é→e)
      .replace(/[\u2018\u2019]/g, "'")    // curly single quotes → '
      .replace(/[\u201C\u201D]/g, '"')    // curly double quotes → "
      .replace(/[\u2013\u2014]/g, "-")    // en/em dash → -
      .replace(/\u2026/g, "...")           // ellipsis
      .replace(/[^\x20-\x7E]/g, "?");     // anything still non-ASCII → ?
    for (let i = 0; i < ascii.length; i++) {
      this.commands.push(ascii.charCodeAt(i));
    }
    return this;
  }

  /** Print text + line feed */
  line(str: string): this {
    return this.text(str).feed();
  }

  /** Line feed */
  feed(lines = 1): this {
    for (let i = 0; i < lines; i++) this.commands.push(LF);
    return this;
  }

  /** Print a line of dashes */
  separator(char = "-"): this {
    return this.line(char.repeat(this.width));
  }

  /** Print a double-line separator */
  doubleSeparator(): this {
    return this.separator("=");
  }

  /** Print two columns: left-aligned text and right-aligned text */
  columns(left: string, right: string): this {
    const gap = this.width - left.length - right.length;
    if (gap < 1) {
      // Guard against negative slice: if right is too wide, truncate right first.
      const maxRight = Math.max(1, this.width - 2);
      const safeRight = right.length > maxRight ? right.slice(0, maxRight) : right;
      const leftMax = Math.max(0, this.width - safeRight.length - 1);
      return this.line(left.slice(0, leftMax) + " " + safeRight);
    }
    return this.line(left + " ".repeat(gap) + right);
  }

  /** Cut paper (partial cut) */
  cut(): this {
    this.feed(3);
    this.commands.push(GS, 0x56, 0x41, 0x03); // GS V A 3
    return this;
  }

  /** Open cash drawer (pin 2) */
  openDrawer(): this {
    this.commands.push(ESC, 0x70, 0x00, 0x19, 0x78); // ESC p 0 25 120
    return this;
  }

  /** Get the built command buffer */
  build(): Uint8Array {
    return new Uint8Array(this.commands);
  }
}
