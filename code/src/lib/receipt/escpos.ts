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

  /** Print text */
  text(str: string): this {
    for (let i = 0; i < str.length; i++) {
      this.commands.push(str.charCodeAt(i) & 0xFF);
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
      return this.line(left.slice(0, this.width - right.length - 1) + " " + right);
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
